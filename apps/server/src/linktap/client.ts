import type { z } from 'zod';
import type { DismissableAlarm, Watering } from '@hoseidon/shared';
import {
  errorSchema,
  getAllDevicesSchema,
  getWateringHistorySchema,
  getWateringStatusSchema,
  okSchema,
} from './schemas';
import {
  gatewayIdOf,
  normalizeGateway,
  normalizeHistory,
  normalizeWatering,
  splitDuration,
  type HistoryEntry,
  type NormalizedGateway,
} from './normalize';
import { RateLimiter, type BucketSpec, type LastCallStore } from './rate-limit';
import { CallStats, type ApiStats } from './stats';

export const LINKTAP_BASE_URL = 'https://www.link-tap.com/api/';

/** Sends one API call and returns the parsed JSON body. Real = fetch, mock = in-process. */
export type Transport = (endpoint: string, body: Record<string, unknown>) => Promise<unknown>;

export type Bucket = 'devices' | 'status' | 'history' | 'command';

/**
 * LinkTap's documented minimum intervals. The docs don't say whether limits are per account or
 * per device, so we are conservative: everything is account-wide except getWateringStatus, which
 * is per taplinker (it's what we poll while a run is live).
 */
export const LINKTAP_LIMITS: Record<Bucket, BucketSpec> = {
  devices: { intervalMs: 5 * 60_000 },
  status: { intervalMs: 15_000 },
  history: { intervalMs: 10 * 60_000 },
  command: { intervalMs: 15_000 },
};

export class LinkTapError extends Error {
  constructor(
    readonly endpoint: string,
    message: string,
    readonly kind: 'api' | 'http' | 'invalid' = 'api',
  ) {
    super(`LinkTap ${endpoint}: ${message}`);
    this.name = 'LinkTapError';
  }
}

export interface DeviceRef {
  gatewayId: string;
  taplinkerId: string;
}

export interface StartOptions extends DeviceRef {
  seconds: number;
  /** Cycle-and-soak: water `ecoOnMin`, rest `ecoOffMin`, repeat. */
  eco?: { onMin: number; offMin: number };
  /** Return to the previous plan mode after the run. Default true. */
  autoBack?: boolean;
}

export interface LinkTapClient {
  getAllDevices(): Promise<NormalizedGateway[]>;
  getWateringStatus(ref: DeviceRef): Promise<Watering | null>;
  getWateringHistory(ref: DeviceRef, timeZone: string): Promise<HistoryEntry[]>;
  startWatering(opts: StartOptions): Promise<void>;
  stopWatering(ref: DeviceRef): Promise<void>;
  /** Pause the active LinkTap plan for `hours` (0.1..240, or -1 = until re-activated). */
  pauseWateringPlan(ref: DeviceRef, hours: number): Promise<void>;
  dismissAlarm(ref: DeviceRef, alarm: DismissableAlarm): Promise<void>;
  nextAvailableAt(bucket: Bucket, scope?: string): Date;
  /** Per-endpoint call health since the client was created. */
  stats(): ApiStats;
  /** Register the account-wide webhook URL (one per account). Counts as a command. */
  setWebHookUrl(url: string): Promise<void>;
}

export function httpTransport(baseUrl = LINKTAP_BASE_URL, fetchImpl = fetch): Transport {
  return async (endpoint, body) => {
    const res = await fetchImpl(new URL(endpoint, baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new LinkTapError(endpoint, `HTTP ${res.status}`, 'http');
    return res.json();
  };
}

export interface ClientOptions {
  username: string;
  apiKey: string;
  transport: Transport;
  limits?: Partial<Record<Bucket, BucketSpec>>;
  now?: () => number;
  /** Persists last-call times so a restart doesn't forget the rate limits. */
  store?: LastCallStore;
}

export function createLinkTapClient(opts: ClientOptions): LinkTapClient {
  const now = opts.now ?? Date.now;
  const limiter = new RateLimiter<Bucket>({ ...LINKTAP_LIMITS, ...opts.limits }, now, opts.store);
  const stats = new CallStats(now);

  /** limiter.schedule, plus how long the call waited in the queue (for the Network page). */
  const limited = <T>(
    bucket: Bucket,
    endpoint: string,
    fn: () => Promise<T>,
    o?: { scope?: string; coalesceKey?: string },
  ) => {
    const queuedAt = now();
    return limiter.schedule(
      bucket,
      () => {
        stats.wait(endpoint, now() - queuedAt);
        return fn();
      },
      o,
    );
  };

  async function call<S extends z.ZodType>(
    endpoint: string,
    params: Record<string, unknown>,
    schema: S,
  ): Promise<z.infer<S>> {
    try {
      const json = await opts.transport(endpoint, {
        username: opts.username,
        apiKey: opts.apiKey,
        ...params,
      });
      const err = errorSchema.safeParse(json);
      if (err.success) throw new LinkTapError(endpoint, err.data.message ?? 'unknown error');
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        throw new LinkTapError(endpoint, `unexpected response: ${parsed.error.message}`, 'invalid');
      }
      stats.record(endpoint);
      return parsed.data;
    } catch (e) {
      stats.record(endpoint, e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  /** IDs as LinkTap wants them: gateway always 16 chars, taplinker keeps its "_N" outlet suffix. */
  const ids = (ref: DeviceRef) => ({
    gatewayId: gatewayIdOf(ref.gatewayId),
    taplinkerId: ref.taplinkerId.trim(),
  });

  const command = (endpoint: string, params: Record<string, unknown>) =>
    limited('command', endpoint, async () => {
      await call(endpoint, params, okSchema);
    });

  return {
    getAllDevices: () =>
      limited(
        'devices',
        'getAllDevices',
        async () => {
          const res = await call('getAllDevices', {}, getAllDevicesSchema);
          return (res.devices ?? []).map(normalizeGateway);
        },
        { coalesceKey: 'all' },
      ),

    getWateringStatus: (ref) => {
      const id = ref.taplinkerId.trim();
      return limited(
        'status',
        'getWateringStatus',
        async () => {
          const res = await call('getWateringStatus', ids(ref), getWateringStatusSchema);
          return normalizeWatering(res.status);
        },
        { scope: id, coalesceKey: id },
      );
    },

    getWateringHistory: (ref, timeZone) =>
      limited(
        'history',
        'getWateringHistory',
        async () => {
          const res = await call('getWateringHistory', ids(ref), getWateringHistorySchema);
          return normalizeHistory(res.status ?? res.history ?? res.data ?? [], timeZone);
        },
        // Normalization depends on the time zone, so it is part of the key.
        { coalesceKey: `${ref.taplinkerId.trim()}|${timeZone}` },
      ),

    startWatering: ({ seconds, eco, autoBack = true, ...ref }) => {
      const { duration, durationSec } = splitDuration(seconds);
      if (duration < 1 || duration > 1439) {
        return Promise.reject(
          new LinkTapError('activateInstantMode', 'duration must be 1..1439 minutes', 'invalid'),
        );
      }
      return command('activateInstantMode', {
        ...ids(ref),
        action: true,
        duration,
        durationSec,
        eco: Boolean(eco),
        ...(eco ? { ecoOn: eco.onMin, ecoOff: eco.offMin } : {}),
        autoBack,
      });
    },

    stopWatering: (ref) =>
      command('activateInstantMode', {
        ...ids(ref),
        action: false,
        duration: 0,
        durationSec: 0,
        eco: false,
        autoBack: true,
      }),

    pauseWateringPlan: (ref, hours) => {
      if (hours !== -1 && !(hours >= 0.1 && hours <= 240)) {
        return Promise.reject(
          new LinkTapError('pauseWateringPlan', 'hours must be 0.1..240 or -1', 'invalid'),
        );
      }
      return command('pauseWateringPlan', { ...ids(ref), pauseDuration: hours });
    },

    dismissAlarm: (ref, alarm) => command('dismissAlarm', { ...ids(ref), alarm }),

    setWebHookUrl: (url) => command('setWebHookUrl', { webHookUrl: url }),

    nextAvailableAt: (bucket, scope) => limiter.nextAvailableAt(bucket, scope),

    stats: () => stats.snapshot(),
  };
}
