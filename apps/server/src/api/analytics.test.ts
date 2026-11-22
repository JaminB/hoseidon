import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Analytics, AnalyticsSummary, WeatherResponse } from '@hoseidon/shared';
import { MOCK_IDS } from '../linktap/mock';
import { devices, gateways, plannedRuns, runs, schedules } from '../db/schema';
import { harness } from '../test-utils';

// Noon UTC on 2026-06-10; the harness runs in UTC.
const NOW = new Date('2026-06-10T12:00:00Z');
const MOCK_GATEWAY = MOCK_IDS.backyard;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

async function setup() {
  const h = harness({ mock: { seedRunning: false } });
  await h.poller.pollDevices();
  const get = async <T>(path: string) => {
    const res = await h.app.request(`/api${path}`);
    return { status: res.status, body: (await res.json()) as T };
  };
  const run = (deviceId: string, startedAt: string, durationSec: number, volumeMl: number | null) =>
    h.db
      .insert(runs)
      .values({
        deviceId,
        startedAt: new Date(startedAt),
        endedAt: new Date(new Date(startedAt).getTime() + durationSec * 1000),
        durationSec,
        volumeMl,
        plannedSec: durationSec,
        source: 'hoseidon',
        status: 'completed',
      })
      .run();
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
      effectiveFrom: new Date('2026-06-01T00:00:00Z'),
      updatedAt: new Date(),
    })
    .returning()
    .get();
  const planned = (
    deviceId: string,
    occurrenceAt: string,
    over: Partial<typeof plannedRuns.$inferInsert>,
    seq = 0,
  ) =>
    h.db
      .insert(plannedRuns)
      .values({
        scheduleId: sched.id,
        deviceId,
        gatewayId: MOCK_GATEWAY,
        occurrenceAt: new Date(occurrenceAt),
        seq,
        cycle: 1,
        plannedAt: new Date(occurrenceAt),
        baseSeconds: 600,
        seconds: 600,
        status: 'done',
        updatedAt: new Date(),
        ...over,
      })
      .run();
  return { ...h, get, run, planned };
}

const ID = MOCK_IDS.frontLawn;

describe('GET /api/analytics/devices/:id', () => {
  it('buckets runs by local day and fills empty days', async () => {
    const { get, run } = await setup();
    run(ID, '2026-06-08T06:00:00Z', 600, 12_000);
    run(ID, '2026-06-08T18:00:00Z', 300, 6_000);
    run(ID, '2026-06-10T06:00:00Z', 900, 30_000);
    const { status, body } = await get<Analytics>(
      `/analytics/devices/${ID}?from=2026-06-07&to=2026-06-10`,
    );
    expect(status).toBe(200);
    expect(body.days.map((d) => [d.date, d.runs, d.volumeMl, d.durationSec])).toEqual([
      ['2026-06-07', 0, 0, 0],
      ['2026-06-08', 2, 18_000, 900],
      ['2026-06-09', 0, 0, 0],
      ['2026-06-10', 1, 30_000, 900],
    ]);
    expect(body.days[1]!.avgFlowMlMin).toBe(1200);
    expect(body.days[0]!.avgFlowMlMin).toBeNull();
    expect(body.totals).toMatchObject({ runs: 3, volumeMl: 48_000, durationSec: 1800 });
    expect(body.totals.avgFlowMlMin).toBe(1600);
    expect(body.hasFlow).toBe(true);
  });

  it('respects the gateway time zone for day boundaries', async () => {
    const { get, run, db } = await setup();
    db.update(gateways).set({ timezone: 'America/New_York' }).run();
    // 02:00 UTC on the 9th is 22:00 on the 8th in New York.
    run(ID, '2026-06-09T02:00:00Z', 600, 1000);
    const { body } = await get<Analytics>(`/analytics/devices/${ID}?from=2026-06-08&to=2026-06-09`);
    expect(body.timezone).toBe('America/New_York');
    expect(body.days.map((d) => d.runs)).toEqual([1, 0]);
  });

  it('hides flow when LinkTap says no flow meter is fitted', async () => {
    const { get, run, db } = await setup();
    run(ID, '2026-06-09T06:00:00Z', 600, 1000);
    db.update(devices).set({ flowMeter: false }).run();
    const { body } = await get<Analytics>(`/analytics/devices/${ID}?from=2026-06-09&to=2026-06-09`);
    expect(body.hasFlow).toBe(false);
  });

  it('hides flow gracefully when no run reported a volume', async () => {
    const { get, run } = await setup();
    run(ID, '2026-06-09T06:00:00Z', 600, null);
    const { body } = await get<Analytics>(`/analytics/devices/${ID}?from=2026-06-09&to=2026-06-09`);
    expect(body.hasFlow).toBe(false);
    expect(body.totals.avgFlowMlMin).toBeNull();
    expect(body.totals.durationSec).toBe(600);
  });

  it('counts skips by reason and estimates water saved', async () => {
    const { get, run, planned } = await setup();
    // 1200 ml/min = 20 ml/s.
    run(ID, '2026-06-05T06:00:00Z', 600, 12_000);
    planned(ID, '2026-06-08T06:00:00Z', { status: 'skipped', skipReason: '8 mm rain forecast' });
    planned(ID, '2026-06-09T06:00:00Z', { status: 'skipped', skipReason: 'High wind (30 km/h)' });
    planned(ID, '2026-06-10T06:00:00Z', { status: 'skipped', skipReason: 'Skipped by you' });
    // ET0 scaling: ran 70% of a 600 s cycle -> 180 s saved.
    planned(ID, '2026-06-07T06:00:00Z', { status: 'done', scale: 0.7, seconds: 420 });
    // Scaled up costs water; it is not counted as a saving.
    planned(ID, '2026-06-06T06:00:00Z', { status: 'done', scale: 1.2, seconds: 720 });
    // Still planned: ignored.
    planned(ID, '2026-06-10T18:00:00Z', { status: 'planned' }, 1);
    const { body } = await get<Analytics>(`/analytics/devices/${ID}?from=2026-06-01&to=2026-06-10`);
    expect(Object.fromEntries(body.skipReasons.map((s) => [s.kind, s.count]))).toEqual({
      rain: 1,
      wind: 1,
      manual: 1,
    });
    expect(body.totals.skipped).toBe(3);
    expect(body.saved).toEqual({ skippedRuns: 2, seconds: 600 + 600 + 180, volumeMl: 27_600 });
    expect(body.days.find((d) => d.date === '2026-06-08')!.skipped).toBe(1);
  });

  it('leaves saved volume unknown without flow data, but still reports time', async () => {
    const { get, planned } = await setup();
    planned(ID, '2026-06-08T06:00:00Z', {
      status: 'skipped',
      skipReason: 'Freeze risk (low of -1 °C)',
    });
    const { body } = await get<Analytics>(`/analytics/devices/${ID}?from=2026-06-01&to=2026-06-10`);
    expect(body.saved).toEqual({ skippedRuns: 1, seconds: 600, volumeMl: null });
  });

  it('defaults to the last 30 days and validates the range', async () => {
    const { get } = await setup();
    const ok = await get<Analytics>(`/analytics/devices/${ID}`);
    expect(ok.body.days).toHaveLength(30);
    expect(ok.body.to).toBe('2026-06-10');
    expect((await get(`/analytics/devices/${ID}?from=nope`)).status).toBe(400);
    expect((await get(`/analytics/devices/${ID}?from=2026-06-10&to=2026-06-01`)).status).toBe(400);
    expect((await get(`/analytics/devices/${ID}?from=2020-01-01&to=2026-06-01`)).status).toBe(400);
    expect((await get('/analytics/devices/nope')).status).toBe(404);
  });
});

describe('GET /api/analytics/summary', () => {
  it('totals every device and lists each one', async () => {
    const { get, run } = await setup();
    run(ID, '2026-06-09T06:00:00Z', 600, 10_000);
    run(MOCK_IDS.sideYard, '2026-06-09T07:00:00Z', 300, 4_000);
    const { body } = await get<AnalyticsSummary>(
      '/analytics/summary?from=2026-06-09&to=2026-06-10',
    );
    expect(body.totals).toMatchObject({ runs: 2, volumeMl: 14_000, durationSec: 900 });
    expect(body.devices.find((d) => d.deviceId === ID)).toMatchObject({
      runs: 1,
      volumeMl: 10_000,
    });
    expect(body.devices.length).toBeGreaterThan(2);
  });
});

describe('GET /api/weather/:gatewayId', () => {
  it('reports unavailable until the gateway has a location', async () => {
    const { get } = await setup();
    const { status, body } = await get<WeatherResponse>(`/weather/${MOCK_GATEWAY}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ available: false, days: [], today: '2026-06-10' });
    expect(body.attribution).toBe('Weather data by Open-Meteo.com (CC BY 4.0)');
  });

  it('returns observed and forecast days once located', async () => {
    const { get, db } = await setup();
    db.update(gateways).set({ lat: 47.6, lon: -122.3, timezone: 'America/Los_Angeles' }).run();
    const { body } = await get<WeatherResponse>(
      `/weather/${MOCK_GATEWAY}?from=2026-06-01&to=2026-06-12`,
    );
    expect(body.available).toBe(true);
    expect(body.timezone).toBe('America/Los_Angeles');
    expect(body.days).toHaveLength(12);
    expect(body.days[0]!.forecast).toBe(false);
    expect(body.days.at(-1)!.forecast).toBe(true);
  });

  it('404s for an unknown gateway', async () => {
    const { get } = await setup();
    expect((await get('/weather/0000000000000000')).status).toBe(404);
  });
});
