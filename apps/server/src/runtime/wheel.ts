import { and, asc, eq, gte, isNotNull, lte, min, or } from 'drizzle-orm';
import type { Db } from '../db/types';
import { lastCalls } from '../db/kv';
import { devices, plannedRuns, runs, timers } from '../db/schema';
import type { Services } from '../services';

/**
 * The timer wheel behind the Cloudflare host's single Durable Object alarm (docs/cloudflare.md,
 * "Timers"). Node runs each service on its own setInterval; a Durable Object gets one alarm and
 * may be evicted at any moment, so here every recurring task's next due time is computed from
 * state that is already persisted (LinkTap call times, planned runs, the push cursor), and
 * one-off delays live in the `timers` table. Nothing in memory is needed to know what's next,
 * so an eviction loses nothing, and a tick writes no extra rows just to remember the schedule.
 *
 * Per wake, tasks run in priority order with a small work budget (counted, never timed:
 * `Date.now()` in Workers only moves across I/O), and the host re-arms the alarm at nextDue().
 */

export type TaskName = 'timers' | 'status' | 'engine' | 'devices' | 'history' | 'push' | 'gcal';

/** Priority order: verify/start and status first, slow housekeeping last. */
export const TASK_ORDER: readonly TaskName[] = [
  'timers',
  'status',
  'engine',
  'devices',
  'history',
  'push',
  'gcal',
];

/** Rough CPU cost per task (devices ≈ 3 ms measured, the rest ≈ 1 ms). */
export const TASK_COST: Record<TaskName, number> = {
  timers: 1,
  status: 1,
  engine: 1,
  devices: 3,
  history: 1,
  push: 1,
  gcal: 2,
};

export const WHEEL = {
  /** Work units per wake, against the 10 ms CPU budget. The first due task always runs. */
  budget: 6,
  /** Engine cadence while a run is due within `soonMs`, or running. */
  engineActiveMs: 30_000,
  /** Engine cadence otherwise (it still settles, materializes and catches up). */
  engineIdleMs: 5 * 60_000,
  soonMs: 2 * 60_000,
  /** Wake this long before the next planned occurrence, then tick at the active cadence. */
  leadMs: 60_000,
  /** History: one device per this long, overall (each outlet's own lane is 10 min too). */
  historyEveryMs: 10 * 60_000,
  /** The engine ignores planned rows older than this (engine.ts LOOKBACK_MS). */
  lookbackMs: 2 * 86_400_000,
} as const;

export interface WheelOptions {
  db: Db;
  services: Pick<Services, 'linktap' | 'poller' | 'scheduler' | 'push' | 'gcal'>;
  /** Poller + scheduler on (ENGINE_ENABLED). Push, gcal and timers run either way. */
  engineEnabled: boolean;
  log?: (msg: string) => void;
}

/** A failing one-off is retried this often, this many times in all. */
const TIMER_RETRY_MS = 60_000;
const TIMER_ATTEMPTS = 3;

export class Wheel {
  constructor(private readonly o: WheelOptions) {}

  // ---- one-off timers -------------------------------------------------------------------------

  /** Persist a one-off: `key` is "<kind>:<arg>" (kind "reconcile" = history for a device). */
  schedule(key: string, at: Date, payload: unknown = null): void {
    this.o.db
      .insert(timers)
      .values({ key, dueAt: at, payload })
      .onConflictDoUpdate({ target: timers.key, set: { dueAt: at, payload } })
      .run();
  }

  private nextTimerAt(): number | null {
    const row = this.o.db
      .select({ at: min(timers.dueAt) })
      .from(timers)
      .get();
    return row?.at ? new Date(row.at).getTime() : null;
  }

  private async runTimers(now: number): Promise<void> {
    const { db, poller } = { db: this.o.db, poller: this.o.services.poller };
    const due = db
      .select()
      .from(timers)
      .where(lte(timers.dueAt, new Date(now)))
      .orderBy(asc(timers.dueAt))
      .limit(3)
      .all();
    for (const t of due) {
      // Only this exact row: a handler may have scheduled a replacement under the same key.
      const same = and(eq(timers.key, t.key), eq(timers.dueAt, t.dueAt));
      const [kind, arg] = splitKey(t.key);
      try {
        if (kind === 'reconcile' && arg && this.o.engineEnabled) {
          await poller.reconcileHistory(arg);
        } else if (kind !== 'reconcile') {
          this.o.log?.(`wheel: unknown timer ${t.key}`);
        }
        // Removed only once handled, so an eviction mid-handler runs it again (handlers are
        // idempotent; alarms are at-least-once anyway).
        db.delete(timers).where(same).run();
      } catch (err) {
        const attempts = ((t.payload as { attempts?: number } | null)?.attempts ?? 0) + 1;
        this.o.log?.(`wheel: timer ${t.key} failed (${attempts}x): ${(err as Error).message}`);
        if (attempts >= TIMER_ATTEMPTS) {
          db.delete(timers).where(same).run();
        } else {
          db.update(timers)
            .set({ dueAt: new Date(now + TIMER_RETRY_MS), payload: { attempts } })
            .where(same)
            .run();
        }
      }
    }
  }

  // ---- due times ------------------------------------------------------------------------------

  /** When each task is next due (ms epoch), or null when it has nothing to do. */
  dueTimes(now: number): Record<TaskName, number | null> {
    const { engineEnabled } = this.o;
    return {
      timers: this.nextTimerAt(),
      status: engineEnabled ? this.statusDue() : null,
      engine: engineEnabled ? this.engineDue(now) : null,
      devices: engineEnabled ? this.o.services.linktap.nextAvailableAt('devices').getTime() : null,
      history: engineEnabled ? this.historyDue() : null,
      push: this.o.services.push.hasPending() ? now : null,
      gcal: this.o.services.gcal.nextDueAt(),
    };
  }

  /** The earliest due time over all tasks (null = nothing scheduled). */
  nextDue(now: number): number | null {
    let best: number | null = null;
    for (const t of Object.values(this.dueTimes(now))) {
      if (t !== null && (best === null || t < best)) best = t;
    }
    return best;
  }

  /** Status polls only while something is (or should be) watering; each outlet has its lane. */
  private statusDue(): number | null {
    const { db, services } = this.o;
    const active = db
      .selectDistinct({ id: devices.id })
      .from(devices)
      .leftJoin(runs, and(eq(runs.deviceId, devices.id), eq(runs.status, 'running')))
      .where(or(isNotNull(devices.watering), isNotNull(runs.id)))
      .all();
    let best: number | null = null;
    for (const d of active) {
      const t = services.linktap.nextAvailableAt('status', d.id).getTime();
      if (best === null || t < best) best = t;
    }
    return best;
  }

  private engineDue(now: number): number {
    const { db, services } = this.o;
    const last = services.scheduler.lastTick()?.getTime();
    // First tick after a (re)start: right away, like Node's start().
    if (last === undefined) return now;
    const since = new Date(now - WHEEL.lookbackMs);
    const running = db
      .select({ id: plannedRuns.id })
      .from(plannedRuns)
      .where(and(eq(plannedRuns.status, 'running'), gte(plannedRuns.occurrenceAt, since)))
      .limit(1)
      .get();
    const nextRow = db
      .select({ at: min(plannedRuns.occurrenceAt) })
      .from(plannedRuns)
      .where(and(eq(plannedRuns.status, 'planned'), gte(plannedRuns.occurrenceAt, since)))
      .get();
    const next = nextRow?.at ? new Date(nextRow.at).getTime() : null;
    if (running || (next !== null && next <= now + WHEEL.soonMs)) {
      return last + WHEEL.engineActiveMs;
    }
    let due = last + WHEEL.engineIdleMs;
    if (next !== null) due = Math.min(due, next - WHEEL.leadMs);
    return Math.max(due, last + WHEEL.engineActiveMs);
  }

  /** One history fetch per 10 min overall, and only when some outlet's own lane is free. */
  private historyDue(): number | null {
    const { db, services } = this.o;
    const ids = db.select({ id: devices.id }).from(devices).all();
    if (!ids.length) return null;
    let latest: number | null = null;
    for (const [lane, at] of Object.entries(lastCalls(db))) {
      if (lane.startsWith('history:') && (latest === null || at > latest)) latest = at;
    }
    let free: number | null = null;
    for (const { id } of ids) {
      const t = services.linktap.nextAvailableAt('history', id).getTime();
      if (free === null || t < free) free = t;
    }
    return Math.max(free ?? 0, (latest ?? 0) + WHEEL.historyEveryMs);
  }

  // ---- running --------------------------------------------------------------------------------

  /**
   * Run what is due at `now`, in priority order, within the work budget. Never throws: a failing
   * task is logged and the others still run. Returns the tasks that ran.
   */
  async runDue(now: number): Promise<TaskName[]> {
    const due = this.dueTimes(now);
    const ran: TaskName[] = [];
    let spent = 0;
    for (const task of TASK_ORDER) {
      const at = due[task];
      if (at === null || at > now) continue;
      if (ran.length && spent + TASK_COST[task] > WHEEL.budget) continue;
      spent += TASK_COST[task];
      ran.push(task);
      try {
        await this.run(task, now);
      } catch (err) {
        this.o.log?.(`wheel ${task}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return ran;
  }

  private async run(task: TaskName, now: number): Promise<void> {
    const { poller, scheduler, push, gcal } = this.o.services;
    switch (task) {
      case 'timers':
        return this.runTimers(now);
      case 'status':
        return poller.pollRunning();
      case 'engine':
        return scheduler.tick();
      case 'devices':
        return poller.pollDevices();
      case 'history':
        return poller.pollHistoryNext();
      case 'push':
        return push.flush();
      case 'gcal':
        return gcal.runDue(now);
    }
  }
}

function splitKey(key: string): [string, string | undefined] {
  const i = key.indexOf(':');
  return i === -1 ? [key, undefined] : [key.slice(0, i), key.slice(i + 1)];
}
