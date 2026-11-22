import { and, asc, eq, gt, isNotNull, or } from 'drizzle-orm';
import type { Db } from '../db';
import { devices, gateways, runs } from '../db/schema';
import type { LinkTapClient } from '../linktap/client';
import { ingestDevices, ingestHistory, ingestWateringStatus } from './ingest';

export interface PollerIntervals {
  devicesMs: number;
  statusMs: number;
  historyMs: number;
}

/** Matches LinkTap's limits: getAllDevices 5 min, status 30 s (while running), history 10 min. */
export const DEFAULT_INTERVALS: PollerIntervals = {
  devicesMs: 5 * 60_000,
  statusMs: 30_000,
  historyMs: 10 * 60_000,
};

type Task = 'devices' | 'status' | 'history';

export interface PollerStatus {
  running: boolean;
  last: Record<Task, { at: string | null; error: string | null }>;
}

export interface PollerOptions {
  db: Db;
  client: LinkTapClient;
  /** Fallback time zone for history when a gateway has none set. */
  timeZone: string;
  intervals?: Partial<PollerIntervals>;
  log?: (msg: string) => void;
}

/**
 * Keeps the database in step with LinkTap. Each task can be called directly (tests, "refresh"
 * buttons); start() runs them on intervals. Ticks of the same task never overlap.
 */
export class Poller {
  private readonly intervals: PollerIntervals;
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly busy = new Set<Task>();
  private readonly last: PollerStatus['last'] = {
    devices: { at: null, error: null },
    status: { at: null, error: null },
    history: { at: null, error: null },
  };

  constructor(private readonly opts: PollerOptions) {
    this.intervals = { ...DEFAULT_INTERVALS, ...opts.intervals };
  }

  start(): void {
    if (this.timers.length) return;
    void this.pollDevices();
    // Let the first device poll land before the first history fetch.
    this.timers.push(
      setInterval(() => void this.pollDevices(), this.intervals.devicesMs),
      setInterval(() => void this.pollRunning(), this.intervals.statusMs),
      setInterval(() => void this.pollHistoryNext(), this.intervals.historyMs),
    );
    setTimeout(() => void this.pollHistoryNext(), 10_000).unref();
    for (const t of this.timers) t.unref();
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
  }

  status(): PollerStatus {
    return { running: this.timers.length > 0, last: structuredClone(this.last) };
  }

  /** getAllDevices -> gateways, devices, snapshots, runs, derived events. */
  pollDevices(): Promise<void> {
    return this.guard('devices', async () => {
      const polled = await this.opts.client.getAllDevices();
      ingestDevices(this.opts.db, polled, new Date());
    });
  }

  /** getWateringStatus for each device that is (or we think is) watering. */
  pollRunning(): Promise<void> {
    return this.guard('status', async () => {
      const { db, client } = this.opts;
      const active = db
        .selectDistinct({ id: devices.id, gatewayId: devices.gatewayId })
        .from(devices)
        .leftJoin(runs, and(eq(runs.deviceId, devices.id), eq(runs.status, 'running')))
        .where(or(isNotNull(devices.watering), isNotNull(runs.id)))
        .all();
      const results = await Promise.allSettled(
        active.map(async (d) => {
          const watering = await client.getWateringStatus({
            gatewayId: d.gatewayId,
            taplinkerId: d.id,
          });
          ingestWateringStatus(db, d.id, watering, new Date());
        }),
      );
      const failed = results.find((r) => r.status === 'rejected');
      if (failed) throw failed.reason;
    });
  }

  /**
   * Fetch history for one device per tick, so the calls are staggered across the window. Devices
   * that finished a run since their last fetch go first, then whoever is most out of date.
   */
  pollHistoryNext(): Promise<void> {
    return this.guard('history', async () => {
      const { db, client } = this.opts;
      const rows = db
        .select({
          id: devices.id,
          gatewayId: devices.gatewayId,
          fetchedAt: devices.historyFetchedAt,
          timezone: gateways.timezone,
        })
        .from(devices)
        .innerJoin(gateways, eq(gateways.id, devices.gatewayId))
        .orderBy(asc(devices.historyFetchedAt))
        .all();
      if (!rows.length) return;

      const recentlyFinished = rows.find(
        (r) =>
          r.fetchedAt !== null &&
          db
            .select({ id: runs.id })
            .from(runs)
            .where(and(eq(runs.deviceId, r.id), gt(runs.endedAt, r.fetchedAt)))
            .get() !== undefined,
      );
      const never = rows.find((r) => r.fetchedAt === null);
      const pick = recentlyFinished ?? never ?? rows[0];
      if (!pick) return;

      const entries = await client.getWateringHistory(
        { gatewayId: pick.gatewayId, taplinkerId: pick.id },
        pick.timezone ?? this.opts.timeZone,
      );
      ingestHistory(db, pick.id, entries, new Date());
    });
  }

  private async guard(task: Task, fn: () => Promise<void>): Promise<void> {
    if (this.busy.has(task)) return;
    this.busy.add(task);
    try {
      await fn();
      this.last[task] = { at: new Date().toISOString(), error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.last[task] = { at: new Date().toISOString(), error: message };
      this.opts.log?.(`poller ${task}: ${message}`);
    } finally {
      this.busy.delete(task);
    }
  }
}
