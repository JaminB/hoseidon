import { and, eq, gte, inArray, lt, ne, sql } from 'drizzle-orm';
import {
  classifySkipReason,
  SKIP_REASONS,
  type AnalyticsDay,
  type AnalyticsSummary,
  type SkipReasonKind,
} from '@hoseidon/shared';
import type { Db } from '../db';
import { plannedRuns, runs } from '../db/schema';
import { fromWall, parseLocal } from '../schedule/time';
import { addDays, dateInZone, dateRange } from '../weather/dates';

export interface AnalyticsDevice {
  id: string;
  name: string;
}

/** Skip kinds that count as water saved: the weather decided, not you or a server outage. */
const WEATHER_SKIPS: ReadonlySet<SkipReasonKind> = new Set(['rain', 'freeze', 'wind']);

/** The instant a local date starts in `timeZone`. */
const startOf = (date: string, timeZone: string) => fromWall(parseLocal(`${date}T00:00`), timeZone);

interface Bucket {
  volumeMl: number;
  durationSec: number;
  runs: number;
  /** Volume and time over runs that reported both, for the flow average. */
  flowMl: number;
  flowSec: number;
  skipped: number;
}
const emptyBucket = (): Bucket => ({
  volumeMl: 0,
  durationSec: 0,
  runs: 0,
  flowMl: 0,
  flowSec: 0,
  skipped: 0,
});

const mlPerMin = (ml: number, sec: number) => (sec > 0 ? Math.round((ml / sec) * 60) : null);

/**
 * Daily water use, run counts, flow, skips and estimated savings for some devices over the local
 * dates `from`..`to` (inclusive) in `timeZone`.
 */
export function analyze(
  db: Db,
  devs: AnalyticsDevice[],
  from: string,
  to: string,
  timeZone: string,
): AnalyticsSummary {
  const ids = devs.map((d) => d.id);
  const lo = startOf(from, timeZone);
  const hi = startOf(addDays(to, 1), timeZone);
  const localDate = (d: Date) => dateInZone(d, timeZone);

  const days = new Map<string, Bucket>(dateRange(from, to).map((d) => [d, emptyBucket()]));
  const perDevice = new Map<string, Bucket>(ids.map((id) => [id, emptyBucket()]));
  const total = emptyBucket();

  const runRows = ids.length
    ? db
        .select()
        .from(runs)
        .where(and(inArray(runs.deviceId, ids), gte(runs.startedAt, lo), lt(runs.startedAt, hi)))
        .all()
    : [];
  for (const r of runRows) {
    // A run still in progress has no final duration or volume yet.
    if (r.status === 'skipped' || r.status === 'running') continue;
    const day = days.get(localDate(r.startedAt));
    const dev = perDevice.get(r.deviceId);
    if (!day || !dev) continue;
    const sec = r.durationSec ?? 0;
    const ml = r.volumeMl ?? 0;
    for (const b of [day, dev, total]) {
      b.runs += 1;
      b.durationSec += sec;
      b.volumeMl += ml;
      if (ml > 0 && sec > 0) {
        b.flowMl += ml;
        b.flowSec += sec;
      }
    }
  }

  const planned = ids.length
    ? db
        .select()
        .from(plannedRuns)
        .where(
          and(
            inArray(plannedRuns.deviceId, ids),
            gte(plannedRuns.occurrenceAt, lo),
            lt(plannedRuns.occurrenceAt, hi),
            ne(plannedRuns.status, 'planned'),
          ),
        )
        .all()
    : [];
  const kinds = new Map<SkipReasonKind, number>();
  let skippedRuns = 0;
  let savedSec = 0;
  let savedMl = 0;
  let savedMlKnown = true;
  const flowCache = new Map<string, number | null>();
  const flowOf = (deviceId: string) => {
    if (!flowCache.has(deviceId)) flowCache.set(deviceId, mlPerSecond(db, deviceId, perDevice));
    return flowCache.get(deviceId) ?? null;
  };
  const save = (deviceId: string, seconds: number) => {
    savedSec += seconds;
    const flow = flowOf(deviceId);
    if (flow === null) savedMlKnown = false;
    else savedMl += seconds * flow;
  };
  for (const p of planned) {
    if (p.status === 'skipped') {
      const kind = classifySkipReason(p.skipReason);
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      const day = days.get(localDate(p.occurrenceAt));
      if (day) day.skipped += 1;
      perDevice.get(p.deviceId)!.skipped += 1;
      total.skipped += 1;
      if (WEATHER_SKIPS.has(kind)) {
        skippedRuns += 1;
        save(p.deviceId, p.baseSeconds);
      }
    } else if (p.status === 'done' && p.scale < 1) {
      save(p.deviceId, Math.max(0, p.baseSeconds - p.seconds));
    }
  }

  const dayRows: AnalyticsDay[] = [...days].map(([date, b]) => ({
    date,
    volumeMl: Math.round(b.volumeMl),
    durationSec: b.durationSec,
    runs: b.runs,
    avgFlowMlMin: mlPerMin(b.flowMl, b.flowSec),
    skipped: b.skipped,
  }));

  return {
    from,
    to,
    timezone: timeZone,
    days: dayRows,
    totals: {
      volumeMl: Math.round(total.volumeMl),
      durationSec: total.durationSec,
      runs: total.runs,
      skipped: total.skipped,
      avgFlowMlMin: mlPerMin(total.flowMl, total.flowSec),
    },
    hasFlow: total.flowMl > 0,
    skipReasons: SKIP_REASONS.filter((k) => kinds.has(k)).map((kind) => ({
      kind,
      count: kinds.get(kind)!,
    })),
    saved: {
      skippedRuns,
      seconds: Math.round(savedSec),
      volumeMl: savedSec > 0 && !savedMlKnown ? null : Math.round(savedMl),
    },
    devices: devs.map((d) => {
      const b = perDevice.get(d.id)!;
      return {
        deviceId: d.id,
        name: d.name,
        volumeMl: Math.round(b.volumeMl),
        durationSec: b.durationSec,
        runs: b.runs,
      };
    }),
  };
}

/**
 * Average flow of a device in ml/s: this range if it has volume data, else its whole history.
 * Null when the device has never reported a volume.
 */
function mlPerSecond(db: Db, deviceId: string, inRange: Map<string, Bucket>): number | null {
  const b = inRange.get(deviceId);
  if (b && b.flowSec > 0) return b.flowMl / b.flowSec;
  const row = db
    .select({
      ml: sql<number>`coalesce(sum(${runs.volumeMl}), 0)`,
      sec: sql<number>`coalesce(sum(${runs.durationSec}), 0)`,
    })
    .from(runs)
    .where(
      and(eq(runs.deviceId, deviceId), sql`${runs.volumeMl} > 0`, sql`${runs.durationSec} > 0`),
    )
    .get();
  return row && row.sec > 0 && row.ml > 0 ? row.ml / row.sec : null;
}
