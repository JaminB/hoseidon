import { chunkIds } from '../db/batch';
import { and, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import type { Db } from '../db/types';
import {
  devices,
  gateways,
  gcalEvents,
  plannedRuns,
  runs,
  schedules,
  type GcalEventRow,
  type PlannedRunRow,
} from '../db/schema';
import type { Executor } from '../schedule/executor';
import { GoogleApiError, newEventId, type CalendarApi, type GEvent } from './calendar';
import {
  hashOf,
  occurrenceLogEvent,
  runLogEvent,
  scheduleEvent,
  skipOverlay,
  type MapContext,
} from './mapping';

/**
 * One-way sync as a reconcile: build what the calendar should hold, diff it against what we last
 * pushed (gcal_events), and send only the difference. Re-running is always safe.
 */

const DAY = 86_400_000;
/** Skips and run logs older than this are left as they are in Google. */
export const WINDOW_MS = 14 * DAY;
/** Skips are annotated up to this far ahead (the engine plans 48 h out). */
const AHEAD_MS = 2 * DAY;

export type Kind = GcalEventRow['kind'];

export interface Desired {
  key: string;
  kind: Kind;
  at: Date | null;
  hash: string;
  /** Full event body (schedules and logs). */
  event?: GEvent;
  /** Instance annotation (skips). */
  skip?: {
    parentKey: string;
    occurrenceAt: Date;
    overlay: Pick<GEvent, 'summary' | 'description' | 'colorId'>;
  };
}

export type Op =
  | { type: 'insert'; item: Desired }
  | { type: 'update'; item: Desired; row: GcalEventRow }
  | { type: 'delete'; row: GcalEventRow };

export const scheduleKey = (id: number) => `schedule:${id}`;
const parentKeyOf = (skipKey: string) => `schedule:${skipKey.split(':')[1]}`;

const KIND_ORDER: Record<Kind, number> = { schedule: 0, skip: 1, log: 2 };

/**
 * Pure diff. A stored row that's no longer wanted is deleted when it's in scope: schedules always;
 * skips and logs only inside the sync window (older ones are history and stay put), except that
 * logs are all removed when run logging is turned off and skips go with their series.
 */
export function diffSync(
  desired: Desired[],
  existing: GcalEventRow[],
  opts: { windowStart: Date; logRuns: boolean },
): Op[] {
  const want = new Map(desired.map((d) => [d.key, d]));
  const have = new Map(existing.map((r) => [r.key, r]));
  const ops: Op[] = [];
  for (const item of desired) {
    const row = have.get(item.key);
    if (!row) ops.push({ type: 'insert', item });
    else if (row.hash !== item.hash) ops.push({ type: 'update', item, row });
  }
  for (const row of existing) {
    if (want.has(row.key)) continue;
    const inWindow = !row.at || row.at >= opts.windowStart;
    const inScope =
      row.kind === 'schedule' ||
      inWindow ||
      (row.kind === 'log' && !opts.logRuns) ||
      (row.kind === 'skip' && !want.has(parentKeyOf(row.key)));
    if (inScope) ops.push({ type: 'delete', row });
  }
  const kindOf = (op: Op) => (op.type === 'delete' ? op.row.kind : op.item.kind);
  // Series first (skips need their parent's event id), and within a kind, deletes last.
  return ops.sort(
    (a, b) =>
      KIND_ORDER[kindOf(a)] - KIND_ORDER[kindOf(b)] ||
      Number(a.type === 'delete') - Number(b.type === 'delete'),
  );
}

// ---- desired state ------------------------------------------------------------------------------

export interface DesiredOptions {
  now: Date;
  logRuns: boolean;
  /** Fallback zone for runs on gateways without one. */
  timeZone: string;
  /** Rounds durations like the real runs (LinkTap: whole minutes). Default: none. */
  executor?: Pick<Executor, 'quantize'>;
}

export function buildDesired(db: Db, opts: DesiredOptions): Desired[] {
  const windowStart = new Date(opts.now.getTime() - WINDOW_MS);
  const devs = new Map(
    db
      .select({
        id: devices.id,
        name: devices.name,
        linktapName: devices.linktapName,
        gatewayId: devices.gatewayId,
        tz: gateways.timezone,
      })
      .from(devices)
      .leftJoin(gateways, eq(gateways.id, devices.gatewayId))
      .all()
      .map((d) => [d.id, d]),
  );
  const ctx: MapContext = {
    deviceName: (id) => {
      const d = devs.get(id);
      return d ? (d.name ?? d.linktapName) : id;
    },
    gatewayOf: (id) => devs.get(id)?.gatewayId ?? null,
    quantize: (seconds, id) => {
      const d = devs.get(id);
      return opts.executor
        ? opts.executor.quantize(d ? { id, gatewayId: d.gatewayId } : null, seconds)
        : Math.round(seconds);
    },
  };

  const out: Desired[] = [];
  const all = db.select().from(schedules).all();
  const byId = new Map(all.map((s) => [s.id, s]));
  const seriesHash = new Map<number, string>();
  for (const s of all) {
    if (!s.enabled) continue;
    const event = scheduleEvent(s, ctx);
    const hash = hashOf(event);
    seriesHash.set(s.id, hash);
    out.push({ key: scheduleKey(s.id), kind: 'schedule', at: null, hash, event });
  }

  // Planned runs in the window, grouped by occurrence.
  const planned = db
    .select()
    .from(plannedRuns)
    .where(
      and(
        gte(plannedRuns.occurrenceAt, windowStart),
        lte(plannedRuns.occurrenceAt, new Date(opts.now.getTime() + AHEAD_MS)),
      ),
    )
    .all();
  const groups = new Map<string, PlannedRunRow[]>();
  for (const p of planned) {
    const k = `${p.scheduleId}:${p.occurrenceAt.toISOString()}`;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }

  const runIds = planned.flatMap((p) => (p.runId ? [p.runId] : []));
  const runRows =
    opts.logRuns && runIds.length
      ? new Map(
          chunkIds(runIds)
            .flatMap((ids) => db.select().from(runs).where(inArray(runs.id, ids)).all())
            .map((r) => [r.id, r]),
        )
      : new Map();

  for (const [k, group] of groups) {
    const s = byId.get(group[0]!.scheduleId);
    if (!s) continue;
    const occurrenceAt = group[0]!.occurrenceAt;
    // Annotate the series instance when something was skipped.
    const parent = seriesHash.get(s.id);
    const overlay = parent ? skipOverlay(s, group, ctx) : null;
    if (parent && overlay) {
      out.push({
        key: `skip:${k}`,
        kind: 'skip',
        at: occurrenceAt,
        hash: hashOf({ overlay, parent }),
        skip: { parentKey: scheduleKey(s.id), occurrenceAt, overlay },
      });
    }
    // Log what actually ran once the whole occurrence is finished.
    const finished = group.every((p) => !['planned', 'running'].includes(p.status));
    if (opts.logRuns && finished) {
      const ran = group.flatMap((p) =>
        p.runId && runRows.has(p.runId) ? [runRows.get(p.runId)!] : [],
      );
      const event = occurrenceLogEvent(s, group, ran, ctx);
      if (event)
        out.push({ key: `occ:${k}`, kind: 'log', at: occurrenceAt, hash: hashOf(event), event });
    }
  }

  if (opts.logRuns) {
    const loose = db
      .select()
      .from(runs)
      .where(
        and(
          isNull(runs.scheduleId),
          gte(runs.startedAt, windowStart),
          inArray(runs.status, ['completed', 'stopped']),
        ),
      )
      .all();
    for (const r of loose) {
      const event = runLogEvent(r, devs.get(r.deviceId)?.tz ?? opts.timeZone, ctx);
      if (event)
        out.push({ key: `run:${r.id}`, kind: 'log', at: r.startedAt, hash: hashOf(event), event });
    }
  }
  return out;
}

// ---- applying -----------------------------------------------------------------------------------

/** The calendar itself is gone (deleted in Google). The caller makes a new one and starts over. */
export class CalendarGoneError extends Error {}

/** A single item Google refused (bad request). Other items still sync. */
export interface ItemError {
  key: string;
  message: string;
}

export interface ApplyResult {
  errors: ItemError[];
  /** Something was repaired that needs another pass (skips on a recreated series). */
  again: boolean;
}

const isItemError = (err: unknown) => err instanceof GoogleApiError && err.status === 400;

export async function applyOps(
  db: Db,
  api: CalendarApi,
  calendarId: string,
  ops: Op[],
  desired: Desired[],
  now: () => Date = () => new Date(),
): Promise<ApplyResult> {
  const want = new Map(desired.map((d) => [d.key, d]));
  const errors: ItemError[] = [];
  /** Series recreated this pass (deleted in Google). */
  const repaired = new Set<string>();

  const save = (item: Desired, eventId: string | null) => {
    const values = { kind: item.kind, eventId, hash: item.hash, at: item.at, syncedAt: now() };
    db.insert(gcalEvents)
      .values({ key: item.key, ...values })
      .onConflictDoUpdate({ target: gcalEvents.key, set: values })
      .run();
    if (item.kind === 'schedule') {
      db.update(schedules)
        .set({ gcalEventId: eventId })
        .where(eq(schedules.id, Number(item.key.split(':')[1])))
        .run();
    }
  };
  const forget = (key: string) => db.delete(gcalEvents).where(eq(gcalEvents.key, key)).run();
  const rowOf = (key: string) => db.select().from(gcalEvents).where(eq(gcalEvents.key, key)).get();

  /**
   * Insert under an id we pick and record first (hash '' = unconfirmed). If the response is lost,
   * the next pass sees the row as stale and updates that id (or inserts afresh on 404), so a
   * retry never leaves an untracked duplicate behind.
   */
  const insert = async (item: Desired) => {
    const id = newEventId();
    save({ ...item, hash: '' }, id);
    try {
      await api.insertEvent(calendarId, { ...item.event!, id });
    } catch (err) {
      if (err instanceof GoogleApiError && err.gone) throw new CalendarGoneError(err.message);
      throw err;
    }
    save(item, id);
  };

  /** The series instance that starts at `at`, if Google has one. */
  const findInstance = async (parentId: string, at: Date) => {
    const items = await api.instances(
      calendarId,
      parentId,
      new Date(at.getTime() - 60_000),
      new Date(at.getTime() + 60_000),
    );
    const t = at.getTime();
    return (
      items.find((i) => Date.parse(i.originalStartTime?.dateTime ?? i.start?.dateTime ?? '') === t)
        ?.id ?? null
    );
  };

  const applySkip = async (item: Desired) => {
    const { parentKey, occurrenceAt } = item.skip!;
    const parent = rowOf(parentKey);
    // The series didn't sync (yet); try again next time.
    if (!parent?.eventId) return;
    let instanceId: string | null;
    try {
      instanceId = await findInstance(parent.eventId, occurrenceAt);
    } catch (err) {
      const series = want.get(parentKey);
      if (!(err instanceof GoogleApiError && err.gone) || !series?.event) throw err;
      // The series was deleted in Google. Make it again (a gone calendar surfaces from the insert
      // as CalendarGoneError), then redo this series' other skips on a follow-up pass.
      await insert(series);
      repaired.add(parentKey);
      instanceId = await findInstance(rowOf(parentKey)!.eventId!, occurrenceAt);
    }
    if (instanceId) await api.patchEvent(calendarId, instanceId, item.skip!.overlay);
    save(item, instanceId);
  };

  const restoreSkip = async (row: GcalEventRow) => {
    const parent = want.get(parentKeyOf(row.key));
    if (parent?.event && row.eventId) {
      const { summary, description, colorId } = parent.event;
      await api
        .patchEvent(calendarId, row.eventId, { summary, description, colorId })
        .catch((err) => {
          if (!(err instanceof GoogleApiError && err.gone)) throw err;
        });
    }
    forget(row.key);
  };

  for (const op of ops) {
    const key = op.type === 'delete' ? op.row.key : op.item.key;
    try {
      if (op.type === 'delete') {
        if (op.row.kind === 'skip') {
          await restoreSkip(op.row);
          continue;
        }
        if (op.row.eventId) {
          await api.deleteEvent(calendarId, op.row.eventId).catch((err) => {
            if (!(err instanceof GoogleApiError && err.gone)) throw err;
          });
        }
        forget(op.row.key);
        if (op.row.kind === 'schedule') {
          // The instances went with the series.
          const id = op.row.key.split(':')[1];
          for (const r of db.select().from(gcalEvents).where(eq(gcalEvents.kind, 'skip')).all()) {
            if (r.key.startsWith(`skip:${id}:`)) forget(r.key);
          }
          db.update(schedules)
            .set({ gcalEventId: null })
            .where(eq(schedules.id, Number(id)))
            .run();
        }
        continue;
      }
      const { item } = op;
      if (item.kind === 'skip') {
        await applySkip(item);
        continue;
      }
      if (op.type === 'update' && op.row.eventId) {
        try {
          await api.updateEvent(calendarId, op.row.eventId, item.event!);
          save(item, op.row.eventId);
          continue;
        } catch (err) {
          // Deleted in Google: make it again below.
          if (!(err instanceof GoogleApiError && err.gone)) throw err;
          if (item.kind === 'schedule') repaired.add(item.key);
        }
      }
      await insert(item);
    } catch (err) {
      if (!isItemError(err)) throw err;
      errors.push({ key, message: (err as Error).message });
    }
  }
  // Skips annotated on a series we just recreated point at dead instances: mark them stale.
  for (const parentKey of repaired) {
    const prefix = `skip:${parentKey.split(':')[1]}:`;
    for (const r of db.select().from(gcalEvents).where(eq(gcalEvents.kind, 'skip')).all()) {
      if (r.key.startsWith(prefix))
        db.update(gcalEvents).set({ hash: '' }).where(eq(gcalEvents.key, r.key)).run();
    }
  }
  return { errors, again: repaired.size > 0 };
}
