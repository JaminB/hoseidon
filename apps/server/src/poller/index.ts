import { and, eq, gt, isNotNull, or } from 'drizzle-orm';
import type { Db } from '../db/types';
import { devices, gateways, runs } from '../db/schema';
import { isRateLimitError, LINKTAP_LIMITS, type LinkTapClient } from '../linktap/client';
import { resolveGatewayLocation } from '../linktap/location';
import { ingestDevices, ingestHistory, ingestWateringStatus } from './ingest';

export interface PollerIntervals {
  devicesMs: number;
  statusMs: number;
  historyMs: number;
  /** After a status poll sees a run end, fetch that outlet's history this much later. */
  reconcileMs: number;
}

/**
 * Matches LinkTap's limits: getAllDevices 5 min, status 31 s (per outlet, while something
 * runs), history 10 min. A finished run shows up in history about a second after it ends.
 */
export const DEFAULT_INTERVALS: PollerIntervals = {
  devicesMs: 5 * 60_000,
  statusMs: LINKTAP_LIMITS.status.intervalMs,
  historyMs: 10 * 60_000,
  reconcileMs: 5_000,
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
  /** fetch used for geocoding LinkTap's gateway location (tests and mock mode stub it). */
  fetch?: typeof fetch;
  /**
   * Hand the post-run history reconcile to the host instead of a setTimeout (the Cloudflare
   * alarm wheel persists it, so it survives an eviction). When set it is used even without
   * start(); the host then calls reconcileHistory(deviceId) at `at`.
   */
  scheduleReconcile?: (deviceId: string, at: Date) => void;
  /** The host drives the tasks (alarm wheel) instead of start(); status() reports running. */
  external?: boolean;
}

/**
 * Keeps the database in step with LinkTap. Each task can be called directly (tests, "refresh"
 * buttons); start() runs them on intervals. Ticks of the same task never overlap.
 */
export class Poller {
  private readonly intervals: PollerIntervals;
  private readonly timers: NodeJS.Timeout[] = [];
  private startup: NodeJS.Timeout | undefined;
  /** Last history attempt per device (success or not), so one failing device can't hog the turn. */
  private readonly historyAttempts = new Map<string, number>();
  private readonly busy = new Set<Task>();
  /** Last status poll per device, so outlets are polled least-recently-first. */
  private readonly statusPolledAt = new Map<string, number>();
  private readonly reconcileTimers = new Set<NodeJS.Timeout>();
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
    this.startup = setTimeout(() => void this.pollHistoryNext(), 10_000);
    for (const t of [...this.timers, this.startup]) t.unref();
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
    if (this.startup) clearTimeout(this.startup);
    this.startup = undefined;
    for (const t of this.reconcileTimers) clearTimeout(t);
    this.reconcileTimers.clear();
  }

  status(): PollerStatus {
    return {
      running: this.timers.length > 0 || !!this.opts.external,
      last: structuredClone(this.last),
    };
  }

  /** getAllDevices -> gateways, devices, snapshots, runs, derived events. */
  pollDevices(): Promise<void> {
    return this.guard('devices', async () => {
      const polled = await this.opts.client.getAllDevices();
      ingestDevices(this.opts.db, polled, new Date());
      await this.resolveLocations();
    });
  }

  /**
   * Turn each gateway's LinkTap location string into lat/lon/time zone. Cheap when nothing
   * changed: a gateway is only geocoded when its location string differs from the last attempt
   * and the user hasn't set one by hand. Failures are logged and never fail the poll.
   */
  async resolveLocations(): Promise<void> {
    const { db, log } = this.opts;
    for (const g of db.select({ id: gateways.id }).from(gateways).all()) {
      try {
        await resolveGatewayLocation(db, g.id, { fetch: this.opts.fetch, log });
      } catch (err) {
        log?.(`gateway ${g.id}: location lookup failed: ${(err as Error).message}`);
      }
    }
  }

  /**
   * getWateringStatus for the devices that are (or we think are) watering. LinkTap allows one
   * status call per 30 s for the whole account, so outlets take turns: least recently polled
   * first, and after the first call only devices whose slot is already free (normally none, so
   * one device per tick). The scheduler's start check jumps this queue (priority).
   * A rate-limit rejection is not a device failure: the turn just ends and the next tick retries.
   */
  pollRunning(): Promise<void> {
    return this.guard('status', async () => {
      const { db, client } = this.opts;
      const active = db
        .selectDistinct({ id: devices.id, gatewayId: devices.gatewayId })
        .from(devices)
        .leftJoin(runs, and(eq(runs.deviceId, devices.id), eq(runs.status, 'running')))
        .where(or(isNotNull(devices.watering), isNotNull(runs.id)))
        .all();
      const ids = new Set(active.map((d) => d.id));
      for (const id of this.statusPolledAt.keys()) if (!ids.has(id)) this.statusPolledAt.delete(id);
      const polledAt = (id: string) => this.statusPolledAt.get(id) ?? 0;
      active.sort((a, b) => polledAt(a.id) - polledAt(b.id));

      let failure: unknown;
      for (const d of active) {
        // Each outlet has its own 30 s status lane; skip outlets whose lane is still cooling down.
        if (client.nextAvailableAt('status', d.id).getTime() > Date.now()) continue;
        this.statusPolledAt.set(d.id, Date.now());
        try {
          const sampledAt = new Date();
          const watering = await client.getWateringStatus({
            gatewayId: d.gatewayId,
            taplinkerId: d.id,
          });
          const { closed } = ingestWateringStatus(db, d.id, watering, new Date(), sampledAt);
          if (closed) this.scheduleReconcile(d.id);
        } catch (err) {
          if (isRateLimitError(err)) {
            this.opts.log?.(`poller status: rate limited, retrying next tick (${d.id})`);
            // Let this device go first next time.
            this.statusPolledAt.set(d.id, 0);
            continue;
          }
          failure ??= err;
        }
      }
      if (failure !== undefined) throw failure;
    });
  }

  /** While running, fetch a finished outlet's history shortly after its run ends. */
  private scheduleReconcile(deviceId: string) {
    if (this.opts.scheduleReconcile) {
      this.opts.scheduleReconcile(deviceId, new Date(Date.now() + this.intervals.reconcileMs));
      return;
    }
    if (!this.timers.length) return;
    const t = setTimeout(() => {
      this.reconcileTimers.delete(t);
      void this.reconcileHistory(deviceId).catch((err: unknown) =>
        this.opts.log?.(`poller history ${deviceId}: ${(err as Error).message}`),
      );
    }, this.intervals.reconcileMs);
    t.unref();
    this.reconcileTimers.add(t);
  }

  /**
   * Fetch one device's history now, if its (per-taplinker) history slot is free; otherwise leave
   * it to the regular rotation, which puts recently finished devices first. Returns whether it
   * fetched.
   */
  async reconcileHistory(deviceId: string): Promise<boolean> {
    const { db, client } = this.opts;
    if (client.nextAvailableAt('history', deviceId).getTime() > Date.now() + 1_000) return false;
    const row = db
      .select({ id: devices.id, gatewayId: devices.gatewayId, timezone: gateways.timezone })
      .from(devices)
      .innerJoin(gateways, eq(gateways.id, devices.gatewayId))
      .where(eq(devices.id, deviceId))
      .get();
    if (!row) return false;
    this.historyAttempts.set(row.id, Date.now());
    const entries = await client.getWateringHistory(
      { gatewayId: row.gatewayId, taplinkerId: row.id },
      row.timezone ?? this.opts.timeZone,
    );
    ingestHistory(db, row.id, entries, new Date());
    return true;
  }

  /**
   * Fetch history for one device per tick, so the calls are staggered across the window. Devices
   * that finished a run since their last attempt go first, then whoever was tried longest ago.
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
        .all();
      const touched = (r: (typeof rows)[number]) =>
        Math.max(r.fetchedAt?.getTime() ?? 0, this.historyAttempts.get(r.id) ?? 0);
      // Stable sort: least recently touched first (never-fetched devices are 0). Skip outlets
      // whose own history slot is still cooling down (a reconcile or start check just used it):
      // background polling never waits in the queue.
      const free = (r: (typeof rows)[number]) =>
        client.nextAvailableAt('history', r.id).getTime() <= Date.now() + 1_000;
      const ordered = rows.filter(free).sort((a, b) => touched(a) - touched(b));

      const recentlyFinished = ordered.find(
        (r) =>
          touched(r) > 0 &&
          db
            .select({ id: runs.id })
            .from(runs)
            .where(and(eq(runs.deviceId, r.id), gt(runs.endedAt, new Date(touched(r)))))
            .get() !== undefined,
      );
      const pick = recentlyFinished ?? ordered[0];
      if (!pick) return;
      this.historyAttempts.set(pick.id, Date.now());

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
