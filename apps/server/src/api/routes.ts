import { and, asc, desc, eq, gte, lt, lte, type SQL } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import type { z } from 'zod';
import {
  devicePatchSchema,
  dismissAlarmRequestSchema,
  eventSeveritySchema,
  gatewayPatchSchema,
  pauseRequestSchema,
  runRequestSchema,
  type CommandResult,
  type DeviceDetail,
  type GatewayWithDevices,
} from '@hoseidon/shared';
import type { Db } from '../db';
import { devices, deviceSnapshots, events, gateways, runs } from '../db/schema';
import { LinkTapError, type LinkTapClient } from '../linktap/client';
import type { Poller } from '../poller';
import { ALARM_LABELS, closeRun, insertEvents, openRun, startRun } from '../poller/ingest';
import { toDevice, toEvent, toGateway, toRun, toSnapshot } from './dto';

export interface ApiDeps {
  db: Db;
  linktap: LinkTapClient;
  poller?: Poller;
  mock: boolean;
}

class HttpError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 502,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

async function body<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  const json: unknown = await c.req.json().catch(() => {
    throw new HttpError(400, 'invalid JSON body');
  });
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new HttpError(400, 'invalid body', parsed.error.issues);
  return parsed.data;
}

function parseDate(value: string | undefined, fallback: Date): Date {
  if (!value) return fallback;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `invalid date: ${value}`);
  return d;
}

export function apiRoutes({ db, linktap, poller, mock }: ApiDeps) {
  const api = new Hono();

  api.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.message, detail: err.detail }, err.status);
    }
    if (err instanceof LinkTapError) {
      return c.json({ error: err.message }, err.kind === 'invalid' ? 400 : 502);
    }
    throw err;
  });

  const findDevice = (id: string) => {
    const row = db.select().from(devices).where(eq(devices.id, id)).get();
    if (!row) throw new HttpError(404, 'device not found');
    return row;
  };

  // ---- gateways & devices -----------------------------------------------------------------------

  api.get('/gateways', (c) => {
    const gws = db.select().from(gateways).orderBy(asc(gateways.linktapName)).all();
    const devs = db.select().from(devices).orderBy(asc(devices.linktapName)).all();
    const body: GatewayWithDevices[] = gws.map((g) => ({
      ...toGateway(g),
      devices: devs.filter((d) => d.gatewayId === g.id).map(toDevice),
    }));
    return c.json(body);
  });

  api.patch('/gateways/:id', async (c) => {
    const patch = await body(c, gatewayPatchSchema);
    const row = db
      .update(gateways)
      .set(patch)
      .where(eq(gateways.id, c.req.param('id')))
      .returning()
      .get();
    if (!row) throw new HttpError(404, 'gateway not found');
    return c.json(toGateway(row));
  });

  api.get('/devices', (c) => {
    const rows = db.select().from(devices).orderBy(asc(devices.linktapName)).all();
    return c.json(rows.map(toDevice));
  });

  api.get('/devices/:id', (c) => {
    const device = findDevice(c.req.param('id'));
    const to = parseDate(c.req.query('to'), new Date());
    const from = parseDate(c.req.query('from'), new Date(to.getTime() - 86_400_000));
    const snapshots = db
      .select()
      .from(deviceSnapshots)
      .where(
        and(
          eq(deviceSnapshots.deviceId, device.id),
          gte(deviceSnapshots.at, from),
          lte(deviceSnapshots.at, to),
        ),
      )
      .orderBy(asc(deviceSnapshots.at))
      .limit(5000)
      .all();
    const deviceRuns = db
      .select()
      .from(runs)
      .where(and(eq(runs.deviceId, device.id), gte(runs.startedAt, from), lte(runs.startedAt, to)))
      .orderBy(desc(runs.startedAt))
      .limit(500)
      .all();
    const body: DeviceDetail = {
      device: toDevice(device),
      snapshots: snapshots.map(toSnapshot),
      runs: deviceRuns.map(toRun),
    };
    return c.json(body);
  });

  api.patch('/devices/:id', async (c) => {
    const patch = await body(c, devicePatchSchema);
    findDevice(c.req.param('id'));
    const row = db
      .update(devices)
      .set(patch)
      .where(eq(devices.id, c.req.param('id')))
      .returning()
      .get();
    return c.json(toDevice(row!));
  });

  // ---- commands ---------------------------------------------------------------------------------

  const result = (run: CommandResult['run'] = null): CommandResult => ({
    ok: true,
    nextCommandAt: linktap.nextAvailableAt('command').toISOString(),
    run,
  });

  api.post('/devices/:id/run', async (c) => {
    const { seconds } = await body(c, runRequestSchema);
    const device = findDevice(c.req.param('id'));
    if (!device.online) throw new HttpError(409, 'device is offline');
    await linktap.startWatering({
      gatewayId: device.gatewayId,
      taplinkerId: device.id,
      seconds,
    });
    const now = new Date();
    const run = db.transaction((tx) => {
      const open = openRun(tx, device.id);
      if (open) closeRun(tx, open, now, 'stopped');
      tx.update(devices)
        .set({
          watering: {
            remainingSec: seconds,
            totalSec: seconds,
            flowMlPerMin: null,
            volumeMl: null,
          },
        })
        .where(eq(devices.id, device.id))
        .run();
      return startRun(tx, {
        deviceId: device.id,
        startedAt: now,
        plannedSec: seconds,
        source: 'hoseidon',
      });
    });
    return c.json(result(toRun(run)));
  });

  api.post('/devices/:id/stop', async (c) => {
    const device = findDevice(c.req.param('id'));
    await linktap.stopWatering({ gatewayId: device.gatewayId, taplinkerId: device.id });
    const now = new Date();
    const run = db.transaction((tx) => {
      tx.update(devices).set({ watering: null }).where(eq(devices.id, device.id)).run();
      const open = openRun(tx, device.id);
      return open ? closeRun(tx, open, now, 'stopped') : null;
    });
    return c.json(result(run ? toRun(run) : null));
  });

  api.post('/devices/:id/pause', async (c) => {
    const { hours } = await body(c, pauseRequestSchema);
    const device = findDevice(c.req.param('id'));
    await linktap.pauseWateringPlan({ gatewayId: device.gatewayId, taplinkerId: device.id }, hours);
    insertEvents(db, [
      {
        at: new Date(),
        type: 'device.plan_paused',
        source: 'hoseidon',
        severity: 'info',
        gatewayId: device.gatewayId,
        deviceId: device.id,
        title: `${device.name ?? device.linktapName}: plan paused`,
        message: hours === -1 ? 'Paused until a mode is re-activated' : `Paused for ${hours} h`,
        data: { hours },
      },
    ]);
    return c.json(result());
  });

  api.post('/devices/:id/dismiss-alarm', async (c) => {
    const { alarm } = await body(c, dismissAlarmRequestSchema);
    const device = findDevice(c.req.param('id'));
    await linktap.dismissAlarm({ gatewayId: device.gatewayId, taplinkerId: device.id }, alarm);
    db.transaction((tx) => {
      // Re-read: a poll may have changed the alarms while the command was queued.
      const current = tx.select().from(devices).where(eq(devices.id, device.id)).get();
      tx.update(devices)
        .set({ alarms: (current?.alarms ?? []).filter((a) => a !== alarm) })
        .where(eq(devices.id, device.id))
        .run();
      insertEvents(tx, [
        {
          at: new Date(),
          type: 'device.alarm_dismissed',
          source: 'hoseidon',
          severity: 'info',
          gatewayId: device.gatewayId,
          deviceId: device.id,
          title: `${device.name ?? device.linktapName}: ${ALARM_LABELS[alarm]} dismissed`,
          message: null,
          data: { alarm },
        },
      ]);
    });
    return c.json(result());
  });

  // ---- events & status --------------------------------------------------------------------------

  api.get('/events', (c) => {
    const limitParam = c.req.query('limit');
    const limit = limitParam === undefined ? 50 : Number(limitParam);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new HttpError(400, 'limit must be an integer 1..500');
    }
    const where: SQL[] = [];
    const before = Number(c.req.query('before'));
    if (Number.isInteger(before) && before > 0) where.push(lt(events.id, before));
    const deviceId = c.req.query('deviceId');
    if (deviceId) where.push(eq(events.deviceId, deviceId));
    const gatewayId = c.req.query('gatewayId');
    if (gatewayId) where.push(eq(events.gatewayId, gatewayId));
    const severity = eventSeveritySchema.safeParse(c.req.query('severity'));
    if (severity.success) where.push(eq(events.severity, severity.data));
    const rows = db
      .select()
      .from(events)
      .where(and(...where))
      .orderBy(desc(events.id))
      .limit(limit)
      .all();
    return c.json(rows.map(toEvent));
  });

  api.get('/linktap/status', (c) =>
    c.json({
      mock,
      poller: poller?.status() ?? null,
      nextAvailableAt: {
        devices: linktap.nextAvailableAt('devices').toISOString(),
        history: linktap.nextAvailableAt('history').toISOString(),
        command: linktap.nextAvailableAt('command').toISOString(),
      },
    }),
  );

  return api;
}
