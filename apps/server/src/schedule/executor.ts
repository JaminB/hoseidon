import { isRateLimitError, type LinkTapClient } from '../linktap/client';
import { MAX_RUN_SEC } from '@hoseidon/shared';

export interface ExecDevice {
  id: string;
  gatewayId: string;
}

/**
 * What a start check found:
 * - `watering`: the device (or other evidence) says the run is under way, or already ran.
 * - `idle`: every check came back "not watering" and nothing else suggests it started.
 * - `unknown`: a check could not be made (rate limit, API error), so we can't tell.
 */
export type StartCheck = 'watering' | 'idle' | 'unknown';

/**
 * How the engine turns water on and off. CloudExecutor goes through the LinkTap cloud API; a
 * LocalGatewayExecutor (HTTP/MQTT on the LAN) can replace it later without touching the engine.
 */
export interface Executor {
  readonly kind: 'cloud' | 'local';
  /** Round a duration to what the device can actually do. */
  quantize(device: ExecDevice | null, seconds: number): number;
  start(device: ExecDevice, seconds: number): Promise<void>;
  stop(device: ExecDevice): Promise<void>;
  /** One immediate check: true if the device reports it is watering now. */
  verify(device: ExecDevice): Promise<boolean>;
  /**
   * Did the start sent at `sentAt` take? Waits as long as it needs to (LinkTap can take a while
   * to report a new run). Never sends a command.
   */
  confirmStart(device: ExecDevice, sentAt: Date): Promise<StartCheck>;
}

export interface CloudExecutorOptions {
  client: LinkTapClient;
  /** Devices that take seconds (S models). Others run whole minutes. */
  supportsSeconds?: (device: ExecDevice) => boolean;
  /**
   * Wait between the start command and the first status check. Default 20 s: live, an outlet
   * reported `null` 12 s after an accepted start and still ran.
   */
  verifyDelayMs?: number;
  /**
   * Wait before the second check when the first found nothing. Default 30 s (getWateringStatus
   * allows one call per 30 s for the account; the client's limiter enforces that as well).
   */
  recheckDelayMs?: number;
  /** Cheap evidence already on hand (the DB: getAllDevices snapshots, webhooks, history). */
  evidence?: (device: ExecDevice, since: Date) => boolean;
  /** Time zone for reading a device's history; without it the history check is skipped. */
  historyTimeZone?: (device: ExecDevice) => string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class CloudExecutor implements Executor {
  readonly kind = 'cloud';
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly opts: CloudExecutorOptions) {
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? Date.now;
  }

  quantize(device: ExecDevice | null, seconds: number): number {
    const s =
      device && this.opts.supportsSeconds?.(device)
        ? Math.round(seconds)
        : Math.round(seconds / 60) * 60;
    return Math.min(MAX_RUN_SEC, Math.max(60, s));
  }

  start(device: ExecDevice, seconds: number): Promise<void> {
    return this.opts.client.startWatering({
      gatewayId: device.gatewayId,
      taplinkerId: device.id,
      seconds: this.quantize(device, seconds),
    });
  }

  stop(device: ExecDevice): Promise<void> {
    return this.opts.client.stopWatering({ gatewayId: device.gatewayId, taplinkerId: device.id });
  }

  async verify(device: ExecDevice): Promise<boolean> {
    // getWateringStatus says null both for "not watering" and for bad credentials; either way the
    // start didn't take as far as we can tell. Priority: background polls must not starve it.
    const status = await this.opts.client.getWateringStatus(
      { gatewayId: device.gatewayId, taplinkerId: device.id },
      { priority: true },
    );
    return status !== null;
  }

  async confirmStart(device: ExecDevice, sentAt: Date): Promise<StartCheck> {
    const check = async (): Promise<StartCheck> => {
      try {
        return (await this.verify(device)) ? 'watering' : 'idle';
      } catch {
        // Rate limited or an API hiccup: no information either way.
        return 'unknown';
      }
    };
    await this.sleep(this.opts.verifyDelayMs ?? 20_000);
    const first = await check();
    if (first === 'watering') return first;
    // One early null proves nothing (start latency): look again.
    await this.sleep(this.opts.recheckDelayMs ?? 30_000);
    const second = await check();
    if (second === 'watering') return second;
    if (await this.corroborate(device, sentAt)) return 'watering';
    return first === 'idle' && second === 'idle' ? 'idle' : 'unknown';
  }

  /**
   * Evidence the run happened that costs no waiting: what the DB already knows (getAllDevices
   * `watering`, webhooks), and the device's history when its 10-minute slot is open now (a
   * finished run is listed about a second after it ends).
   */
  private async corroborate(device: ExecDevice, sentAt: Date): Promise<boolean> {
    if (this.opts.evidence?.(device, sentAt)) return true;
    const tz = this.opts.historyTimeZone?.(device);
    const { client } = this.opts;
    if (!tz || client.nextAvailableAt('history', device.id).getTime() > this.now()) return false;
    try {
      const history = await client.getWateringHistory(
        { gatewayId: device.gatewayId, taplinkerId: device.id },
        tz,
      );
      // Small slack for clock skew between us and LinkTap.
      return history.some((e) => e.endedAt.getTime() >= sentAt.getTime() - 2_000);
    } catch {
      return false;
    }
  }
}

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not implemented yet`);
    this.name = 'NotImplementedError';
  }
}

/** Placeholder for driving the gateway directly on the LAN (HTTP api.shtml / MQTT). */
export class LocalGatewayExecutor implements Executor {
  readonly kind = 'local';
  quantize(_device: ExecDevice | null, seconds: number): number {
    return Math.min(MAX_RUN_SEC, Math.max(60, Math.round(seconds)));
  }
  start(): Promise<void> {
    return Promise.reject(new NotImplementedError('LocalGatewayExecutor.start'));
  }
  stop(): Promise<void> {
    return Promise.reject(new NotImplementedError('LocalGatewayExecutor.stop'));
  }
  verify(): Promise<boolean> {
    return Promise.reject(new NotImplementedError('LocalGatewayExecutor.verify'));
  }
  confirmStart(): Promise<StartCheck> {
    return Promise.reject(new NotImplementedError('LocalGatewayExecutor.confirmStart'));
  }
}

export class StartVerifyError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
  ) {
    super(message);
    this.name = 'StartVerifyError';
  }
}

/** The user pressed Stop while a start was still being verified. */
export class StartAbortedError extends Error {
  constructor() {
    super('stopped before it started');
    this.name = 'StartAbortedError';
  }
}

export interface StartResult {
  /** Start commands LinkTap accepted. */
  attempts: number;
  /** False: the start was accepted but could not be confirmed (and was not re-sent). */
  verified: boolean;
  /** When the accepted start command was sent (best estimate of the run's start). */
  startedAt: Date;
  /** Why it is unverified, for the event/alert. */
  note?: string;
}

export interface StartVerifiedOptions {
  onAttempt?: (attempt: number) => void;
  /** Checked before every start and after every check (Stop pressed meanwhile). */
  shouldAbort?: () => boolean;
  /** Re-sends of a start LinkTap rate-limited (it did not run, so this is safe). Default 2. */
  rateLimitRetries?: number;
  /** Wait before re-sending a rate-limited start. Default 16 s (the command limit is 15 s). */
  rateLimitBackoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Don't re-send a start once this share of the planned run has gone by: the first one may have
 * run after all, and a second would water on top of it.
 */
export const RETRY_WINDOW_SHARE = 0.5;

/**
 * Start, then check the device really is watering. A start LinkTap rejected is an error; one it
 * accepted but we can't confirm is the dangerous case, because re-sending it can double-water.
 * - A rate-limited start (not carried out) is re-sent after a back-off.
 * - The check waits out start latency and looks twice (Executor.confirmStart).
 * - Only when every check says "not watering" (`idle`), and less than half the planned window
 *   has passed, is the start re-sent, once.
 * - Anything inconclusive returns `verified: false` with no retry, for the caller to flag.
 * - Two accepted starts that both check `idle` throw StartVerifyError.
 * `shouldAbort` is checked before every start and after every check, so a Stop pressed in the
 * verify window never gets a retry start behind it (throws StartAbortedError).
 */
export async function startVerified(
  executor: Executor,
  device: ExecDevice,
  seconds: number,
  opts: StartVerifiedOptions = {},
): Promise<StartResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const abort = () => {
    if (opts.shouldAbort?.()) throw new StartAbortedError();
  };
  const plannedMs = executor.quantize(device, seconds) * 1000;
  let firstSentAt: number | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    abort();
    opts.onAttempt?.(attempt);
    let sentAt = new Date(now());
    for (let tries = 0; ; tries++) {
      try {
        await executor.start(device, seconds);
        break;
      } catch (err) {
        if (!isRateLimitError(err) || tries >= (opts.rateLimitRetries ?? 2)) throw err;
        await sleep(opts.rateLimitBackoffMs ?? 16_000);
        abort();
        sentAt = new Date(now());
      }
    }
    firstSentAt ??= sentAt.getTime();

    const result = await executor.confirmStart(device, sentAt);
    if (result === 'watering') return { attempts: attempt, verified: true, startedAt: sentAt };
    abort();
    if (result === 'unknown') {
      return {
        attempts: attempt,
        verified: false,
        startedAt: sentAt,
        note: 'LinkTap accepted the start, but its status could not be checked',
      };
    }
    if (attempt === 2) break;
    if (now() - firstSentAt >= plannedMs * RETRY_WINDOW_SHARE) {
      return {
        attempts: attempt,
        verified: false,
        startedAt: sentAt,
        note: 'LinkTap accepted the start but never reported it running; too late to re-send',
      };
    }
  }
  throw new StartVerifyError('device did not report watering after 2 start attempts', 2);
}
