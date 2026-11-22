import { eq, gt, asc, sql } from 'drizzle-orm';
import { generateVAPIDKeys, sendNotification } from 'web-push';
import {
  DEFAULT_PUSH_PREFS,
  type PushPayload,
  type PushPrefs,
  type PushStatus,
  type PushSubscriptionInput,
} from '@hoseidon/shared';
import type { Config } from '../config';
import type { Db } from '../db';
import { getJson, getSetting, setSetting } from '../db/kv';
import { events, pushSubscriptions, type PushSubscriptionRow } from '../db/schema';
import { pushCategory, pushPayload } from './classify';

const VAPID_KEY = 'push.vapid';
const PREFS_KEY = 'push.prefs';
const CURSOR_KEY = 'push.cursor';
/** The same alarm from the webhook and the poller shouldn't buzz twice. */
const DEDUPE_MS = 10 * 60_000;
/** More than this in one pass collapses into a summary, so an outage doesn't spam a phone. */
const MAX_PER_FLUSH = 4;

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** Sends one notification. Throws an error carrying `statusCode` when the push service refuses. */
export type PushSender = (
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
  vapid: VapidKeys & { subject: string },
) => Promise<unknown>;

const webPushSender: PushSender = (sub, payload, vapid) =>
  sendNotification(sub, payload, {
    TTL: 3600,
    urgency: 'high',
    vapidDetails: {
      subject: vapid.subject,
      publicKey: vapid.publicKey,
      privateKey: vapid.privateKey,
    },
  });

export interface PushOptions {
  db: Db;
  config: Config;
  send?: PushSender;
  now?: () => number;
  log?: (msg: string) => void;
}

/**
 * Turns new rows in `events` into Web Push notifications. Watching the table (instead of hooking
 * each place that writes an event) covers the poller, the scheduler and webhooks alike, and a push
 * can never be sent for a write that rolled back.
 */
export class PushService {
  private timer?: NodeJS.Timeout;
  private flushing = false;
  private recent = new Map<string, number>();
  private readonly send: PushSender;
  private readonly now: () => number;

  constructor(private readonly o: PushOptions) {
    this.send = o.send ?? webPushSender;
    this.now = o.now ?? Date.now;
  }

  start(intervalMs = 10_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  // ---- keys and settings ----------------------------------------------------------------------

  vapid(): VapidKeys {
    const { db } = this.o;
    const saved = getJson<VapidKeys>(db, VAPID_KEY);
    if (saved?.publicKey && saved.privateKey) return saved;
    const keys = generateVAPIDKeys();
    setSetting(db, VAPID_KEY, JSON.stringify(keys));
    return keys;
  }

  /** Push services want a contact: a real https URL if we have one, else a placeholder mailto. */
  private subject(): string {
    return this.o.config.PUBLIC_URL.startsWith('https://')
      ? this.o.config.PUBLIC_URL
      : 'mailto:admin@hoseidon.invalid';
  }

  prefs(): PushPrefs {
    return { ...DEFAULT_PUSH_PREFS, ...getJson<Partial<PushPrefs>>(this.o.db, PREFS_KEY) };
  }

  setPrefs(patch: Partial<PushPrefs>): PushPrefs {
    const next = { ...this.prefs(), ...patch };
    setSetting(this.o.db, PREFS_KEY, JSON.stringify(next));
    return next;
  }

  status(): PushStatus {
    const { n } = this.o.db
      .select({ n: sql<number>`count(*)` })
      .from(pushSubscriptions)
      .get()!;
    return { publicKey: this.vapid().publicKey, subscriptions: n, prefs: this.prefs() };
  }

  // ---- subscriptions --------------------------------------------------------------------------

  subscribe(sub: PushSubscriptionInput): void {
    const values = { endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth };
    this.o.db
      .insert(pushSubscriptions)
      .values(values)
      .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: values })
      .run();
  }

  unsubscribe(endpoint: string): void {
    this.o.db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)).run();
  }

  // ---- sending --------------------------------------------------------------------------------

  /** Sends to every subscription; ones the push service says are gone are forgotten. */
  async broadcast(payload: PushPayload): Promise<{ sent: number; failed: number }> {
    const { db, log } = this.o;
    const subs = db.select().from(pushSubscriptions).all();
    if (!subs.length) return { sent: 0, failed: 0 };
    const vapid = { ...this.vapid(), subject: this.subject() };
    const body = JSON.stringify(payload);
    const results = await Promise.allSettled(subs.map((s) => this.sendOne(s, body, vapid)));
    const failed = results.filter((r) => r.status === 'rejected');
    for (const f of failed) log?.(`push failed: ${String((f as PromiseRejectedResult).reason)}`);
    return { sent: results.length - failed.length, failed: failed.length };
  }

  private async sendOne(
    s: PushSubscriptionRow,
    body: string,
    vapid: VapidKeys & { subject: string },
  ): Promise<void> {
    try {
      await this.send(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        body,
        vapid,
      );
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) this.unsubscribe(s.endpoint);
      throw e;
    }
  }

  sendTest(): Promise<{ sent: number; failed: number }> {
    return this.broadcast({
      title: 'Hoseidon',
      body: 'Notifications are working.',
      tag: 'test',
      url: '/settings',
    });
  }

  /** Notify for events written since the last pass. Safe to call often; overlapping calls skip. */
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const { db } = this.o;
      const cursor = Number(getSetting(db, CURSOR_KEY));
      if (!Number.isFinite(cursor) || getSetting(db, CURSOR_KEY) === undefined) {
        // First run: don't replay history.
        const last = db
          .select({ id: events.id })
          .from(events)
          .orderBy(sql`${events.id} desc`)
          .limit(1)
          .get();
        setSetting(db, CURSOR_KEY, String(last?.id ?? 0));
        return;
      }
      const fresh = db
        .select()
        .from(events)
        .where(gt(events.id, cursor))
        .orderBy(asc(events.id))
        .limit(200)
        .all();
      if (!fresh.length) return;
      // Move the cursor first: a crash while sending loses a notification instead of repeating it.
      setSetting(db, CURSOR_KEY, String(fresh[fresh.length - 1]!.id));

      const prefs = this.prefs();
      const now = this.now();
      for (const [k, t] of this.recent) if (now - t > DEDUPE_MS) this.recent.delete(k);
      const due: PushPayload[] = [];
      for (const e of fresh) {
        const category = pushCategory(e.type);
        if (!category || !prefs[category]) continue;
        const payload = pushPayload(category, e);
        if (this.recent.has(payload.tag)) continue;
        this.recent.set(payload.tag, now);
        due.push(payload);
      }
      await this.deliver(due);
    } finally {
      this.flushing = false;
    }
  }

  private async deliver(due: PushPayload[]): Promise<void> {
    if (!due.length) return;
    if (due.length <= MAX_PER_FLUSH) {
      for (const p of due) await this.broadcast(p);
      return;
    }
    for (const p of due.slice(0, MAX_PER_FLUSH - 1)) await this.broadcast(p);
    const rest = due.slice(MAX_PER_FLUSH - 1);
    await this.broadcast({
      title: `${rest.length} more alerts`,
      body: rest.map((p) => p.title).join('\n'),
      tag: 'summary',
      url: '/',
    });
  }
}
