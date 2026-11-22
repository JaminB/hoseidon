import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  GCAL_CALENDAR_NAME,
  GCAL_SCOPE,
  GCAL_TESTING_TOKEN_DAYS,
  type GcalStatus,
  type GcalSyncState,
} from '@hoseidon/shared';
import type { Config } from '../config';
import type { Db } from '../db/types';
import { putEphemeral, takeEphemeral } from '../db/ephemeral';
import { gcalAccount, gcalEvents, schedules, settings, type GcalAccountRow } from '../db/schema';
import type { Executor } from '../schedule/executor';
import { CalendarApi, GoogleApiError } from './calendar';
import { SecretBox } from './crypto';
import {
  authUrl,
  exchangeCode,
  GoogleAuthError,
  pkcePair,
  revokeToken,
  TokenSource,
  type OAuthClient,
} from './oauth';
import { applyOps, buildDesired, CalendarGoneError, diffSync, WINDOW_MS, type Op } from './sync';

const opKey = (op: Op) => (op.type === 'delete' ? op.row.key : op.item.key);

const LOG_RUNS_KEY = 'gcal.logRuns';
const STATE_TTL_MS = 10 * 60_000;
const MIN_SECRET = 16;
const DAY = 86_400_000;

/** Why the callback didn't connect, for the redirect back to Settings. */
export type ConnectFailure =
  'denied' | 'state' | 'exchange' | 'scope' | 'no_refresh_token' | 'calendar' | 'not_configured';

/** Google said the grant is dead: stop and ask the user to reconnect. */
class ReconnectRequired extends Error {}

export interface GcalOptions {
  db: Db;
  config: Pick<
    Config,
    'GOOGLE_CLIENT_ID' | 'GOOGLE_CLIENT_SECRET' | 'SESSION_SECRET' | 'PUBLIC_URL'
  >;
  /** Time zone for the new calendar and for runs on gateways without one. */
  timeZone: string;
  /** Executor rounding, so event lengths match real runs. */
  executor?: Pick<Executor, 'quantize'>;
  fetch?: typeof fetch;
  now?: () => Date;
  log?: (msg: string) => void;
  /** Wait this long after a change before syncing, to batch edits. Default 3 s. */
  debounceMs?: number;
  /** Background reconcile, which picks up skips and finished runs. Default 5 min. */
  periodicMs?: number;
  /**
   * 'node' (default): debounce, backoff and the periodic pass run on setTimeout/setInterval.
   * 'external': nothing runs by itself; the host asks `nextDueAt()` and calls `runDue()` (the
   * Cloudflare alarm wheel). Each pass then applies at most `opsPerPass` changes and leaves the
   * rest for the next wake instead of looping, to stay under the per-invocation subrequest cap.
   */
  timers?: 'node' | 'external';
  /** Max Google writes per pass (external timers only). Default 20. */
  opsPerPass?: number;
}

/** Backoff after the nth consecutive failure: 30 s, 1 min, 2 min ... capped at 30 min. */
export const backoffMs = (failures: number) =>
  Math.min(30_000 * 2 ** Math.max(0, failures - 1), 30 * 60_000);

export class GcalService {
  private readonly db: Db;
  private readonly fetch: typeof fetch;
  private readonly now: () => Date;
  private readonly log: (msg: string) => void;
  private readonly box: SecretBox | null;
  private readonly client: OAuthClient;
  private tokens: TokenSource | null = null;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerAt: number | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private lastPeriodicAt: number | null = null;
  /** External mode: items Google rejected (400) last time; they go to the back of the line. */
  private readonly rejected = new Set<string>();
  private dirty = false;
  private failures = 0;
  private inBackoff = false;
  /** A callback is swapping the connection: no sync may run until it's done. */
  private connecting = false;

  constructor(private readonly opts: GcalOptions) {
    this.db = opts.db;
    // A wrapper, not globalThis.fetch itself: workerd throws "Illegal invocation" when fetch is
    // called as a method of another object (CalendarApi calls this.opts.fetch(...)).
    this.fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? (() => {});
    const secret = opts.config.SESSION_SECRET;
    this.box = secret.length >= MIN_SECRET ? new SecretBox(secret) : null;
    this.client = {
      clientId: opts.config.GOOGLE_CLIENT_ID,
      clientSecret: opts.config.GOOGLE_CLIENT_SECRET,
      redirectUri: `${opts.config.PUBLIC_URL.replace(/\/+$/, '')}/api/gcal/callback`,
    };
  }

  // ---- config + state ---------------------------------------------------------------------------

  missing(): string[] {
    const out: string[] = [];
    if (!this.client.clientId) out.push('GOOGLE_CLIENT_ID');
    if (!this.client.clientSecret) out.push('GOOGLE_CLIENT_SECRET');
    if (!this.box) out.push('SESSION_SECRET');
    return out;
  }

  get configured() {
    return this.missing().length === 0;
  }

  /** Where the OAuth callback sends the browser afterwards. */
  settingsUrl(result: { ok: true } | { ok: false; reason: ConnectFailure }) {
    const base = this.opts.config.PUBLIC_URL.replace(/\/+$/, '');
    return `${base}/settings?gcal=${result.ok ? 'connected' : `error&reason=${result.reason}`}`;
  }

  private account(): GcalAccountRow | undefined {
    return this.db.select().from(gcalAccount).where(eq(gcalAccount.id, 1)).get();
  }

  private saveAccount(patch: Partial<Omit<GcalAccountRow, 'id'>>) {
    const values = { ...patch, updatedAt: this.now() };
    this.db
      .insert(gcalAccount)
      .values({ id: 1, ...values })
      .onConflictDoUpdate({ target: gcalAccount.id, set: values })
      .run();
  }

  private get connected() {
    const a = this.account();
    return !!a?.refreshTokenEnc && !a.needsReconnect && !!a.calendarId && this.configured;
  }

  logRuns(): boolean {
    return (
      this.db.select().from(settings).where(eq(settings.key, LOG_RUNS_KEY)).get()?.value === 'true'
    );
  }

  setLogRuns(on: boolean) {
    const value = String(on);
    this.db
      .insert(settings)
      .values({ key: LOG_RUNS_KEY, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } })
      .run();
    this.request();
  }

  private syncState(): GcalSyncState {
    if (!this.connected) return 'paused';
    if (this.running) return 'running';
    if (this.inBackoff) return 'backoff';
    if (this.timerAt !== null) return 'pending';
    return 'idle';
  }

  status(): GcalStatus {
    const a = this.account();
    const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
    const counts = { schedules: 0, skips: 0, logs: 0 };
    for (const r of this.db.select({ kind: gcalEvents.kind }).from(gcalEvents).all()) {
      if (r.kind === 'schedule') counts.schedules++;
      else if (r.kind === 'skip') counts.skips++;
      else counts.logs++;
    }
    const connected = !!a?.refreshTokenEnc;
    return {
      configured: this.configured,
      missing: this.missing(),
      redirectUri: this.client.redirectUri,
      connected,
      needsReconnect: connected && !!a?.needsReconnect,
      calendarId: a?.calendarId ?? null,
      calendarUrl: a?.calendarId
        ? `https://calendar.google.com/calendar/u/0/r?cid=${encodeURIComponent(a.calendarId)}`
        : null,
      connectedAt: iso(connected ? a?.connectedAt : null),
      reconnectDueAt:
        connected && a?.connectedAt
          ? new Date(a.connectedAt.getTime() + GCAL_TESTING_TOKEN_DAYS * DAY).toISOString()
          : null,
      lastSyncAt: iso(a?.lastSyncAt),
      lastError: a?.lastError ?? null,
      sync: {
        state: this.syncState(),
        nextRunAt: this.timerAt ? new Date(this.timerAt).toISOString() : null,
        failures: this.failures,
      },
      events: counts,
      logRuns: this.logRuns(),
    };
  }

  // ---- OAuth ------------------------------------------------------------------------------------

  /** Start the consent flow. Returns the Google URL to send the browser to. */
  connectUrl(): string {
    if (!this.configured)
      throw new Error(`Google Calendar isn't configured: set ${this.missing().join(', ')}`);
    const t = this.now().getTime();
    const state = randomBytes(24).toString('base64url');
    const { verifier, challenge } = pkcePair();
    // In the DB, not in memory: the callback may land after a restart (or a Worker eviction).
    putEphemeral(this.db, `oauth:${state}`, verifier, new Date(t + STATE_TTL_MS));
    return authUrl(this.client, state, challenge);
  }

  async handleCallback(q: {
    code?: string;
    state?: string;
    error?: string;
  }): Promise<{ ok: true } | { ok: false; reason: ConnectFailure }> {
    if (!this.configured || !this.box) return { ok: false, reason: 'not_configured' };
    const verifier = q.state ? takeEphemeral(this.db, `oauth:${q.state}`, this.now()) : undefined;
    if (!verifier) return { ok: false, reason: 'state' };
    if (q.error || !q.code) return { ok: false, reason: 'denied' };

    let token;
    try {
      token = await exchangeCode(this.fetch, this.client, q.code, verifier);
    } catch (err) {
      this.log(`gcal: code exchange failed: ${(err as Error).message}`);
      return { ok: false, reason: 'exchange' };
    }
    // Google's consent screen lets people untick scopes.
    if (!token.scope?.split(' ').includes(GCAL_SCOPE)) return { ok: false, reason: 'scope' };
    if (!token.refresh_token) return { ok: false, reason: 'no_refresh_token' };

    const refreshToken = token.refresh_token;
    const tokens = this.makeTokens(() => refreshToken);
    tokens.set(token.access_token, token.expires_in);
    const api = new CalendarApi({ fetch: this.fetch, token: (force) => tokens.get(force) });

    // Swapping the connection (maybe the calendar) under an in-flight sync would save its event
    // ids against the wrong calendar. Hold syncs off and let the current one finish first.
    this.connecting = true;
    try {
      this.clearTimer();
      await this.running?.catch(() => {});
      let calendarId: string;
      try {
        calendarId = await this.ensureCalendar(api, this.account()?.calendarId ?? null);
      } catch (err) {
        this.log(`gcal: calendar setup failed: ${(err as Error).message}`);
        return { ok: false, reason: 'calendar' };
      }
      this.saveAccount({
        refreshTokenEnc: this.box.encrypt(refreshToken),
        scope: token.scope,
        calendarId,
        connectedAt: this.now(),
        needsReconnect: false,
        lastError: null,
      });
      this.tokens = tokens;
      this.failures = 0;
      this.inBackoff = false;
    } finally {
      this.connecting = false;
    }
    this.request(0);
    return { ok: true };
  }

  /** Reuse our calendar if Google still has it, else make a fresh one (and forget old events). */
  private async ensureCalendar(api: CalendarApi, existing: string | null): Promise<string> {
    if (existing) {
      try {
        await api.getCalendar(existing);
        return existing;
      } catch (err) {
        // Replace only when the calendar is gone or we lost access to it. A 403 can also be a rate
        // limit, which must back off rather than orphan every event in the old calendar.
        const lost =
          err instanceof GoogleApiError && (err.gone || (err.status === 403 && !err.rateLimited));
        if (!lost) throw err;
      }
    }
    const created = await api.createCalendar({
      summary: GCAL_CALENDAR_NAME,
      description:
        'Watering schedules from Hoseidon. Managed by the app; edits here are overwritten.',
      timeZone: this.opts.timeZone,
    });
    this.db.delete(gcalEvents).run();
    this.db.update(schedules).set({ gcalEventId: null }).run();
    return created.id;
  }

  private makeTokens(refreshToken: () => string) {
    return new TokenSource({
      fetch: this.fetch,
      client: this.client,
      refreshToken,
      now: () => this.now().getTime(),
    });
  }

  /** Tokens from the stored refresh token. A token sealed with another SESSION_SECRET is dead. */
  private tokenSource(): TokenSource {
    if (this.tokens) return this.tokens;
    const enc = this.account()?.refreshTokenEnc;
    if (!enc || !this.box) throw new ReconnectRequired('Not connected');
    let refresh: string;
    try {
      refresh = this.box.decrypt(enc);
    } catch {
      throw new ReconnectRequired('Stored Google token is unreadable (SESSION_SECRET changed?)');
    }
    this.tokens = this.makeTokens(() => refresh);
    return this.tokens;
  }

  /** Revoke at Google (best effort) and forget the token. The calendar and its events stay. */
  async disconnect(): Promise<void> {
    const enc = this.account()?.refreshTokenEnc;
    if (enc && this.box) {
      try {
        await revokeToken(this.fetch, this.box.decrypt(enc));
      } catch {
        // Unreadable token: nothing to revoke.
      }
    }
    this.clearTimer();
    this.tokens = null;
    this.failures = 0;
    this.inBackoff = false;
    this.saveAccount({
      refreshTokenEnc: null,
      scope: null,
      connectedAt: null,
      needsReconnect: false,
      lastError: null,
    });
  }

  // ---- queue ------------------------------------------------------------------------------------

  private get external() {
    return this.opts.timers === 'external';
  }

  start() {
    if (!this.external) {
      this.interval ??= setInterval(() => this.request(0), this.opts.periodicMs ?? 5 * 60_000);
    }
    this.request(0);
  }

  /** External timers: when `runDue` next has work (null = nothing until something changes). */
  nextDueAt(): number | null {
    if (!this.connected || this.running) return null;
    const periodic = (this.lastPeriodicAt ?? 0) + (this.opts.periodicMs ?? 5 * 60_000);
    return this.timerAt === null ? periodic : Math.min(this.timerAt, periodic);
  }

  /** External timers: run the periodic pass and/or a debounced or backed-off sync, if due. */
  async runDue(now = this.now().getTime()): Promise<void> {
    if (!this.connected) return;
    if ((this.lastPeriodicAt ?? 0) + (this.opts.periodicMs ?? 5 * 60_000) <= now) {
      this.lastPeriodicAt = now;
      if (this.timerAt === null && !this.running) this.timerAt = now;
    }
    if (this.timerAt !== null && this.timerAt <= now) await this.syncNow();
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    this.clearTimer();
  }

  /** Something changed: sync soon. Edits in quick succession share one sync. */
  request(delayMs = this.opts.debounceMs ?? 3000) {
    if (!this.connected || this.connecting) return;
    if (this.running) {
      this.dirty = true;
      return;
    }
    // Don't cut a backoff short; the retry will pick this change up.
    if (this.inBackoff) return;
    this.schedule(delayMs);
  }

  private schedule(delayMs: number) {
    this.clearTimer();
    this.timerAt = this.now().getTime() + delayMs;
    if (this.external) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.timerAt = null;
      void this.syncNow();
    }, delayMs);
    this.timer.unref?.();
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.timerAt = null;
  }

  /** Forget what we pushed, so the next sync rewrites every event. */
  async resync(): Promise<void> {
    if (this.running) await this.running;
    this.db.update(gcalEvents).set({ hash: '' }).run();
    this.inBackoff = false;
    this.failures = 0;
    await this.syncNow();
  }

  /** Run a sync now (serialized). Resolves when it and any follow-up it triggered are done. */
  async syncNow(): Promise<void> {
    // The callback requests a sync once it's done.
    if (this.connecting) return;
    if (this.running) {
      this.dirty = true;
      return this.running;
    }
    this.clearTimer();
    this.inBackoff = false;
    this.running = this.runLoop().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runLoop() {
    do {
      this.dirty = false;
      if (!this.connected) return;
      try {
        await this.reconcile();
        this.failures = 0;
        if (this.external && this.dirty) {
          // More to do: next wake, so one invocation stays within its subrequest budget.
          this.schedule(0);
          return;
        }
      } catch (err) {
        if (err instanceof ReconnectRequired) {
          this.log(`gcal: reconnect needed: ${err.message}`);
          this.tokens = null;
          this.saveAccount({ needsReconnect: true, lastError: err.message });
          return;
        }
        this.failures++;
        const wait = backoffMs(this.failures);
        this.log(
          `gcal: sync failed (${this.failures}x), retrying in ${Math.round(wait / 1000)} s: ${(err as Error).message}`,
        );
        this.saveAccount({ lastError: (err as Error).message });
        this.schedule(wait);
        this.inBackoff = true;
        return;
      }
    } while (this.dirty);
  }

  private async reconcile(retriedCalendar = false): Promise<void> {
    const account = this.account();
    const calendarId = account?.calendarId;
    if (!calendarId) throw new ReconnectRequired('No calendar');
    const now = this.now();
    const logRuns = this.logRuns();
    const desired = buildDesired(this.db, {
      now,
      logRuns,
      timeZone: this.opts.timeZone,
      executor: this.opts.executor,
    });
    const existing = this.db.select().from(gcalEvents).all();
    const ops = diffSync(desired, existing, {
      windowStart: new Date(now.getTime() - WINDOW_MS),
      logRuns,
    });
    if (ops.length) {
      const source = this.tokenSource();
      const api = new CalendarApi({
        fetch: this.fetch,
        token: async (force) => {
          try {
            return await source.get(force);
          } catch (err) {
            // Only invalid_grant means the grant is dead. invalid_client and friends are a config
            // problem: back off and keep the token, so fixing the client resumes sync.
            if (err instanceof GoogleAuthError && err.invalidGrant) {
              throw new ReconnectRequired('Google revoked or expired the connection');
            }
            throw err;
          }
        },
      });
      try {
        // External mode applies a slice per pass. Items Google rejected last time go last, so
        // they can't hog the slice and starve independent changes; and leftovers that are only
        // rejected items wait for the periodic pass instead of looping straight away.
        const perPass = this.opts.opsPerPass ?? 20;
        const ordered = this.external
          ? [
              ...ops.filter((op) => !this.rejected.has(opKey(op))),
              ...ops.filter((op) => this.rejected.has(opKey(op))),
            ]
          : ops;
        const batch = this.external ? ordered.slice(0, perPass) : ops;
        const { errors, again } = await applyOps(
          this.db,
          api,
          calendarId,
          batch,
          desired,
          this.now,
        );
        if (this.external) {
          for (const op of batch) this.rejected.delete(opKey(op));
          for (const e of errors) this.rejected.add(e.key);
          if (ordered.slice(perPass).some((op) => !this.rejected.has(opKey(op)))) {
            this.dirty = true;
          }
        }
        if (again) this.dirty = true;
        this.saveAccount({
          lastSyncAt: this.now(),
          lastError: errors.length
            ? `${errors.length} event(s) rejected: ${errors[0]!.message}`
            : null,
        });
        return;
      } catch (err) {
        if (err instanceof CalendarGoneError && !retriedCalendar) {
          this.log('gcal: calendar is gone, making a new one');
          const id = await this.ensureCalendar(api, null);
          this.saveAccount({ calendarId: id });
          return this.reconcile(true);
        }
        if (
          err instanceof GoogleApiError &&
          (err.status === 401 || (err.status === 403 && err.reason === 'insufficientPermissions'))
        ) {
          throw new ReconnectRequired(err.message);
        }
        throw err;
      }
    }
    this.saveAccount({ lastSyncAt: this.now(), lastError: null });
  }
}
