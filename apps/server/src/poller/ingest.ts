import { and, desc, eq, gte, lte, ne } from 'drizzle-orm';
import type { AlarmFlag, EventSeverity, RunSource, RunStatus, Watering } from '@hoseidon/shared';
import type { Db } from '../db/types';
import {
  devices,
  deviceSnapshots,
  events,
  gateways,
  runs,
  type DeviceRow,
  type NewEvent,
} from '../db/schema';
import type { HistoryEntry, NormalizedGateway } from '../linktap/normalize';
import { baseId } from '../linktap/normalize';
import { readWeakSignalPct } from '../network/settings';

export const THRESHOLDS = {
  batteryLowPct: 20,
};

/** History records within this window of a known run are the same run. */
const RUN_MATCH_WINDOW_MS = 120_000;
/**
 * getWateringStatus can report null for a while right after an accepted start: live, an outlet
 * answered null 12 s after "ok" and still ran. Don't close a run on a null this young.
 */
export const START_GRACE_MS = 60_000;

const displayName = (row: { name: string | null; linktapName: string }) =>
  row.name ?? row.linktapName;

function formatDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}

export function insertEvents(db: Pick<Db, 'insert'>, rows: NewEvent[]): void {
  if (rows.length) db.insert(events).values(rows).run();
}

// ---- getAllDevices ------------------------------------------------------------------------------

/**
 * Upsert gateways and devices from a getAllDevices poll, write one snapshot per device, keep runs
 * in step with what LinkTap reports as watering, and derive transition events. Returns the events.
 */
export function ingestDevices(db: Db, polled: NormalizedGateway[], now: Date): NewEvent[] {
  const derived: NewEvent[] = [];
  const ev = (e: Omit<NewEvent, 'at' | 'source'>) =>
    derived.push({ at: now, source: 'poller', ...e });

  db.transaction((tx) => {
    const weakSignalPct = readWeakSignalPct(tx);
    for (const gw of polled) {
      const prev = tx.select().from(gateways).where(eq(gateways.id, gw.id)).get();
      const values = {
        linktapName: gw.name,
        status: gw.status,
        online: gw.online,
        raw: gw.raw,
        version: gw.version,
        locationRaw: gw.location,
        updatedAt: now,
        ...(gw.online ? { lastSeenAt: now } : {}),
      };
      tx.insert(gateways)
        .values({ id: gw.id, ...values })
        .onConflictDoUpdate({ target: gateways.id, set: values })
        .run();

      if (prev && prev.online !== gw.online) {
        const name = prev.name ?? gw.name;
        if (gw.online) {
          const away = prev.lastSeenAt ? now.getTime() - prev.lastSeenAt.getTime() : null;
          ev({
            type: 'gateway.online',
            severity: 'info',
            gatewayId: gw.id,
            title: `${name} is back online`,
            message: away !== null ? `Offline for about ${formatDuration(away)}` : null,
          });
        } else {
          ev({
            type: 'gateway.offline',
            severity: 'alert',
            gatewayId: gw.id,
            title: `${name} went offline`,
            message: prev.lastSeenAt ? `Last seen ${prev.lastSeenAt.toISOString()}` : null,
          });
        }
      }

      for (const t of gw.taplinkers) {
        const old = tx.select().from(devices).where(eq(devices.id, t.id)).get();
        const online = gw.online && t.online;
        const set = {
          gatewayId: gw.id,
          outlet: t.outlet,
          linktapName: t.name,
          status: t.status,
          online,
          batteryPct: t.batteryPct,
          signalPct: t.signalPct,
          workMode: t.workMode,
          alarms: t.alarms,
          watering: t.watering,
          dType: t.dType,
          flowMeter: t.flowMeter,
          flowMlPerMin: t.flowMlPerMin,
          plan: t.plan,
          updatedAt: now,
          ...(online ? { lastSeenAt: now } : {}),
        };
        tx.insert(devices)
          .values({ id: t.id, ...set })
          .onConflictDoUpdate({ target: devices.id, set })
          .run();

        tx.insert(deviceSnapshots)
          .values({
            deviceId: t.id,
            at: now,
            status: t.status,
            online,
            batteryPct: t.batteryPct,
            signalPct: t.signalPct,
            workMode: t.workMode,
            watering: t.watering !== null,
            flowMlPerMin: t.flowMlPerMin,
            alarms: t.alarms,
            raw: t.raw,
          })
          .run();

        syncRunWithWatering(tx, t.id, t.watering, now);
        if (old) deriveDeviceEvents(old, { ...set, id: t.id }, now, ev, weakSignalPct);
      }
    }
    // Same transaction: if the events fail, the state change rolls back and the next poll
    // sees the transition again.
    insertEvents(tx, derived);
  });
  return derived;
}

type DeviceState = Pick<
  DeviceRow,
  'id' | 'gatewayId' | 'online' | 'signalPct' | 'batteryPct' | 'alarms' | 'linktapName'
>;

function deriveDeviceEvents(
  old: DeviceRow,
  cur: DeviceState,
  now: Date,
  ev: (e: Omit<NewEvent, 'at' | 'source'>) => void,
  weakSignalPct: number,
) {
  const name = old.name ?? cur.linktapName;
  const base = { gatewayId: cur.gatewayId, deviceId: cur.id };

  if (old.online && !cur.online) {
    ev({
      ...base,
      type: 'device.offline',
      severity: 'warn',
      title: `${name} went offline`,
      message: old.lastSeenAt ? `Last seen ${old.lastSeenAt.toISOString()}` : null,
    });
  } else if (!old.online && cur.online) {
    const away = old.lastSeenAt ? now.getTime() - old.lastSeenAt.getTime() : null;
    ev({
      ...base,
      type: 'device.online',
      severity: 'info',
      title: `${name} is back online`,
      message: away !== null ? `Offline for about ${formatDuration(away)}` : null,
    });
  }

  // Signal only means something while the device is reachable.
  if (cur.online && old.online && old.signalPct !== null && cur.signalPct !== null) {
    const low = weakSignalPct;
    if (old.signalPct >= low && cur.signalPct < low) {
      ev({
        ...base,
        type: 'device.signal_low',
        severity: 'warn',
        title: `${name} has a weak signal`,
        message: `Signal dropped from ${old.signalPct}% to ${cur.signalPct}%`,
      });
    } else if (old.signalPct < low && cur.signalPct >= low) {
      ev({
        ...base,
        type: 'device.signal_ok',
        severity: 'info',
        title: `${name} signal recovered`,
        message: `Signal is ${cur.signalPct}%`,
      });
    }
  }

  if (
    old.batteryPct !== null &&
    cur.batteryPct !== null &&
    old.batteryPct >= THRESHOLDS.batteryLowPct &&
    cur.batteryPct < THRESHOLDS.batteryLowPct
  ) {
    ev({
      ...base,
      type: 'device.battery_low',
      severity: 'warn',
      title: `${name} battery is low`,
      message: `Battery at ${cur.batteryPct}%`,
    });
  }

  const before = new Set<AlarmFlag>(old.alarms);
  const after = new Set<AlarmFlag>(cur.alarms);
  for (const flag of after) {
    if (!before.has(flag)) {
      ev({
        ...base,
        type: 'device.alarm',
        severity: 'alert',
        title: `${name}: ${ALARM_LABELS[flag]}`,
        message: null,
        data: { alarm: flag },
      });
    }
  }
  for (const flag of before) {
    if (!after.has(flag)) {
      ev({
        ...base,
        type: 'device.alarm_cleared',
        severity: 'info',
        title: `${name}: ${ALARM_LABELS[flag]} cleared`,
        message: null,
        data: { alarm: flag },
      });
    }
  }
}

export const ALARM_LABELS: Record<AlarmFlag, string> = {
  noWater: 'no water',
  valveBroken: 'valve broken',
  fallFlag: 'device fell',
  leakFlag: 'leak detected',
  clogFlag: 'clog detected',
  pcFlag: 'water cut off',
  pbFlag: 'pipe burst',
  freezeFlag: 'freeze warning',
};

// ---- runs ---------------------------------------------------------------------------------------

export type Tx = Pick<Db, 'select' | 'insert' | 'update'>;

export function openRun(tx: Tx, deviceId: string) {
  return tx
    .select()
    .from(runs)
    .where(and(eq(runs.deviceId, deviceId), eq(runs.status, 'running')))
    .orderBy(desc(runs.startedAt))
    .get();
}

export function startRun(
  tx: Tx,
  opts: {
    deviceId: string;
    startedAt: Date;
    plannedSec: number | null;
    source: RunSource;
    scheduleId?: number | null;
  },
) {
  return tx
    .insert(runs)
    .values({ ...opts, scheduleId: opts.scheduleId ?? null, status: 'running' })
    .returning()
    .get();
}

/** A LinkTap-reported run this recent is taken to be the one Hoseidon is recording. */
const ADOPT_WINDOW_MS = 60_000;

/**
 * Bookkeeping for a run Hoseidon just started: close any open run on the device (a new instant
 * run replaces it), mark the device watering so the status poller picks it up, open the run.
 */
export function recordStart(
  tx: Tx,
  opts: { deviceId: string; seconds: number; now: Date; scheduleId?: number | null },
) {
  const open = openRun(tx, opts.deviceId);
  // LinkTap's wateringOn webhook (or a status poll) can beat us to recording our own start. That
  // run is this one, seen early: adopt it rather than closing it and opening a second.
  const adoptable =
    open !== undefined &&
    open.source !== 'hoseidon' &&
    Math.abs(opts.now.getTime() - open.startedAt.getTime()) <= ADOPT_WINDOW_MS &&
    (open.plannedSec === null || open.plannedSec === opts.seconds);
  if (open && !adoptable) closeRun(tx, open, opts.now, 'stopped');
  tx.update(devices)
    .set({
      watering: {
        remainingSec: opts.seconds,
        totalSec: opts.seconds,
        flowMlPerMin: null,
        volumeMl: null,
      },
    })
    .where(eq(devices.id, opts.deviceId))
    .run();
  if (open && adoptable) {
    return tx
      .update(runs)
      .set({ source: 'hoseidon', plannedSec: opts.seconds, scheduleId: opts.scheduleId ?? null })
      .where(eq(runs.id, open.id))
      .returning()
      .get();
  }
  return startRun(tx, {
    deviceId: opts.deviceId,
    startedAt: opts.now,
    plannedSec: opts.seconds,
    source: 'hoseidon',
    scheduleId: opts.scheduleId ?? null,
  });
}

export function closeRun(
  tx: Tx,
  run: { id: number; startedAt: Date; plannedSec: number | null },
  endedAt: Date,
  status: RunStatus,
  volumeMl?: number | null,
) {
  let durationSec = Math.max(0, Math.round((endedAt.getTime() - run.startedAt.getTime()) / 1000));
  if (run.plannedSec !== null) durationSec = Math.min(durationSec, run.plannedSec);
  return tx
    .update(runs)
    .set({ endedAt, durationSec, status, ...(volumeMl != null ? { volumeMl } : {}) })
    .where(eq(runs.id, run.id))
    .returning()
    .get();
}

/**
 * Keep the open run for a device in step with a watering report: open one if LinkTap says it's
 * watering and we don't know about it (a LinkTap plan or the app started it), close it when
 * watering stops.
 */
function syncRunWithWatering(
  tx: Tx,
  deviceId: string,
  watering: Watering | null,
  now: Date,
  sampledAt?: Date,
): 'opened' | 'updated' | 'closed' | null {
  const open = openRun(tx, deviceId);
  // A stale "still watering" sample must not reopen a run that closed while it was in flight.
  const closedSinceSample =
    sampledAt !== undefined &&
    tx
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.deviceId, deviceId), gte(runs.endedAt, sampledAt)))
      .get() !== undefined;
  if (watering && !open && !closedSinceSample) {
    const elapsed =
      watering.totalSec !== null && watering.remainingSec !== null
        ? Math.max(0, watering.totalSec - watering.remainingSec)
        : 0;
    startRun(tx, {
      deviceId,
      startedAt: new Date(now.getTime() - elapsed * 1000),
      plannedSec: watering.totalSec,
      source: 'linktap',
    });
    return 'opened';
  } else if (watering && open) {
    if (watering.volumeMl !== null) {
      tx.update(runs).set({ volumeMl: watering.volumeMl }).where(eq(runs.id, open.id)).run();
    }
    return 'updated';
  } else if (!watering && open) {
    if (now.getTime() - open.startedAt.getTime() < START_GRACE_MS) return null;
    closeRun(tx, open, now, 'completed');
    return 'closed';
  }
  return null;
}

/**
 * Result of a getWateringStatus poll for one device. `closed` is true when this report ended the
 * open run (the poller then fetches that outlet's history to fill in the real volume).
 */
export function ingestWateringStatus(
  db: Db,
  deviceId: string,
  watering: Watering | null,
  now: Date,
  /** When the status request was sent; guards against races with webhooks/stop commands. */
  sampledAt?: Date,
): { closed: boolean } {
  return db.transaction((tx) => {
    tx.update(devices).set({ watering, updatedAt: now }).where(eq(devices.id, deviceId)).run();
    return { closed: syncRunWithWatering(tx, deviceId, watering, now, sampledAt) === 'closed' };
  });
}

/** The gateway's own time zone (for reading its history), else `fallback`. */
export function gatewayTimeZone(db: Db, gatewayId: string, fallback: string): string {
  const row = db
    .select({ tz: gateways.timezone })
    .from(gateways)
    .where(eq(gateways.id, gatewayId))
    .get();
  return row?.tz ?? fallback;
}

/**
 * Evidence already in the database that `deviceId` started watering at or after `since`: a
 * getAllDevices snapshot showing it watering, or a run LinkTap told us about (webhook, status
 * poll, history). Used before deciding a start silently failed.
 */
export function hasStartEvidence(db: Db, deviceId: string, since: Date): boolean {
  const snapshot = db
    .select({ id: deviceSnapshots.id })
    .from(deviceSnapshots)
    .where(
      and(
        eq(deviceSnapshots.deviceId, deviceId),
        gte(deviceSnapshots.at, since),
        eq(deviceSnapshots.watering, true),
      ),
    )
    .get();
  if (snapshot) return true;
  const run = db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.deviceId, deviceId),
        gte(runs.startedAt, new Date(since.getTime() - 5_000)),
        ne(runs.source, 'hoseidon'),
      ),
    )
    .get();
  return run !== undefined;
}

/**
 * Merge getWateringHistory into runs. A record within two minutes of a known run fills in its
 * final duration and volume; anything else is a run we never saw (source "linktap").
 */
export function ingestHistory(
  db: Db,
  deviceId: string,
  entries: HistoryEntry[],
  now: Date,
): { added: number; updated: number } {
  let added = 0;
  let updated = 0;
  db.transaction((tx) => {
    for (const e of entries) {
      const endedAt = e.endedAt;
      // Skip a record that is still in progress; the status poller owns it.
      if (endedAt > now) continue;
      // Closest-starting run in the window that doesn't start after this record ended.
      const match = tx
        .select()
        .from(runs)
        .where(
          and(
            eq(runs.deviceId, deviceId),
            gte(runs.startedAt, new Date(e.startedAt.getTime() - RUN_MATCH_WINDOW_MS)),
            lte(
              runs.startedAt,
              new Date(Math.min(e.startedAt.getTime() + RUN_MATCH_WINDOW_MS, endedAt.getTime())),
            ),
          ),
        )
        .all()
        .sort(
          (a, b) =>
            Math.abs(a.startedAt.getTime() - e.startedAt.getTime()) -
            Math.abs(b.startedAt.getTime() - e.startedAt.getTime()),
        )[0];
      if (match) {
        if (
          match.status !== 'running' &&
          match.durationSec === e.durationSec &&
          match.volumeMl === e.volumeMl
        ) {
          continue;
        }
        tx.update(runs)
          .set({
            endedAt,
            durationSec: e.durationSec,
            volumeMl: e.volumeMl,
            mode: e.mode,
            status: match.status === 'running' ? 'completed' : match.status,
          })
          .where(eq(runs.id, match.id))
          .run();
        updated++;
      } else {
        tx.insert(runs)
          .values({
            deviceId,
            startedAt: e.startedAt,
            endedAt,
            plannedSec: null,
            durationSec: e.durationSec,
            volumeMl: e.volumeMl,
            mode: e.mode,
            source: 'linktap',
            status: 'completed',
          })
          .run();
        added++;
      }
    }
    tx.update(devices).set({ historyFetchedAt: now }).where(eq(devices.id, deviceId)).run();
  });
  return { added, updated };
}

// ---- webhooks -----------------------------------------------------------------------------------

export interface WebhookPayload {
  event: string;
  title?: string | null;
  content?: string | null;
  gatewayId?: string | null;
  deviceId?: string | null;
  workMode?: string | null;
  [key: string]: unknown;
}

function webhookSeverity(event: string): EventSeverity {
  const e = event.toLowerCase();
  if (/offline|broken|fall|freeze|nowater|leak|burst|cutoff|cut_off/.test(e)) return 'alert';
  if (/battery|flow|skip|clog/.test(e)) return 'warn';
  return 'info';
}

/**
 * Store a LinkTap webhook delivery and apply the side effects we can trust: online/offline
 * transitions and watering start/stop. Event names are matched loosely since LinkTap's exact
 * strings are not documented in one place.
 */
export function ingestWebhook(db: Db, payload: WebhookPayload, now: Date): NewEvent {
  const gatewayId = payload.gatewayId ? baseId(payload.gatewayId) : null;
  // Webhooks may name a multi-outlet device by its 16-char base id; resolve to known rows.
  const deviceRows: DeviceRow[] = payload.deviceId
    ? db
        .select()
        .from(devices)
        .all()
        .filter((d) => d.id === payload.deviceId || baseId(d.id) === payload.deviceId)
    : [];
  const target = deviceRows.length === 1 ? deviceRows[0] : undefined;
  const e = payload.event.toLowerCase();

  const row: NewEvent = {
    at: now,
    type: `linktap.${payload.event}`,
    source: 'webhook',
    severity: webhookSeverity(payload.event),
    gatewayId: gatewayId ?? target?.gatewayId ?? null,
    deviceId: target?.id ?? payload.deviceId ?? null,
    title:
      payload.title?.trim() ||
      (target ? `${displayName(target)}: ${payload.event}` : payload.event),
    message: payload.content ?? null,
    data: payload,
  };

  db.transaction((tx) => {
    tx.insert(events).values(row).run();
    const isGatewayEvent = e.includes('gateway');
    if (/offline/.test(e) || /online/.test(e)) {
      const online = !/offline/.test(e);
      const set = { online, ...(online ? { lastSeenAt: now } : {}) };
      if (isGatewayEvent && gatewayId) {
        tx.update(gateways).set(set).where(eq(gateways.id, gatewayId)).run();
        // Nothing behind an offline gateway is reachable. Coming back online is per device,
        // so leave that to the next poll.
        if (!online) {
          tx.update(devices).set({ online: false }).where(eq(devices.gatewayId, gatewayId)).run();
        }
      } else {
        for (const d of deviceRows) tx.update(devices).set(set).where(eq(devices.id, d.id)).run();
      }
    }
    if (target && /watering ?on|wateringon|watering_?start|wateringstart/.test(e)) {
      if (!openRun(tx, target.id)) {
        startRun(tx, {
          deviceId: target.id,
          startedAt: now,
          plannedSec: null,
          source: /manual|button/.test(e) ? 'manual' : 'linktap',
        });
      }
    } else if (target && /watering ?off|wateringoff|watering_?end|wateringend/.test(e)) {
      const open = openRun(tx, target.id);
      if (open) closeRun(tx, open, now, 'completed');
    }
  });
  return row;
}
