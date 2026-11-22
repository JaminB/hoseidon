import { and, desc, eq, gte, like, max } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  networkSettingsSchema,
  type ApiHealth,
  type Diagnosis,
  type NetworkDeviceDetail,
  type NetworkGatewayDetail,
  type NetworkOverview,
  type NetworkSettings,
} from '@hoseidon/shared';
import type { Db } from '../db/types';
import { deviceSnapshots, devices, events, gateways, plannedRuns } from '../db/schema';
import type { LinkTapClient } from '../linktap/client';
import type { Poller } from '../poller';
import { diagnose } from '../network/diagnose';
import { freshness } from '../network/metrics';
import { buildNetwork } from '../network/overview';
import { readWeakSignalPct, writeWeakSignalPct } from '../network/settings';
import { body, HttpError, onApiError } from './http';

export interface NetworkApiDeps {
  db: Db;
  linktap: LinkTapClient;
  poller?: Poller;
  mock: boolean;
  /** Whether WEBHOOK_SECRET is set. */
  webhookConfigured: boolean;
  now?: () => number;
}

const DAY = 86_400_000;
const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function networkRoutes({
  db,
  linktap,
  poller,
  mock,
  webhookConfigured,
  now = Date.now,
}: NetworkApiDeps) {
  const api = new Hono();
  api.onError(onApiError);

  const windowDays = (raw: string | undefined) => {
    if (raw === undefined) return 7;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 30) throw new HttpError(400, 'days must be 1-30');
    return n;
  };

  const apiHealth = (): ApiHealth => {
    const stats = linktap.stats();
    return {
      mock,
      since: stats.since.toISOString(),
      endpoints: stats.endpoints.map((e) => ({
        endpoint: e.endpoint,
        calls: e.calls,
        errors: e.errors,
        errorRatePct: e.recentCalls
          ? Math.round((e.recentErrors / e.recentCalls) * 1000) / 10
          : null,
        lastOkAt: iso(e.lastOkAt),
        lastErrorAt: iso(e.lastErrorAt),
        lastError: e.lastError,
        avgWaitMs: e.waits ? Math.round(e.totalWaitMs / e.waits) : 0,
        maxWaitMs: Math.round(e.maxWaitMs),
      })),
      nextAvailableAt: {
        devices: linktap.nextAvailableAt('devices').toISOString(),
        history: linktap.nextAvailableAt('history').toISOString(),
        command: linktap.nextAvailableAt('command').toISOString(),
      },
      poller: poller?.status() ?? null,
    };
  };

  /** Network metrics for the window, with the weak-signal setting that produced them. */
  const network = (days: number) => {
    const at = now();
    const weakSignalPct = readWeakSignalPct(db);
    return { at, weakSignalPct, net: buildNetwork(db, { now: at, days, weakSignalPct }) };
  };

  api.get('/network/settings', (c) => {
    const out: NetworkSettings = { weakSignalPct: readWeakSignalPct(db) };
    return c.json(out);
  });

  api.patch('/network/settings', async (c) => {
    const { weakSignalPct } = await body(c, networkSettingsSchema);
    writeWeakSignalPct(db, weakSignalPct);
    return c.json({ weakSignalPct } satisfies NetworkSettings);
  });

  api.get('/network/overview', (c) => {
    const days = windowDays(c.req.query('days'));
    const { at, weakSignalPct, net } = network(days);
    const out: NetworkOverview = {
      generatedAt: new Date(at).toISOString(),
      windowDays: days,
      from: new Date(at - days * DAY).toISOString(),
      to: new Date(at).toISOString(),
      weakSignalPct,
      freshness: freshness(net.lastPollAt, at),
      gateways: net.gateways,
      incidents: net.incidents.slice(0, 30),
      apiHealth: apiHealth(),
    };
    return c.json(out);
  });

  api.get('/network/gateways/:id', (c) => {
    const id = c.req.param('id');
    const days = windowDays(c.req.query('days'));
    const { at, weakSignalPct, net } = network(days);
    const gateway = net.gateways.find((g) => g.id === id);
    if (!gateway) throw new HttpError(404, 'gateway not found');
    const out: NetworkGatewayDetail = {
      generatedAt: new Date(at).toISOString(),
      windowDays: days,
      weakSignalPct,
      gateway,
      incidents: net.incidents.filter((i) => i.gatewayId === id),
    };
    return c.json(out);
  });

  api.get('/network/devices/:id', (c) => {
    const id = c.req.param('id');
    const days = windowDays(c.req.query('days'));
    const { at, weakSignalPct, net } = network(days);
    const device = net.gateways.flatMap((g) => g.devices).find((d) => d.id === id);
    if (!device) throw new HttpError(404, 'device not found');
    const out: NetworkDeviceDetail = {
      generatedAt: new Date(at).toISOString(),
      windowDays: days,
      weakSignalPct,
      device,
      incidents: net.incidents.filter((i) => i.deviceId === id),
    };
    return c.json(out);
  });

  // A POST because it is something you press, and it reads half the database.
  api.post('/diagnose/:deviceId', (c) => {
    const row = db
      .select()
      .from(devices)
      .where(eq(devices.id, c.req.param('deviceId')))
      .get();
    if (!row) throw new HttpError(404, 'device not found');
    const { at, weakSignalPct, net } = network(14);
    const gw = db.select().from(gateways).where(eq(gateways.id, row.gatewayId)).get();
    const lastSnap = db
      .select({ at: max(deviceSnapshots.at) })
      .from(deviceSnapshots)
      .where(eq(deviceSnapshots.deviceId, row.id))
      .get();
    const failed = db
      .select({ at: plannedRuns.updatedAt, error: plannedRuns.error })
      .from(plannedRuns)
      .where(
        and(
          eq(plannedRuns.deviceId, row.id),
          eq(plannedRuns.status, 'failed'),
          gte(plannedRuns.updatedAt, new Date(at - 7 * DAY)),
        ),
      )
      .orderBy(desc(plannedRuns.updatedAt))
      .all();
    const lastWebhook = db
      .select({ at: max(events.at) })
      .from(events)
      .where(and(like(events.type, 'linktap.%'), eq(events.source, 'webhook')))
      .get();
    const cloud = linktap.stats().endpoints.find((e) => e.endpoint === 'getAllDevices');
    const daysLeft =
      net.gateways.flatMap((g) => g.devices).find((d) => d.id === row.id)?.battery.daysLeft ?? null;

    const out: Diagnosis = diagnose({
      now: at,
      device: {
        id: row.id,
        name: row.name ?? row.linktapName,
        online: row.online,
        lastSeenAt: row.lastSeenAt?.getTime() ?? null,
        signalPct: row.signalPct,
        batteryPct: row.batteryPct,
        alarms: row.alarms,
        workMode: row.workMode,
      },
      gateway: gw
        ? {
            name: gw.name ?? gw.linktapName,
            online: gw.online,
            lastSeenAt: gw.lastSeenAt?.getTime() ?? null,
          }
        : null,
      weakSignalPct,
      lastSnapshotAt: lastSnap?.at?.getTime() ?? null,
      failedStarts: failed.map((f) => ({ at: f.at.getTime(), error: f.error })),
      webhook: { configured: webhookConfigured, lastEventAt: lastWebhook?.at?.getTime() ?? null },
      cloud: {
        lastOkAt: cloud?.lastOkAt?.getTime() ?? null,
        lastErrorAt: cloud?.lastErrorAt?.getTime() ?? null,
        lastError: cloud?.lastError ?? null,
      },
      batteryDaysLeft: daysLeft,
    });
    return c.json(out);
  });

  return api;
}
