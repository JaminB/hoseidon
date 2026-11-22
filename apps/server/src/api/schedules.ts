import { and, asc, eq, gte, inArray, lt, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  parseQuickAdd,
  plannedRunStatusSchema,
  scheduleInputSchema,
  schedulePatchSchema,
  skipPlannedRunSchema,
  type Schedule,
} from '@hoseidon/shared';
import type { Db } from '../db/types';
import { devices, gateways, plannedRuns, schedules, type ScheduleRow } from '../db/schema';
import type { SchedulerEngine } from '../schedule/engine';
import type { Executor } from '../schedule/executor';
import {
  InvalidRecurrenceError,
  nextOccurrence,
  validateRecurrence,
} from '../schedule/occurrences';
import { previewOccurrences, scheduleWarnings } from '../schedule/preview';
import { toPlannedRun, toSchedule } from './dto';
import { body, HttpError, onApiError, parseDate } from './http';

export interface ScheduleApiDeps {
  db: Db;
  scheduler?: SchedulerEngine;
  /** Used to round previewed durations like the real executor will. */
  executor?: Pick<Executor, 'quantize'>;
  /** Fallback when neither the request nor the first zone's gateway has a time zone. */
  timeZone: string;
  /** Called after anything a calendar shows changes (create, edit, delete, skip). */
  onChange?: () => void;
}

const DAY = 86_400_000;
/** Fields that change what or when a schedule waters; editing them re-plans upcoming runs. */
const TIMING_FIELDS = [
  'rrule',
  'dtstart',
  'timezone',
  'enabled',
  'items',
  'cycleSoak',
  'sequential',
  'skipRules',
] as const;

const quickAddSchema = z.object({ text: z.string().trim().min(1).max(300) });

export function scheduleRoutes({
  db,
  scheduler,
  executor,
  timeZone,
  onChange = () => {},
}: ScheduleApiDeps) {
  const api = new Hono();
  api.onError(onApiError);

  const quantize = (seconds: number, deviceId: string) => {
    const d = db
      .select({ id: devices.id, gatewayId: devices.gatewayId })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .get();
    return executor ? executor.quantize(d ?? null, seconds) : Math.round(seconds);
  };

  const deviceMap = () =>
    new Map(
      db
        .select()
        .from(devices)
        .all()
        .map((d) => [d.id, d]),
    );

  const present = (row: ScheduleRow, devs = deviceMap()): Schedule => {
    let nextAt: Date | null = null;
    if (row.enabled) {
      const after = new Date(Math.max(Date.now(), row.effectiveFrom.getTime()));
      try {
        nextAt = nextOccurrence(row, after);
      } catch {
        nextAt = null;
      }
    }
    return toSchedule(row, { nextAt, warnings: scheduleWarnings(row, devs) });
  };

  const find = (id: string) => {
    const n = Number(id);
    const row = Number.isInteger(n)
      ? db.select().from(schedules).where(eq(schedules.id, n)).get()
      : undefined;
    if (!row) throw new HttpError(404, 'schedule not found');
    return row;
  };

  const check = (s: Pick<ScheduleRow, 'rrule' | 'dtstart' | 'timezone' | 'items'>) => {
    try {
      validateRecurrence(s);
    } catch (err) {
      if (err instanceof InvalidRecurrenceError) throw new HttpError(400, err.message);
      // rrule.js throws plain Errors for bad parts like BYDAY=XX.
      throw new HttpError(400, `invalid RRULE: ${(err as Error).message}`);
    }
    const ids = s.items.map((i) => i.deviceId);
    const known = new Set(
      db
        .select({ id: devices.id })
        .from(devices)
        .where(inArray(devices.id, ids))
        .all()
        .map((d) => d.id),
    );
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length) throw new HttpError(400, `unknown device: ${unknown.join(', ')}`);
  };

  /** The first zone's gateway time zone, else the server's. */
  const defaultZone = (deviceId: string | undefined) => {
    if (!deviceId) return timeZone;
    const row = db
      .select({ tz: gateways.timezone })
      .from(devices)
      .innerJoin(gateways, eq(gateways.id, devices.gatewayId))
      .where(eq(devices.id, deviceId))
      .get();
    return row?.tz ?? timeZone;
  };

  // ---- schedules --------------------------------------------------------------------------------

  api.get('/schedules', (c) => {
    const devs = deviceMap();
    const rows = db.select().from(schedules).orderBy(asc(schedules.name)).all();
    return c.json(rows.map((r) => present(r, devs)));
  });

  api.post('/schedules', async (c) => {
    const input = await body(c, scheduleInputSchema);
    const tz = input.timezone ?? defaultZone(input.items[0]?.deviceId);
    const values = { ...input, timezone: tz };
    check(values);
    const now = new Date();
    const row = db
      .insert(schedules)
      .values({ ...values, effectiveFrom: now, updatedAt: now })
      .returning()
      .get();
    scheduler?.rematerialize(row.id, now);
    onChange();
    return c.json(present(row), 201);
  });

  // Registered before /schedules/:id so "preview" isn't taken for an id.
  api.get('/schedules/preview', (c) => {
    const from = parseDate(c.req.query('from'), new Date());
    const to = parseDate(c.req.query('to'), new Date(from.getTime() + 7 * DAY));
    if (to <= from) throw new HttpError(400, 'to must be after from');
    if (to.getTime() - from.getTime() > 62 * DAY)
      throw new HttpError(400, 'range is at most 62 days');
    const id = c.req.query('scheduleId');
    const list = id
      ? [find(id)]
      : db.select().from(schedules).where(eq(schedules.enabled, true)).all();
    // An edited schedule doesn't replay occurrences from before the edit.
    const since = new Map(list.map((s) => [s.id, s.effectiveFrom.getTime()]));
    const occ = previewOccurrences(list, deviceMap(), from, to, quantize).filter(
      (o) => new Date(o.start).getTime() >= (since.get(o.scheduleId) ?? 0),
    );
    return c.json(occ);
  });

  api.post('/schedules/quick-add', async (c) => {
    const { text } = await body(c, quickAddSchema);
    const list = db.select().from(devices).all();
    const opts = { devices: list.map((d) => ({ id: d.id, name: d.name ?? d.linktapName })) };
    const result = parseQuickAdd(text, { ...opts, timeZone });
    // Use the matched zone's gateway time zone (it decides what "today" is for dtstart).
    const zone = defaultZone(result.draft.items[0]?.deviceId);
    return c.json(zone === timeZone ? result : parseQuickAdd(text, { ...opts, timeZone: zone }));
  });

  api.get('/schedules/:id', (c) => c.json(present(find(c.req.param('id')))));

  api.patch('/schedules/:id', async (c) => {
    const patch = await body(c, schedulePatchSchema);
    const current = find(c.req.param('id'));
    const merged = { ...current, ...patch };
    check(merged);
    const now = new Date();
    const retime = TIMING_FIELDS.some((k) => k in patch);
    const row = db
      .update(schedules)
      .set({ ...patch, updatedAt: now, ...(retime ? { effectiveFrom: now } : {}) })
      .where(eq(schedules.id, current.id))
      .returning()
      .get()!;
    if (retime) {
      const moved = ['rrule', 'dtstart', 'timezone'].some((k) => k in patch);
      scheduler?.rematerialize(row.id, now, { cancelStarted: moved });
    }
    onChange();
    return c.json(present(row));
  });

  api.delete('/schedules/:id', (c) => {
    const row = find(c.req.param('id'));
    // Planned runs cascade. Anything already watering finishes on its own timer.
    db.delete(schedules).where(eq(schedules.id, row.id)).run();
    onChange();
    return c.body(null, 204);
  });

  // ---- planned runs -----------------------------------------------------------------------------

  api.get('/planned-runs', (c) => {
    const now = Date.now();
    const from = parseDate(c.req.query('from'), new Date(now - DAY));
    const to = parseDate(c.req.query('to'), new Date(now + 2 * DAY));
    const where: SQL[] = [gte(plannedRuns.plannedAt, from), lt(plannedRuns.plannedAt, to)];
    const scheduleId = c.req.query('scheduleId');
    if (scheduleId) where.push(eq(plannedRuns.scheduleId, Number(scheduleId)));
    const deviceId = c.req.query('deviceId');
    if (deviceId) where.push(eq(plannedRuns.deviceId, deviceId));
    const status = c.req.query('status');
    if (status) {
      const parsed = plannedRunStatusSchema.safeParse(status);
      if (!parsed.success) throw new HttpError(400, `invalid status: ${status}`);
      where.push(eq(plannedRuns.status, parsed.data));
    }
    const rows = db
      .select()
      .from(plannedRuns)
      .where(and(...where))
      .orderBy(asc(plannedRuns.plannedAt), asc(plannedRuns.id))
      .limit(1000)
      .all();
    return c.json(rows.map(toPlannedRun));
  });

  api.post('/planned-runs/:id/skip', async (c) => {
    const { reason, wholeOccurrence } = await body(c, skipPlannedRunSchema);
    const id = Number(c.req.param('id'));
    const row = Number.isInteger(id)
      ? db.select().from(plannedRuns).where(eq(plannedRuns.id, id)).get()
      : undefined;
    if (!row) throw new HttpError(404, 'planned run not found');
    if (row.status !== 'planned') throw new HttpError(409, `run is already ${row.status}`);
    const now = new Date();
    const skipped = db
      .update(plannedRuns)
      .set({ status: 'skipped', skipReason: reason ?? 'Skipped by you', updatedAt: now })
      .where(
        and(
          eq(plannedRuns.status, 'planned'),
          wholeOccurrence
            ? and(
                eq(plannedRuns.scheduleId, row.scheduleId),
                eq(plannedRuns.occurrenceAt, row.occurrenceAt),
              )
            : eq(plannedRuns.id, row.id),
        ),
      )
      .returning()
      .all();
    onChange();
    return c.json(skipped.map(toPlannedRun));
  });

  api.get('/scheduler/status', (c) => c.json(scheduler?.status() ?? null));

  return api;
}
