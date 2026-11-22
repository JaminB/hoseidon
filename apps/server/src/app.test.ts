import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  commandResultSchema,
  deviceDetailSchema,
  eventSchema,
  gatewayWithDevicesSchema,
  healthSchema,
} from '@hoseidon/shared';
import { loadConfig } from './config';
import { openDb } from './db';
import { devices, events, runs } from './db/schema';
import { MOCK_IDS } from './linktap/mock';
import { harness } from './test-utils';

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function seeded() {
  const h = harness();
  await h.poller.pollDevices();
  return h;
}

describe('app basics', () => {
  it('serves /api/health', async () => {
    const { app } = harness();
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(healthSchema.parse(await res.json()).mock).toBe(true);
  });

  it('404s unknown api routes as JSON', async () => {
    const { app } = harness();
    const res = await app.request('/api/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });
});

describe('config', () => {
  it('treats blank env values as unset', () => {
    expect(loadConfig({ PORT: '' }).PORT).toBe(8787);
  });
});

describe('db', () => {
  it('applies migrations', () => {
    const { sqlite } = openDb(':memory:');
    const tables = sqlite
      .prepare("select name from sqlite_master where type = 'table' order by name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'devices',
        'device_snapshots',
        'events',
        'gateways',
        'runs',
        'settings',
      ]),
    );
  });
});

describe('REST API', () => {
  it('lists gateways with nested devices, and flat devices', async () => {
    const { app } = await seeded();
    const gws = gatewayWithDevicesSchema
      .array()
      .parse(await (await app.request('/api/gateways')).json());
    expect(gws.map((g) => [g.name, g.devices.length])).toEqual([
      ['Backyard Gateway', 4],
      ['Garage Gateway', 2],
    ]);
    const devs = (await (await app.request('/api/devices')).json()) as unknown[];
    expect(devs).toHaveLength(6);
  });

  it('returns device detail with snapshots in range, and 404s unknown ids', async () => {
    const { app } = await seeded();
    const res = await app.request(`/api/devices/${MOCK_IDS.frontLawn}`);
    const detail = deviceDetailSchema.parse(await res.json());
    expect(detail.device.name).toBe('Front Lawn');
    expect(detail.snapshots).toHaveLength(1);
    expect(detail.runs[0]?.status).toBe('running');

    const empty = await app.request(
      `/api/devices/${MOCK_IDS.frontLawn}?from=2000-01-01T00:00:00Z&to=2000-01-02T00:00:00Z`,
    );
    expect(deviceDetailSchema.parse(await empty.json()).snapshots).toHaveLength(0);
    expect((await app.request('/api/devices/nope')).status).toBe(404);
    expect((await app.request(`/api/devices/${MOCK_IDS.frontLawn}?from=bogus`)).status).toBe(400);
  });

  it('edits names, zones and gateway location', async () => {
    const { app } = await seeded();
    const dev = await app.request(`/api/devices/${MOCK_IDS.dripA}`, {
      ...json({ name: 'Tomatoes', zone: 'Back garden' }),
      method: 'PATCH',
    });
    expect(await dev.json()).toMatchObject({
      name: 'Tomatoes',
      linktapName: 'Drip Line A',
      zone: 'Back garden',
    });
    const gw = await app.request(`/api/gateways/${MOCK_IDS.backyard}`, {
      ...json({ lat: 40.7, lon: -74, timezone: 'America/New_York' }),
      method: 'PATCH',
    });
    expect(await gw.json()).toMatchObject({ lat: 40.7, lon: -74, timezone: 'America/New_York' });
    const bad = await app.request(`/api/gateways/${MOCK_IDS.backyard}`, {
      ...json({ lat: 500 }),
      method: 'PATCH',
    });
    expect(bad.status).toBe(400);
  });

  it('runs and stops a device, recording a hoseidon run', async () => {
    const h = await seeded();
    const res = await h.app.request(`/api/devices/${MOCK_IDS.dripA}/run`, json({ seconds: 300 }));
    expect(res.status).toBe(200);
    const started = commandResultSchema.parse(await res.json());
    expect(started.run).toMatchObject({ source: 'hoseidon', status: 'running', plannedSec: 300 });
    expect(h.mock.find(MOCK_IDS.dripA)?.run?.totalSec).toBe(300);

    const stop = commandResultSchema.parse(
      await (await h.app.request(`/api/devices/${MOCK_IDS.dripA}/stop`, json({}))).json(),
    );
    expect(stop.run).toMatchObject({ id: started.run!.id, status: 'stopped' });
    expect(h.mock.find(MOCK_IDS.dripA)?.run).toBeNull();
  });

  it('validates run bodies and refuses offline devices', async () => {
    const { app } = await seeded();
    expect(
      (await app.request(`/api/devices/${MOCK_IDS.dripA}/run`, json({ seconds: 5 }))).status,
    ).toBe(400);
    expect((await app.request(`/api/devices/${MOCK_IDS.dripA}/run`, json({}))).status).toBe(400);
    expect(
      (await app.request(`/api/devices/${MOCK_IDS.backFence}/run`, json({ seconds: 60 }))).status,
    ).toBe(409);
  });

  it('maps LinkTap errors to 502', async () => {
    const { app } = await seeded();
    // Veggie Beds has a noWater alarm; the mock refuses to start it.
    const res = await app.request(`/api/devices/${MOCK_IDS.veggies}/run`, json({ seconds: 60 }));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/alarm/);
  });

  it('dismisses alarms and pauses plans, logging events', async () => {
    const h = await seeded();
    const res = await h.app.request(
      `/api/devices/${MOCK_IDS.veggies}/dismiss-alarm`,
      json({ alarm: 'noWater' }),
    );
    expect(res.status).toBe(200);
    expect(
      h.db.select().from(devices).where(eq(devices.id, MOCK_IDS.veggies)).get()?.alarms,
    ).toEqual([]);
    expect(
      (
        await h.app.request(
          `/api/devices/${MOCK_IDS.veggies}/dismiss-alarm`,
          json({ alarm: 'leakFlag' }),
        )
      ).status,
    ).toBe(400);

    expect(
      (await h.app.request(`/api/devices/${MOCK_IDS.sideYard}/pause`, json({ hours: 24 }))).status,
    ).toBe(200);
    expect(
      (await h.app.request(`/api/devices/${MOCK_IDS.sideYard}/pause`, json({ hours: 0 }))).status,
    ).toBe(400);

    const list = eventSchema.array().parse(await (await h.app.request('/api/events')).json());
    expect(list.map((e) => e.type)).toEqual(['device.plan_paused', 'device.alarm_dismissed']);
    const filtered = eventSchema
      .array()
      .parse(await (await h.app.request(`/api/events?deviceId=${MOCK_IDS.veggies}`)).json());
    expect(filtered).toHaveLength(1);
    const paged = eventSchema
      .array()
      .parse(await (await h.app.request(`/api/events?before=${list[0]!.id}`)).json());
    expect(paged.map((e) => e.id)).toEqual([list[1]!.id]);
  });

  it('exposes rate-limit and poller status', async () => {
    const { app } = await seeded();
    const body = (await (await app.request('/api/linktap/status')).json()) as {
      mock: boolean;
      poller: { last: { devices: { at: string | null } } };
      nextAvailableAt: Record<string, string>;
    };
    expect(body.mock).toBe(true);
    expect(body.poller.last.devices.at).not.toBeNull();
    expect(Object.keys(body.nextAvailableAt).sort()).toEqual(['command', 'devices', 'history']);
  });
});

describe('webhook receiver', () => {
  const hook = (secret: string, body: unknown) => [`/hooks/linktap/${secret}`, json(body)] as const;

  it('rejects a wrong secret and a disabled endpoint with 404', async () => {
    const { app } = await seeded();
    expect((await app.request(...hook('wrong', { event: 'x' }))).status).toBe(404);
    const off = harness({ env: { WEBHOOK_SECRET: '' } });
    expect((await off.app.request(...hook('', { event: 'x' }))).status).toBe(404);
  });

  it('rejects malformed payloads and other accounts', async () => {
    const h = harness({ env: { LINKTAP_USERNAME: 'me' } });
    expect((await h.app.request(...hook('s3cret', { nope: 1 }))).status).toBe(400);
    expect((await h.app.request(...hook('s3cret', { event: 'x', username: 'them' }))).status).toBe(
      403,
    );
  });

  it('stores events and applies offline/online side effects', async () => {
    const h = await seeded();
    const res = await h.app.request(
      ...hook('s3cret', {
        username: 'tester',
        event: 'deviceOffline',
        title: 'Device offline',
        content: 'Front Lawn is offline',
        gatewayId: MOCK_IDS.backyard,
        deviceId: MOCK_IDS.frontLawn,
      }),
    );
    expect(res.status).toBe(200);
    const ev = h.db.select().from(events).get();
    expect(ev).toMatchObject({
      type: 'linktap.deviceOffline',
      source: 'webhook',
      severity: 'alert',
      deviceId: MOCK_IDS.frontLawn,
      title: 'Device offline',
    });
    expect(
      h.db.select().from(devices).where(eq(devices.id, MOCK_IDS.frontLawn)).get()?.online,
    ).toBe(false);

    await h.app.request(...hook('s3cret', { event: 'gatewayOffline', gatewayId: MOCK_IDS.garage }));
    const gw = (await (await h.app.request('/api/gateways')).json()) as {
      id: string;
      online: boolean;
    }[];
    expect(gw.find((g) => g.id === MOCK_IDS.garage)?.online).toBe(false);
  });

  it('opens and closes runs on watering webhooks, resolving 16-char multi-outlet ids only when unambiguous', async () => {
    const h = await seeded();
    await h.app.request(...hook('s3cret', { event: 'wateringOn', deviceId: MOCK_IDS.sideYard }));
    const open = h.db.select().from(runs).where(eq(runs.deviceId, MOCK_IDS.sideYard)).get();
    expect(open).toMatchObject({ status: 'running', source: 'linktap' });
    await h.app.request(...hook('s3cret', { event: 'wateringOff', deviceId: MOCK_IDS.sideYard }));
    expect(h.db.select().from(runs).where(eq(runs.deviceId, MOCK_IDS.sideYard)).get()?.status).toBe(
      'completed',
    );

    // "B1C2D3E4F5A60013" matches both outlets: event is stored but no run is guessed.
    await h.app.request(...hook('s3cret', { event: 'wateringOn', deviceId: 'B1C2D3E4F5A60013' }));
    expect(h.db.select().from(runs).where(eq(runs.deviceId, MOCK_IDS.dripA)).all()).toHaveLength(0);
    expect(h.db.select().from(events).all().at(-1)?.deviceId).toBe('B1C2D3E4F5A60013');
  });
});
