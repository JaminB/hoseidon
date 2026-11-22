import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, or } from 'drizzle-orm';
import type { PlannedRunStatus, RunStatus } from '@hoseidon/shared';
import type { Db } from '../db/types';
import {
  devices,
  gateways,
  plannedRuns,
  runs,
  schedules,
  type DeviceRow,
  type NewEvent,
  type PlannedRunRow,
  type ScheduleRow,
} from '../db/schema';
import { ALARM_LABELS, closeRun, insertEvents, recordStart } from '../poller/ingest';
import { StartAbortedError, startVerified, type Executor } from './executor';
import { expandOccurrences } from './occurrences';
import { laneOf, planOccurrence, slotOrder } from './plan';
import { evaluateSkipRules, NullWeatherProvider, type WeatherProvider } from './weather';

export interface EngineOptions {
  db: Db;
  executor: Executor;
  weather?: WeatherProvider;
  /** Tick interval. Default 30 s. */
  intervalMs?: number;
  /** How far ahead occurrences are materialized. Default 48 h. */
  horizonMs?: number;
  /** A run that should have started more than this long ago is skipped as missed. Default 10 min. */
  catchUpMs?: number;
  /** Give up on a run that has been ready but blocked (gateway busy) this long. Default 2 h. */
  maxWaitMs?: number;
  /** After a run's time is up, wait this long for the poller to close it. Default 2 min. */
  finishGraceMs?: number;
  log?: (msg: string) => void;
  /** The host calls tick() (the Cloudflare alarm wheel) instead of start(). */
  external?: boolean;
}

export interface EngineStatus {
  running: boolean;
  executor: Executor['kind'];
  lastTickAt: string | null;
  lastError: string | null;
}

const TERMINAL: ReadonlySet<PlannedRunStatus> = new Set(['skipped', 'done', 'failed', 'cancelled']);
const BLOCKING_ALARMS = ['noWater', 'valveBroken'] as const;
const RUN_TO_PLANNED: Record<RunStatus, PlannedRunStatus> = {
  running: 'running',
  completed: 'done',
  stopped: 'cancelled',
  failed: 'failed',
  skipped: 'skipped',
};
/** How long after claiming a slot its start can still go out (lane waits, retries, re-send). */
const LAUNCH_WINDOW_MS = 2 * 60_000;
/** Planned rows this old are history; the engine only looks at newer occurrences. */
const LOOKBACK_MS = 2 * 86_400_000;

const groupKey = (r: { scheduleId: number; occurrenceAt: Date }) =>
  `${r.scheduleId}|${r.occurrenceAt.getTime()}`;
const displayName = (d: { name: string | null; linktapName: string }) => d.name ?? d.linktapName;

function localTime(at: Date, timeZone: string) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(at);
}

/**
 * The scheduler. Every tick it:
 * 1. settles runs that finished (or were stopped) since the last tick,
 * 2. materializes upcoming occurrences into planned_runs,
 * 3. skips what was missed while the server was down,
 * 4. applies skip rules / ET scaling to occurrences that are starting,
 * 5. starts whatever is ready, one command at a time: zones on a gateway go one after another
 *    (when the schedule is sequential), and a zone's next cycle waits out its soak.
 */
export class SchedulerEngine {
  private readonly o: Required<Omit<EngineOptions, 'log' | 'weather' | 'external'>> &
    Pick<EngineOptions, 'log' | 'external'> & { weather: WeatherProvider };
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  private lastTickAt: Date | null = null;
  private lastError: string | null = null;
  /** Counts Stop requests; a launch aborts if its device was stopped after it began. */
  private stopSeq = 0;
  private readonly stoppedAt = new Map<string, number>();
  /** Planned runs this process is starting right now (claimed, start not yet recorded). */
  private readonly launching = new Set<number>();

  constructor(opts: EngineOptions) {
    this.o = {
      intervalMs: 30_000,
      horizonMs: 48 * 3_600_000,
      catchUpMs: 10 * 60_000,
      maxWaitMs: 2 * 3_600_000,
      finishGraceMs: 2 * 60_000,
      ...opts,
      weather: opts.weather ?? new NullWeatherProvider(),
    };
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.o.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** When the last tick began (null until the first one in this process). */
  lastTick(): Date | null {
    return this.lastTickAt;
  }

  status(): EngineStatus {
    return {
      running: this.timer !== undefined || !!this.o.external,
      executor: this.o.executor.kind,
      lastTickAt: this.lastTickAt?.toISOString() ?? null,
      lastError: this.lastError,
    };
  }

  /** One pass. Never overlaps itself; errors are logged, not thrown. */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const now = new Date();
    // First tick after boot, or the process was stalled: be strict about late runs.
    const recovering =
      this.lastTickAt === null || now.getTime() - this.lastTickAt.getTime() > 3 * this.o.intervalMs;
    try {
      this.settleRunning(now);
      this.materialize(now);
      this.skipMissedOccurrences(now);
      await this.applySkipRules(now);
      await this.startReady(recovering);
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.o.log?.(`scheduler: ${this.lastError}`);
    } finally {
      this.lastTickAt = now;
      this.busy = false;
    }
  }

  /** The user stopped this device: abort any start of it that is still being verified. */
  noteStop(deviceId: string): void {
    this.stoppedAt.set(deviceId, ++this.stopSeq);
  }

  /**
   * Drop a schedule's not-yet-begun runs and plan again from now. Call after creating, editing,
   * enabling or disabling a schedule. A zone already watering finishes. Zones of an occurrence
   * under way that haven't started yet are cancelled when the schedule is off (or
   * `cancelStarted`, for edits that move it), so they can't water on top of the new plan.
   */
  rematerialize(
    scheduleId: number,
    now = new Date(),
    opts: { cancelStarted?: boolean } = {},
  ): void {
    const s = this.o.db.select().from(schedules).where(eq(schedules.id, scheduleId)).get();
    if (!s?.enabled || opts.cancelStarted) {
      this.o.db
        .update(plannedRuns)
        .set({
          status: 'skipped',
          skipReason: s?.enabled === false ? 'Schedule turned off' : 'Schedule changed',
          updatedAt: now,
        })
        .where(
          and(
            eq(plannedRuns.scheduleId, scheduleId),
            eq(plannedRuns.status, 'planned'),
            isNotNull(plannedRuns.weatherCheckedAt),
          ),
        )
        .run();
    }
    this.o.db
      .delete(plannedRuns)
      .where(
        and(
          eq(plannedRuns.scheduleId, scheduleId),
          eq(plannedRuns.status, 'planned'),
          isNull(plannedRuns.weatherCheckedAt),
        ),
      )
      .run();
    this.materialize(now, scheduleId);
  }

  // ---- 1. settle ------------------------------------------------------------------------------

  private settleRunning(now: Date): void {
    const { db } = this.o;
    const active = db.select().from(plannedRuns).where(eq(plannedRuns.status, 'running')).all();
    for (const p of active) {
      db.transaction((tx) => {
        if (p.runId === null) {
          // Claimed but no start recorded. If this process isn't starting it, it was interrupted
          // mid-launch (crash, restart, or a Cloudflare deploy evicting the Durable Object), maybe
          // after the command went out. Never send it again: wait for the poller/webhooks/history
          // to show what happened, then adopt that run or call it failed.
          if (this.launching.has(p.id)) return;
          if (now.getTime() - p.updatedAt.getTime() > 5 * 60_000) {
            this.settleInterrupted(tx, p, now);
          }
          return;
        }
        const run = tx.select().from(runs).where(eq(runs.id, p.runId)).get();
        const startedAt = p.startedAt ?? now;
        const dueEnd = startedAt.getTime() + p.seconds * 1000;
        if (run?.endedAt) {
          // The poller closes runs when it notices, which can be long after (e.g. after downtime).
          const endedAt = new Date(Math.min(run.endedAt.getTime(), dueEnd));
          update(tx, p.id, { status: RUN_TO_PLANNED[run.status], endedAt }, now);
          return;
        }
        if (now.getTime() < dueEnd + this.o.finishGraceMs) return;
        // Time is up and the poller hasn't closed it (it may not be running). LinkTap stops
        // instant runs on its own, so call it done.
        const endedAt = new Date(dueEnd);
        if (run) {
          closeRun(tx, run, endedAt, 'completed');
          tx.update(devices).set({ watering: null }).where(eq(devices.id, p.deviceId)).run();
        }
        update(tx, p.id, { status: 'done', endedAt }, now);
      });
    }
  }

  private settleInterrupted(tx: Db, p: PlannedRunRow, now: Date): void {
    // Only a run that can be this launch: started within the launch window (a start, rate-limit
    // retries and one re-send fit in 2 min), not someone else's (no schedule, not ours), and with
    // our duration if it has one. Anything else, or more than one candidate, is not adopted.
    const claimedAt = p.updatedAt.getTime();
    const candidates = tx
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.deviceId, p.deviceId),
          gte(runs.startedAt, new Date(claimedAt - 5_000)),
          lte(runs.startedAt, new Date(claimedAt + LAUNCH_WINDOW_MS)),
          ne(runs.source, 'hoseidon'),
          isNull(runs.scheduleId),
          or(isNull(runs.plannedSec), eq(runs.plannedSec, p.seconds)),
        ),
      )
      .orderBy(asc(runs.startedAt))
      .limit(2)
      .all();
    const seen = candidates.length === 1 ? candidates[0] : undefined;
    if (!seen) {
      update(tx, p.id, { status: 'failed', error: 'Interrupted while starting' }, now);
      return;
    }
    tx.update(runs)
      .set({ source: 'hoseidon', scheduleId: p.scheduleId, plannedSec: p.seconds })
      .where(eq(runs.id, seen.id))
      .run();
    update(tx, p.id, { runId: seen.id, startedAt: seen.startedAt }, now);
    insertEvents(tx, [
      {
        at: now,
        type: 'schedule.run_unverified',
        source: 'hoseidon',
        severity: 'warn',
        gatewayId: p.gatewayId,
        deviceId: p.deviceId,
        title: 'A scheduled start was interrupted',
        message: 'Hoseidon restarted while starting this run; LinkTap shows it ran.',
        data: { scheduleId: p.scheduleId, plannedRunId: p.id, runId: seen.id },
      },
    ]);
  }

  // ---- 2. materialize -------------------------------------------------------------------------

  private materialize(now: Date, onlyScheduleId?: number): void {
    const { db, executor } = this.o;
    const where = onlyScheduleId
      ? and(eq(schedules.enabled, true), eq(schedules.id, onlyScheduleId))
      : eq(schedules.enabled, true);
    const list = db.select().from(schedules).where(where).all();
    if (!list.length) return;
    const devs = new Map(
      db
        .select({ id: devices.id, gatewayId: devices.gatewayId })
        .from(devices)
        .all()
        .map((d) => [d.id, d]),
    );
    const to = new Date(now.getTime() + this.o.horizonMs);

    for (const s of list) {
      // Look back a day so occurrences missed during downtime are recorded as skipped.
      const from = new Date(Math.max(now.getTime() - 86_400_000, s.effectiveFrom.getTime()));
      let occurrences: Date[];
      try {
        occurrences = expandOccurrences(s, from, to, 200);
      } catch (err) {
        this.o.log?.(`scheduler: schedule ${s.id}: ${(err as Error).message}`);
        continue;
      }
      // Devices that disappeared can't be planned (and fail the FK); the API warns about them.
      const items = s.items.filter((i) => devs.has(i.deviceId));
      if (!items.length) continue;
      const rows = occurrences.flatMap((occurrenceAt) =>
        planOccurrence({
          items,
          cycleSoak: s.cycleSoak,
          sequential: s.sequential,
          occurrenceAt,
          gatewayOf: (id) => devs.get(id)?.gatewayId ?? null,
          quantize: (sec, id) => executor.quantize(devs.get(id) ?? null, sec),
        }).map((slot) => ({
          scheduleId: s.id,
          deviceId: slot.deviceId,
          gatewayId: slot.gatewayId!,
          occurrenceAt,
          seq: slot.seq,
          cycle: slot.cycle,
          plannedAt: slot.start,
          baseSeconds: slot.baseSeconds,
          seconds: slot.seconds,
          status: 'planned' as const,
          updatedAt: now,
        })),
      );
      if (rows.length) db.insert(plannedRuns).values(rows).onConflictDoNothing().run();
    }
  }

  // ---- 3. missed while down -------------------------------------------------------------------

  /** Occurrences that never began and are past the catch-up window are skipped as missed. */
  private skipMissedOccurrences(now: Date): void {
    const { db } = this.o;
    const cutoff = new Date(now.getTime() - this.o.catchUpMs);
    const stale = db
      .select()
      .from(plannedRuns)
      .where(
        and(
          eq(plannedRuns.status, 'planned'),
          isNull(plannedRuns.weatherCheckedAt),
          lt(plannedRuns.occurrenceAt, cutoff),
        ),
      )
      .all();
    if (!stale.length) return;
    const scheds = this.schedulesById(stale.map((r) => r.scheduleId));
    const events: NewEvent[] = [];
    const seen = new Set<string>();
    db.transaction((tx) => {
      for (const r of stale) {
        const s = scheds.get(r.scheduleId);
        const when = localTime(r.occurrenceAt, s?.timezone ?? 'UTC');
        update(
          tx,
          r.id,
          { status: 'skipped', skipReason: `Missed (${when}): Hoseidon was offline` },
          now,
        );
        if (!seen.has(groupKey(r))) {
          seen.add(groupKey(r));
          events.push({
            at: now,
            type: 'schedule.missed',
            source: 'hoseidon',
            severity: 'warn',
            gatewayId: r.gatewayId,
            deviceId: null,
            title: `${s?.name ?? 'Schedule'}: missed the ${when} run`,
            message: 'Hoseidon was offline when it was due.',
            data: { scheduleId: r.scheduleId, occurrenceAt: r.occurrenceAt.toISOString() },
          });
        }
      }
      insertEvents(tx, events);
    });
  }

  // ---- 4. skip rules / ET scaling -------------------------------------------------------------

  private async applySkipRules(now: Date): Promise<void> {
    const { db, weather, executor } = this.o;
    const due = db
      .select()
      .from(plannedRuns)
      .where(
        and(
          eq(plannedRuns.status, 'planned'),
          isNull(plannedRuns.weatherCheckedAt),
          lt(plannedRuns.occurrenceAt, new Date(now.getTime() + 1)),
        ),
      )
      .all();
    if (!due.length) return;
    const scheds = this.schedulesById(due.map((r) => r.scheduleId));
    const gws = new Map(
      db
        .select()
        .from(gateways)
        .all()
        .map((g) => [g.id, g]),
    );
    const devs = new Map(
      db
        .select()
        .from(devices)
        .all()
        .map((d) => [d.id, d]),
    );

    // Weather is per gateway location, so decide per (occurrence, gateway).
    const groups = new Map<string, PlannedRunRow[]>();
    for (const r of due) {
      const key = `${groupKey(r)}|${r.gatewayId}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    const outlooks = new Map<string, Awaited<ReturnType<WeatherProvider['outlook']>>>();

    for (const rows of groups.values()) {
      const first = rows[0]!;
      const s = scheds.get(first.scheduleId);
      if (!s) continue;
      const gw = gws.get(first.gatewayId);
      const r = s.skipRules;
      const wantsWeather =
        r.rainForecastMm !== null || r.freezeC !== null || r.windKph !== null || r.etScaling;
      let outlook = null;
      if (wantsWeather && gw?.lat != null && gw.lon != null) {
        if (!outlooks.has(gw.id)) {
          try {
            outlooks.set(
              gw.id,
              await weather.outlook(
                { lat: gw.lat, lon: gw.lon, timezone: gw.timezone ?? s.timezone },
                now,
              ),
            );
          } catch (err) {
            this.o.log?.(`scheduler: weather for ${gw.id}: ${(err as Error).message}`);
            outlooks.set(gw.id, null);
          }
        }
        outlook = outlooks.get(gw.id) ?? null;
      }
      const decision = evaluateSkipRules(r, outlook);

      db.transaction((tx) => {
        for (const row of rows) {
          if (decision.skip) {
            update(
              tx,
              row.id,
              { status: 'skipped', skipReason: decision.skip, weatherCheckedAt: now },
              now,
            );
          } else {
            const dev = devs.get(row.deviceId) ?? null;
            update(
              tx,
              row.id,
              {
                weatherCheckedAt: now,
                scale: decision.scale,
                seconds: executor.quantize(dev, row.baseSeconds * decision.scale),
              },
              now,
            );
          }
        }
        if (decision.skip) {
          insertEvents(tx, [
            {
              at: now,
              type: 'schedule.skipped',
              source: 'hoseidon',
              severity: 'info',
              gatewayId: first.gatewayId,
              deviceId: null,
              title: `${s.name}: skipped`,
              message: decision.skip,
              data: { scheduleId: s.id, occurrenceAt: first.occurrenceAt.toISOString() },
            },
          ]);
        }
      });
    }
  }

  // ---- 5. start -------------------------------------------------------------------------------

  /** Start ready runs one at a time, re-reading state after each (it changes what's ready). */
  private async startReady(recovering: boolean): Promise<void> {
    for (let i = 0; i < 50; i++) {
      const now = new Date();
      const next = this.pickNext(now, recovering);
      if (!next) return;
      await this.launch(next.row, next.schedule, next.device, now);
    }
  }

  /** Apply readiness rules; skips what can't run as a side effect. Returns the next run to start. */
  private pickNext(
    now: Date,
    recovering: boolean,
  ): { row: PlannedRunRow; schedule: ScheduleRow; device: DeviceRow } | null {
    const { db } = this.o;
    const rows = db
      .select()
      .from(plannedRuns)
      .where(gte(plannedRuns.occurrenceAt, new Date(now.getTime() - LOOKBACK_MS)))
      .all();
    const candidates = rows.filter((r) => r.status === 'planned' && r.weatherCheckedAt !== null);
    if (!candidates.length) return null;

    const scheds = this.schedulesById(candidates.map((r) => r.scheduleId));
    const devs = new Map(
      db
        .select()
        .from(devices)
        .all()
        .map((d) => [d.id, d]),
    );
    const busyDevices = new Set(
      db
        .select({ deviceId: runs.deviceId })
        .from(runs)
        .where(eq(runs.status, 'running'))
        .all()
        .map((r) => r.deviceId),
    );
    for (const r of rows) if (r.status === 'running') busyDevices.add(r.deviceId);
    const busyGateways = new Set(
      [...busyDevices].flatMap((id) => {
        const g = devs.get(id)?.gatewayId;
        return g ? [g] : [];
      }),
    );

    const byGroup = new Map<string, PlannedRunRow[]>();
    for (const r of rows) byGroup.set(groupKey(r), [...(byGroup.get(groupKey(r)) ?? []), r]);

    // Oldest occurrence first, then lane order within it.
    candidates.sort(
      (a, b) => a.occurrenceAt.getTime() - b.occurrenceAt.getTime() || slotOrder(a, b),
    );
    for (const row of candidates) {
      const s = scheds.get(row.scheduleId);
      if (!s) continue;
      if (!s.enabled) {
        this.skip(row, 'Schedule turned off', now);
        return this.pickNext(now, recovering);
      }
      const group = byGroup.get(groupKey(row)) ?? [];
      const ready = readiness(row, group, s);
      if (ready.skip) {
        this.skip(row, ready.skip, now);
        return this.pickNext(now, recovering);
      }
      if (ready.at === null || ready.at > now.getTime()) continue;
      const late = now.getTime() - ready.at;
      if (recovering && late > this.o.catchUpMs) {
        this.skip(row, 'Missed: Hoseidon was offline', now);
        return this.pickNext(now, recovering);
      }
      const device = devs.get(row.deviceId);
      if (!device) continue;
      const blocked =
        busyDevices.has(device.id) || (s.sequential && busyGateways.has(row.gatewayId));
      if (blocked) {
        if (late > this.o.maxWaitMs) {
          this.skip(row, 'Gave up waiting: the gateway was busy', now);
          return this.pickNext(now, recovering);
        }
        continue;
      }
      if (!device.online) {
        this.skip(row, 'Device offline', now);
        return this.pickNext(now, recovering);
      }
      const alarm = BLOCKING_ALARMS.find((a) => device.alarms.includes(a));
      if (alarm) {
        this.skip(row, `Alarm: ${ALARM_LABELS[alarm]}`, now);
        return this.pickNext(now, recovering);
      }
      return { row, schedule: s, device };
    }
    return null;
  }

  private async launch(row: PlannedRunRow, s: ScheduleRow, device: DeviceRow, now: Date) {
    const { db } = this.o;
    // Claim the slot first so a concurrent skip/edit can't touch it mid-start.
    const claimed = db
      .update(plannedRuns)
      .set({ status: 'running', updatedAt: now })
      .where(and(eq(plannedRuns.id, row.id), eq(plannedRuns.status, 'planned')))
      .returning()
      .get();
    if (!claimed) return;
    this.launching.add(row.id);
    try {
      await this.launchClaimed(row, s, device);
    } finally {
      this.launching.delete(row.id);
    }
  }

  private async launchClaimed(row: PlannedRunRow, s: ScheduleRow, device: DeviceRow) {
    const { db, executor } = this.o;
    const ref = { id: device.id, gatewayId: device.gatewayId };
    const seenStops = this.stopSeq;
    const stopped = () => (this.stoppedAt.get(device.id) ?? 0) > seenStops;
    let attempts = 0;
    try {
      const started = await startVerified(executor, ref, row.seconds, {
        onAttempt: (n) => (attempts = n),
        shouldAbort: stopped,
      });
      attempts = started.attempts;
      if (stopped()) {
        // Stop landed during the verify window; its command queued behind our start, so the
        // zone is already off. Don't record a run.
        throw new StartAbortedError();
      }
      const { startedAt } = started;
      db.transaction((tx) => {
        const run = recordStart(tx, {
          deviceId: device.id,
          seconds: row.seconds,
          now: startedAt,
          scheduleId: s.id,
        });
        update(tx, row.id, { runId: run.id, startedAt, attempts }, new Date());
        if (!started.verified) {
          // Accepted but unconfirmed: track it as running (it probably is; the poller and
          // history will settle it) and tell the user, rather than risk a second start.
          insertEvents(tx, [
            {
              at: new Date(),
              type: 'schedule.run_unverified',
              source: 'hoseidon',
              severity: 'warn',
              gatewayId: device.gatewayId,
              deviceId: device.id,
              title: `${s.name}: couldn't confirm ${displayName(device)} started`,
              message: started.note ?? null,
              data: { scheduleId: s.id, plannedRunId: row.id, runId: run.id },
            },
          ]);
        }
      });
      if (!started.verified) {
        this.o.log?.(`scheduler: ${s.name} / ${device.id}: start unverified (${started.note})`);
      }
    } catch (err) {
      if (err instanceof StartAbortedError) {
        this.o.db.transaction((tx) =>
          update(
            tx,
            row.id,
            { status: 'cancelled', skipReason: 'Stopped by you', attempts, endedAt: new Date() },
            new Date(),
          ),
        );
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      const at = new Date();
      db.transaction((tx) => {
        const run = tx
          .insert(runs)
          .values({
            deviceId: device.id,
            startedAt: at,
            endedAt: at,
            plannedSec: row.seconds,
            durationSec: 0,
            source: 'hoseidon',
            scheduleId: s.id,
            status: 'failed',
            note: message,
          })
          .returning()
          .get();
        update(
          tx,
          row.id,
          { status: 'failed', error: message, runId: run.id, endedAt: at, attempts },
          at,
        );
        insertEvents(tx, [
          {
            at,
            type: 'schedule.run_failed',
            source: 'hoseidon',
            severity: 'alert',
            gatewayId: device.gatewayId,
            deviceId: device.id,
            title: `${s.name}: ${displayName(device)} didn't start`,
            message,
            data: { scheduleId: s.id, plannedRunId: row.id },
          },
        ]);
      });
      this.o.log?.(`scheduler: ${s.name} / ${device.id}: ${message}`);
    }
  }

  private skip(row: PlannedRunRow, reason: string, now: Date) {
    this.o.db.transaction((tx) =>
      update(tx, row.id, { status: 'skipped', skipReason: reason }, now),
    );
  }

  private schedulesById(ids: number[]): Map<number, ScheduleRow> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    return new Map(
      this.o.db
        .select()
        .from(schedules)
        .where(inArray(schedules.id, unique))
        .all()
        .map((s) => [s.id, s]),
    );
  }
}

type Tx = Pick<Db, 'update'>;

function update(tx: Tx, id: number, values: Partial<Omit<PlannedRunRow, 'id'>>, now: Date): void {
  tx.update(plannedRuns)
    .set({ ...values, updatedAt: now })
    .where(eq(plannedRuns.id, id))
    .run();
}

/**
 * When `row` may start: after its occurrence time, once every run ahead of it in its lane is
 * finished, and (for cycle 2+) once its previous cycle has soaked. `at: null` = not yet known.
 * `skip` = it can never run (its previous cycle didn't happen).
 */
export function readiness(
  row: PlannedRunRow,
  group: PlannedRunRow[],
  s: Pick<ScheduleRow, 'sequential' | 'cycleSoak'>,
): { at: number | null; skip?: string } {
  const lane = laneOf({
    sequential: s.sequential,
    gatewayId: row.gatewayId,
    deviceId: row.deviceId,
  });
  let at = row.occurrenceAt.getTime();

  const prev = group.find((r) => r.seq === row.seq && r.cycle === row.cycle - 1);
  if (prev) {
    if (!TERMINAL.has(prev.status)) return { at: null };
    if (prev.status !== 'done') {
      return { at: null, skip: prev.skipReason ?? `Previous cycle ${prev.status}` };
    }
    const soakMs = (s.cycleSoak?.soakMinutes ?? 0) * 60_000;
    at = Math.max(at, (prev.endedAt?.getTime() ?? 0) + soakMs);
  }
  for (const r of group) {
    if (r.id === row.id || slotOrder(r, row) >= 0) continue;
    if (
      laneOf({ sequential: s.sequential, gatewayId: r.gatewayId, deviceId: r.deviceId }) !== lane
    ) {
      continue;
    }
    if (!TERMINAL.has(r.status)) return { at: null };
    if (r.endedAt) at = Math.max(at, r.endedAt.getTime());
  }
  return { at };
}
