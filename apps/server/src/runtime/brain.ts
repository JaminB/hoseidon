import type { Hono } from 'hono';
import { createApp } from '../app';
import { engineEnabled, insecureConfig, loadConfig, type Config } from '../config';
import type { Db } from '../db/types';
import { getSetting, setSetting, settingsLastCallStore } from '../db/kv';
import { gateways } from '../db/schema';
import { isValidTimeZone } from '@hoseidon/shared';
import { TIME_ZONE_KEY } from '../api/settings';
import { AuthService } from '../auth/service';
import { GcalService } from '../gcal/service';
import type { LinkTapClient } from '../linktap/client';
import { noLinkTap } from '../linktap/unavailable';
import { PushService } from '../push/service';
import { createServices, type Services } from '../services';
import { Wheel } from './wheel';

/**
 * Hoseidon as one Durable Object, minus the Cloudflare glue (apps/worker wraps this in the real
 * `DurableObject` class). Runtime-agnostic on purpose: it takes a sync Drizzle DB and an alarm
 * port, so the Node test suite can run it on better-sqlite3 and "evict" it by building a new one
 * over the same database.
 */

/** The Durable Object alarm (ctx.storage.getAlarm/setAlarm). */
export interface AlarmPort {
  get(): Promise<number | null>;
  set(at: number): Promise<void>;
}

export interface BrainOptions {
  db: Db;
  /** Worker env: vars and secrets (non-string bindings are ignored). */
  env: Record<string, unknown>;
  alarm: AlarmPort;
  log?: (msg: string) => void;
  now?: () => number;
  /** Tests: replace the LinkTap client (mock with no limits, spies). */
  linktap?: LinkTapClient;
  /** Tests: fetch for Google sign-in (token + JWKS endpoints). */
  authFetch?: typeof fetch;
}

/** Where a PUBLIC_URL derived from the first request is remembered. */
export const PUBLIC_URL_KEY = 'app.publicUrl';
/** On Workers the password hash is fast PBKDF2, so the password must be long and random. */
export const WORKER_MIN_ADMIN_PASSWORD = 20;
/** Never leave the alarm further out than this; the cron watchdog backs it up. */
export const MAX_ALARM_GAP_MS = 10 * 60_000;
/** An alarm this overdue is treated as dead by ensureAlarm. */
export const OVERDUE_MS = 2 * 60_000;

/** Biggest body the API takes (schedules and WebAuthn payloads are a few KB). */
export const MAX_API_BODY = 256 * 1024;
/** LinkTap webhooks are tiny JSON objects. */
export const MAX_HOOK_BODY = 16 * 1024;

/**
 * Buffer the body, counting bytes as they arrive, and give up past `max`. Content-Length can be
 * missing (chunked) or wrong, so it is never trusted on its own: a big body can't make the object
 * buffer more than `max` (Workers have 128 MB).
 */
export async function limitBody(request: Request, max: number): Promise<Request | Response> {
  if (!request.body) return request;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return Response.json({ error: 'payload too large' }, { status: 413 });
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    body.set(c, at);
    at += c.byteLength;
  }
  return new Request(request.url, { method: request.method, headers: request.headers, body });
}

export function stringEnv(env: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string' && v !== '') out[k] = v;
  return out;
}

export class BrainCore {
  readonly db: Db;
  readonly services: Services;
  readonly wheel: Wheel;
  readonly engineOn: boolean;
  /** Reasons the live (non-mock) deployment refuses to run; empty when fine. */
  readonly problems: string[];
  private config: Config;
  private app: Hono;
  private readonly env: Record<string, string>;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  /** The alarm as last set or read (undefined = not read yet). */
  private armedAt: number | null | undefined;

  constructor(private readonly o: BrainOptions) {
    this.db = o.db;
    this.env = stringEnv(o.env);
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((msg) => console.warn(msg));
    this.config = this.makeConfig();
    const missingTap =
      !this.config.LINKTAP_MOCK && (!this.config.LINKTAP_USERNAME || !this.config.LINKTAP_API_KEY);
    this.problems = this.config.LINKTAP_MOCK
      ? []
      : [
          ...(missingTap ? ['LINKTAP_USERNAME and LINKTAP_API_KEY are not set'] : []),
          ...insecureConfig(this.config, {
            minAdminPassword: WORKER_MIN_ADMIN_PASSWORD,
            requireSignIn: true,
          }),
        ];
    if (this.problems.length) {
      this.log(
        ['Refusing to run with real taps and weak secrets:', ...this.problems].join('\n - '),
      );
    }
    this.engineOn = engineEnabled(this.config) && !this.problems.length;
    const timeZone = this.timeZone();
    let wheel: Wheel | undefined;
    this.services = createServices({
      config: this.config,
      db: this.db,
      timeZone,
      log: this.log,
      timers: 'external',
      // Always persisted here: an eviction must not forget LinkTap's limits.
      lastCallStore: settingsLastCallStore(this.db),
      passwordScheme: 'pbkdf2',
      scheduleReconcile: (deviceId, at) => wheel?.schedule(`reconcile:${deviceId}`, at),
      // Missing credentials degrade to the 503 below instead of crashing the object.
      linktap: o.linktap ?? (missingTap ? noLinkTap() : undefined),
      signTokens: true,
      authFetch: o.authFetch,
    });
    this.wheel = wheel = new Wheel({
      db: this.db,
      services: this.services,
      engineEnabled: this.engineOn,
      // Monitoring never depends on ENGINE_ENABLED; only missing/weak secrets stop it.
      pollingEnabled: !this.problems.length,
      log: this.log,
    });
    this.app = this.makeApp(timeZone);
    this.services.gcal.start();
  }

  private makeConfig(): Config {
    const config = loadConfig(this.env);
    // No PUBLIC_URL var: the one derived from the first request (see fetch), else a placeholder.
    const publicUrl =
      this.env.PUBLIC_URL || getSetting(this.db, PUBLIC_URL_KEY) || 'http://localhost';
    // Every request comes through Cloudflare, so CF-Connecting-IP is always trustworthy.
    return { ...config, PUBLIC_URL: publicUrl.replace(/\/+$/, ''), TRUST_PROXY: true };
  }

  /** Saved zone, else TZ, else the first gateway's zone, else UTC (there is no system TZ). */
  private timeZone(): string {
    const saved = getSetting(this.db, TIME_ZONE_KEY);
    if (saved && isValidTimeZone(saved)) return saved;
    if (this.config.TZ && isValidTimeZone(this.config.TZ)) return this.config.TZ;
    const gw = this.db.select({ tz: gateways.timezone }).from(gateways).limit(1).get();
    return gw?.tz && isValidTimeZone(gw.tz) ? gw.tz : 'UTC';
  }

  private makeApp(timeZone: string): Hono {
    return createApp({
      config: this.config,
      db: this.db,
      linktap: this.services.linktap,
      poller: this.services.poller,
      scheduler: this.services.scheduler,
      executor: this.services.executor,
      weather: this.services.weather,
      gcal: this.services.gcal,
      auth: this.services.auth,
      push: this.services.push,
      timeZone,
      clientIp: (c) => c.req.header('cf-connecting-ip'),
      // The alarm wheel notices new events and open runs; see rearm() after each request.
      onHookEvent: () => {},
      logRequests: false,
    });
  }

  get publicUrl(): string {
    return this.config.PUBLIC_URL;
  }

  /**
   * PUBLIC_URL unset: adopt the first request's origin (the *.workers.dev URL or a custom
   * domain), remember it, and rebuild the URL-dependent services (auth's WebAuthn RP id, the
   * Google redirect, push's VAPID subject). First one wins: set PUBLIC_URL to change it later.
   */
  private adoptOrigin(request: Request) {
    if (this.env.PUBLIC_URL || getSetting(this.db, PUBLIC_URL_KEY)) return;
    const origin = new URL(request.url).origin;
    setSetting(this.db, PUBLIC_URL_KEY, origin);
    this.config = this.makeConfig();
    const { db, config, log } = { db: this.db, config: this.config, log: this.log };
    this.services.gcal.stop();
    this.services.auth = new AuthService({
      db,
      config,
      log,
      passwordScheme: 'pbkdf2',
      signTokens: true,
      fetch: this.o.authFetch,
    });
    this.services.gcal = new GcalService({
      db,
      config,
      timeZone: this.timeZone(),
      log,
      executor: this.services.executor,
      timers: 'external',
    });
    this.services.push = new PushService({ db, config, log });
    // The wheel holds the same services object, so it sees the new gcal and push.
    this.services.gcal.start();
    this.app = this.makeApp(this.timeZone());
  }

  async fetch(incoming: Request): Promise<Response> {
    this.adoptOrigin(incoming);
    const path = new URL(incoming.url).pathname;
    const limited = await limitBody(
      incoming,
      path.startsWith('/hooks/') ? MAX_HOOK_BODY : MAX_API_BODY,
    );
    if (limited instanceof Response) return limited;
    const request = limited;
    let response: Response;
    if (this.problems.length) {
      // /api/health too, so a deploy smoke check fails instead of passing on a dead app.
      response = Response.json(
        {
          ...(path === '/api/health' ? { ok: false } : {}),
          error: 'Hoseidon refuses to run with real taps and weak secrets',
          problems: this.problems,
        },
        { status: 503 },
      );
    } else {
      await this.services.auth.whenReady();
      response = await this.app.fetch(request);
    }
    // A request may have made work due sooner (a schedule edit, a webhook, a new event).
    await this.rearm(false);
    return response;
  }

  /** The Durable Object alarm handler. Never throws, and always leaves an alarm set. */
  async alarm(): Promise<void> {
    this.armedAt = null; // this alarm is spent
    try {
      await this.wheel.runDue(this.now());
    } catch (err) {
      this.log(`alarm: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await this.rearm(true);
    }
  }

  /** Cron watchdog: re-arm when the alarm is missing (dead after its retries) or overdue. */
  async ensureAlarm(): Promise<{ alarmAt: number | null; rearmed: boolean }> {
    const at = await this.o.alarm.get();
    this.armedAt = at;
    if (at !== null && at > this.now() - OVERDUE_MS) return { alarmAt: at, rearmed: false };
    await this.rearm(true);
    return { alarmAt: this.armedAt ?? null, rearmed: true };
  }

  /** When the alarm should fire next: the wheel's next due time, clamped. */
  nextAlarmAt(): number {
    const now = this.now();
    const next = this.wheel.nextDue(now) ?? now + MAX_ALARM_GAP_MS;
    return Math.max(now + 1_000, Math.min(next, now + MAX_ALARM_GAP_MS));
  }

  /**
   * Set the alarm to nextAlarmAt(). After a request only move it earlier (every setAlarm is a row
   * written, and a later alarm will recompute anyway); after an alarm, always set it.
   */
  private async rearm(always: boolean): Promise<void> {
    const next = this.nextAlarmAt();
    if (!always) {
      if (this.armedAt === undefined) this.armedAt = await this.o.alarm.get();
      const armed = this.armedAt;
      const alive = armed !== null && armed > this.now() - OVERDUE_MS;
      if (alive && armed <= next + 1_000) return;
    }
    await this.o.alarm.set(next);
    this.armedAt = next;
  }
}
