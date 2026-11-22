import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Diagnosis,
  Incident,
  NetworkDeviceDetail,
  NetworkGatewayDetail,
  NetworkOverview,
} from '@hoseidon/shared';
import { MOCK_IDS } from '../linktap/mock';
import { harness } from '../test-utils';

const T0 = new Date('2026-06-10T00:00:00Z');
const MIN = 60_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

/** Polls every 5 minutes for 2 hours, with a webhook outage on the backyard and a garage outage. */
async function setup() {
  const h = harness({ mock: { seedRunning: false } });
  const tick = async () => {
    vi.advanceTimersByTime(5 * MIN);
    await h.poller.pollDevices();
  };
  await h.poller.pollDevices();
  for (let i = 1; i <= 24; i++) {
    if (i === 4) {
      // 20 min: LinkTap tells us right away; the next poll sees it back.
      await h.app.request('/hooks/linktap/s3cret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event: 'gatewayOffline', gatewayId: MOCK_IDS.backyard }),
      });
    }
    if (i === 6) h.mock.setGatewayOnline(MOCK_IDS.garage, false);
    if (i === 12) h.mock.setGatewayOnline(MOCK_IDS.garage, true);
    await tick();
  }
  const get = async <T>(path: string) => {
    const res = await h.app.request(`/api${path}`);
    return { status: res.status, body: (await res.json()) as T };
  };
  return { h, get };
}

describe('GET /api/network/overview', () => {
  it('derives uptime, incidents with their source, and freshness', async () => {
    const { get } = await setup();
    const { body: o } = await get<NetworkOverview>('/network/overview');
    expect(o.weakSignalPct).toBe(40);
    expect(o.freshness).toMatchObject({ stale: false, ageSec: 0 });

    const garage = o.gateways.find((g) => g.id === MOCK_IDS.garage)!;
    const backyard = o.gateways.find((g) => g.id === MOCK_IDS.backyard)!;
    expect(garage.online).toBe(true);
    // Garage was offline for 30 of the 120 observed minutes.
    expect(garage.uptimePct).toBeGreaterThan(70);
    expect(garage.uptimePct).toBeLessThan(80);
    expect(backyard.uptimePct).toBeGreaterThan(90);

    const gatewayIncidents = o.incidents.filter((i) => i.scope === 'gateway');
    expect(gatewayIncidents).toHaveLength(2);
    const byGateway = (id: string) => gatewayIncidents.find((i) => i.gatewayId === id)!;
    expect(byGateway(MOCK_IDS.backyard)).toMatchObject({ source: 'webhook', ongoing: false });
    expect(byGateway(MOCK_IDS.garage)).toMatchObject({
      source: 'poll',
      ongoing: false,
      durationSec: 30 * 60,
    });

    // Timers behind the garage went offline with it, and say so.
    const side = o.incidents.find((i) => i.deviceId === MOCK_IDS.sideYard);
    expect(side).toMatchObject({ scope: 'device', viaGateway: true });
  });

  it('includes per-timer signal and battery series', async () => {
    const { get } = await setup();
    const { body: o } = await get<NetworkOverview>('/network/overview');
    const dev = o.gateways.flatMap((g) => g.devices).find((d) => d.id === MOCK_IDS.sideYard)!;
    expect(dev.signal).toMatchObject({ latest: 18, weakEpisodes: 1 });
    expect(dev.signal.series.length).toBeGreaterThan(5);
    expect(dev.battery.latest).not.toBeNull();
    expect(dev.segments.map((s) => s.state)).toContain('offline');
  });

  it('reports API health from the client', async () => {
    const { get } = await setup();
    const { body: o } = await get<NetworkOverview>('/network/overview');
    const ep = o.apiHealth.endpoints.find((e) => e.endpoint === 'getAllDevices')!;
    expect(ep).toMatchObject({ errors: 0, errorRatePct: 0 });
    expect(ep.calls).toBeGreaterThanOrEqual(25);
    expect(ep.lastOkAt).not.toBeNull();
    expect(o.apiHealth.mock).toBe(true);
  });

  it('rejects a bad window', async () => {
    const { get } = await setup();
    expect((await get('/network/overview?days=99')).status).toBe(400);
  });
});

describe('detail endpoints', () => {
  it('returns one gateway and one device, 404 for unknown ids', async () => {
    const { get } = await setup();
    const g = await get<NetworkGatewayDetail>(`/network/gateways/${MOCK_IDS.garage}`);
    expect(g.body.gateway.id).toBe(MOCK_IDS.garage);
    expect(g.body.incidents.every((i: Incident) => i.gatewayId === MOCK_IDS.garage)).toBe(true);
    const d = await get<NetworkDeviceDetail>(`/network/devices/${MOCK_IDS.sideYard}`);
    expect(d.body.device.name).toBeTruthy();
    expect(d.body.incidents.every((i) => i.deviceId === MOCK_IDS.sideYard)).toBe(true);
    expect((await get('/network/gateways/nope')).status).toBe(404);
    expect((await get('/network/devices/nope')).status).toBe(404);
  });
});

describe('weak-signal setting', () => {
  it('defaults to 40, persists, validates, and changes what counts as weak', async () => {
    const { h, get } = await setup();
    expect((await get<{ weakSignalPct: number }>('/network/settings')).body.weakSignalPct).toBe(40);
    const bad = await h.app.request('/api/network/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ weakSignalPct: 2 }),
    });
    expect(bad.status).toBe(400);
    const ok = await h.app.request('/api/network/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ weakSignalPct: 90 }),
    });
    expect(ok.status).toBe(200);
    const { body: o } = await get<NetworkOverview>('/network/overview');
    expect(o.weakSignalPct).toBe(90);
    const dev = o.gateways.flatMap((g) => g.devices).find((d) => d.id === MOCK_IDS.frontLawn)!;
    expect(dev.signal.weakPct).toBe(100);
  });
});

describe('POST /api/diagnose/:deviceId', () => {
  const post = (h: Awaited<ReturnType<typeof setup>>['h'], id: string) =>
    h.app.request(`/api/diagnose/${id}`, { method: 'POST' });

  it('lists a checklist with plain-English fixes for a troubled timer', async () => {
    const { h } = await setup();
    // Side yard: weak signal, on a 7-day LinkTap plan; veggies: low battery and a noWater alarm.
    const res = await post(h, MOCK_IDS.sideYard);
    const d = (await res.json()) as Diagnosis;
    expect(d.checks.map((c) => c.id)).toEqual([
      'gateway',
      'device',
      'signal',
      'battery',
      'alarms',
      'plan',
      'freshness',
      'cloud',
      'starts',
      'webhook',
    ]);
    const by = (id: string) => d.checks.find((c) => c.id === id)!;
    // 18% is under half the 40% threshold, so it is a failure, not a nudge.
    expect(by('signal')).toMatchObject({ status: 'fail' });
    expect(by('signal').fix).toBeTruthy();
    expect(by('plan').status).toBe('warn');
    expect(by('freshness').status).toBe('pass');
    expect(by('cloud').status).toBe('pass');
    // A webhook did arrive during setup.
    expect(by('webhook').status).toBe('pass');
    expect(d.verdict).toBe('fail');

    const veg = (await (await post(h, MOCK_IDS.veggies)).json()) as Diagnosis;
    expect(veg.checks.find((c) => c.id === 'alarms')?.status).toBe('fail');
    expect(veg.verdict).toBe('fail');
  });

  it('notes an offline gateway', async () => {
    const { h } = await setup();
    h.mock.setGatewayOnline(MOCK_IDS.garage, false);
    vi.advanceTimersByTime(5 * MIN);
    await h.poller.pollDevices();
    const d = (await (await post(h, MOCK_IDS.sideYard)).json()) as Diagnosis;
    expect(d.checks.find((c) => c.id === 'gateway')?.status).toBe('fail');
    expect(d.checks.find((c) => c.id === 'device')?.status).toBe('fail');
  });

  it('knows when a scheduled run failed and when no webhook is set up', async () => {
    const h = harness({ mock: { seedRunning: false }, env: { WEBHOOK_SECRET: '' } });
    await h.poller.pollDevices();
    const { plannedRuns, schedules } = await import('../db/schema');
    const sched = h.db
      .insert(schedules)
      .values({
        name: 'Lawn',
        color: '#0ea5e9',
        rrule: 'FREQ=DAILY',
        dtstart: '2026-06-01T06:00',
        timezone: 'UTC',
        items: [],
        skipRules: {} as never,
        effectiveFrom: T0,
        updatedAt: T0,
      })
      .returning()
      .get();
    h.db
      .insert(plannedRuns)
      .values({
        scheduleId: sched.id,
        deviceId: MOCK_IDS.frontLawn,
        gatewayId: MOCK_IDS.backyard,
        occurrenceAt: T0,
        seq: 0,
        cycle: 1,
        plannedAt: T0,
        baseSeconds: 600,
        seconds: 600,
        status: 'failed',
        error: 'timer offline',
        updatedAt: T0,
      })
      .run();
    const d = (await (await post(h, MOCK_IDS.frontLawn)).json()) as Diagnosis;
    expect(d.checks.find((c) => c.id === 'starts')).toMatchObject({ status: 'fail' });
    expect(d.checks.find((c) => c.id === 'webhook')).toMatchObject({ status: 'warn' });
    expect((await post(h, 'nope')).status).toBe(404);
  });
});
