import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { PlannedRun, PreviewOccurrence, QuickAddResult, Schedule } from '@hoseidon/shared';
import { gateways, plannedRuns } from '../db/schema';
import { MOCK_IDS } from '../linktap/mock';
import { harness } from '../test-utils';

const NOW = new Date('2026-06-10T05:00:00Z');

async function setup() {
  const h = harness({ mock: { seedRunning: false } });
  await h.poller.pollDevices();
  const req = async <T>(method: string, path: string, json?: unknown) => {
    const res = await h.app.request(`/api${path}`, {
      method,
      headers: json === undefined ? undefined : { 'content-type': 'application/json' },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  };
  return { ...h, req };
}

const lawnSchedule = {
  name: 'Lawn',
  rrule: 'FREQ=DAILY;INTERVAL=2',
  dtstart: '2026-06-10T06:00',
  items: [{ deviceId: MOCK_IDS.frontLawn, seconds: 900 }],
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('/api/schedules', () => {
  it('creates with defaults and lists', async () => {
    const { req } = await setup();
    const created = await req<Schedule>('POST', '/schedules', lawnSchedule);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: 'Lawn',
      color: '#22b8cf',
      timezone: 'UTC', // no gateway time zone set -> server default
      enabled: true,
      sequential: true,
      cycleSoak: null,
      gcalEventId: null,
      nextAt: '2026-06-10T06:00:00.000Z',
      warnings: [],
      skipRules: { rainForecastMm: null, etScaling: false, minScale: 0.5, maxScale: 1.5 },
    });
    const list = await req<Schedule[]>('GET', '/schedules');
    expect(list.body.map((s) => s.name)).toEqual(['Lawn']);
    const one = await req<Schedule>('GET', `/schedules/${created.body.id}`);
    expect(one.body.id).toBe(created.body.id);
  });

  it("defaults the time zone to the first zone's gateway", async () => {
    const { req, db } = await setup();
    db.update(gateways)
      .set({ timezone: 'America/Denver' })
      .where(eq(gateways.id, MOCK_IDS.backyard))
      .run();
    const created = await req<Schedule>('POST', '/schedules', lawnSchedule);
    expect(created.body.timezone).toBe('America/Denver');
    // 06:00 MDT = 12:00Z.
    expect(created.body.nextAt).toBe('2026-06-10T12:00:00.000Z');
  });

  it('validates the rule, devices and body', async () => {
    const { req } = await setup();
    const bad = (patch: object) => req('POST', '/schedules', { ...lawnSchedule, ...patch });
    expect((await bad({ rrule: 'FREQ=HOURLY' })).status).toBe(400);
    expect((await bad({ rrule: 'FREQ=DAILY;BYDAY=XX' })).status).toBe(400);
    expect((await bad({ rrule: 'DTSTART:20260101T000000Z\nFREQ=DAILY' })).status).toBe(400);
    expect((await bad({ dtstart: '2026-02-30T06:00' })).status).toBe(400);
    expect((await bad({ timezone: 'Mars/Olympus' })).status).toBe(400);
    expect((await bad({ items: [] })).status).toBe(400);
    expect((await bad({ items: [{ deviceId: MOCK_IDS.frontLawn, seconds: 30 }] })).status).toBe(
      400,
    );
    const unknown = await bad({ items: [{ deviceId: 'NOPE', seconds: 600 }] });
    expect(unknown).toMatchObject({ status: 400, body: { error: 'unknown device: NOPE' } });
    expect((await bad({ cycleSoak: { cycles: 11, soakMinutes: 10 } })).status).toBe(400);
    expect((await bad({ skipRules: { minScale: 0.9, maxScale: 0.95 } })).status).toBe(400);
  });

  it('warns about LinkTap-app plans and offline devices', async () => {
    const { req } = await setup();
    const created = await req<Schedule>('POST', '/schedules', {
      ...lawnSchedule,
      items: [
        { deviceId: MOCK_IDS.sideYard, seconds: 600 },
        { deviceId: MOCK_IDS.backFence, seconds: 600 },
      ],
    });
    expect(created.body.warnings.map((w) => [w.kind, w.deviceId])).toEqual([
      ['linktap_plan', MOCK_IDS.sideYard],
      ['offline_device', MOCK_IDS.backFence],
    ]);
    expect(created.body.warnings[0]!.message).toMatch(/7-day plan/);
  });

  it('patches, keeps omitted fields, and deletes', async () => {
    const { req, db } = await setup();
    const { body: s } = await req<Schedule>('POST', '/schedules', {
      ...lawnSchedule,
      cycleSoak: { cycles: 2, soakMinutes: 10 },
    });
    const renamed = await req<Schedule>('PATCH', `/schedules/${s.id}`, { name: 'Front' });
    expect(renamed.body).toMatchObject({ name: 'Front', cycleSoak: { cycles: 2 }, enabled: true });
    expect((await req('PATCH', `/schedules/${s.id}`, {})).status).toBe(400);
    expect((await req('PATCH', `/schedules/${s.id}`, { rrule: 'nope' })).status).toBe(400);

    const disabled = await req<Schedule>('PATCH', `/schedules/${s.id}`, { enabled: false });
    expect(disabled.body.nextAt).toBeNull();

    expect((await req('DELETE', `/schedules/${s.id}`)).status).toBe(204);
    expect((await req('GET', `/schedules/${s.id}`)).status).toBe(404);
    expect(db.select().from(plannedRuns).all()).toEqual([]);
    expect((await req('GET', '/schedules/abc')).status).toBe(404);
  });
});

describe('/api/schedules/preview', () => {
  it('lays out occurrences with slots and flags overlaps on a shared gateway', async () => {
    const { req } = await setup();
    const a = await req<Schedule>('POST', '/schedules', {
      ...lawnSchedule,
      rrule: 'FREQ=DAILY',
      items: [
        { deviceId: MOCK_IDS.frontLawn, seconds: 600 },
        { deviceId: MOCK_IDS.dripA, seconds: 450 }, // rounds to 8 min
      ],
    });
    const b = await req<Schedule>('POST', '/schedules', {
      ...lawnSchedule,
      name: 'Drip',
      rrule: 'FREQ=WEEKLY;BYDAY=WE',
      dtstart: '2026-06-10T06:15',
      items: [{ deviceId: MOCK_IDS.dripB, seconds: 600 }],
    });
    const c = await req<Schedule>('POST', '/schedules', {
      ...lawnSchedule,
      name: 'Side',
      rrule: 'FREQ=DAILY',
      items: [{ deviceId: MOCK_IDS.sideYard, seconds: 600 }],
    });
    const res = await req<PreviewOccurrence[]>(
      'GET',
      '/schedules/preview?from=2026-06-10T00:00:00Z&to=2026-06-12T00:00:00Z',
    );
    expect(res.status).toBe(200);
    const today = res.body.filter((o) => o.start.startsWith('2026-06-10'));
    const lawn = today.find((o) => o.scheduleId === a.body.id)!;
    expect(lawn.end).toBe('2026-06-10T06:18:00.000Z');
    expect(lawn.slots.map((s) => [s.start.slice(11, 16), s.seconds])).toEqual([
      ['06:00', 600],
      ['06:10', 480],
    ]);
    expect(lawn.overlapsWith).toEqual([b.body.id]);
    // Side Yard is on the other gateway: same time, no conflict.
    expect(today.find((o) => o.scheduleId === c.body.id)!.overlapsWith).toEqual([]);
    expect(
      res.body.filter((o) => o.start.startsWith('2026-06-11')).every((o) => !o.overlapsWith.length),
    ).toBe(true);

    const one = await req<PreviewOccurrence[]>(
      'GET',
      `/schedules/preview?scheduleId=${b.body.id}&from=2026-06-01T00:00:00Z&to=2026-06-30T00:00:00Z`,
    );
    expect(one.body.map((o) => o.start.slice(0, 10))).toEqual([
      '2026-06-10',
      '2026-06-17',
      '2026-06-24',
    ]);
  });

  it('rejects bad ranges', async () => {
    const { req } = await setup();
    expect((await req('GET', '/schedules/preview?from=x')).status).toBe(400);
    expect(
      (await req('GET', '/schedules/preview?from=2026-06-10T00:00Z&to=2026-06-09T00:00Z')).status,
    ).toBe(400);
    expect(
      (await req('GET', '/schedules/preview?from=2026-01-01T00:00Z&to=2026-06-01T00:00Z')).status,
    ).toBe(400);
  });
});

describe('/api/schedules/quick-add', () => {
  it('parses against the real device names', async () => {
    const { req } = await setup();
    const res = await req<QuickAddResult>('POST', '/schedules/quick-add', {
      text: 'mon wed fri at 5:30 front lawn 10 min x3 soak 20',
    });
    expect(res.body.ok).toBe(true);
    expect(res.body.draft).toMatchObject({
      name: 'Front Lawn',
      rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR',
      dtstart: '2026-06-10T05:30',
      items: [{ deviceId: MOCK_IDS.frontLawn, seconds: 1800 }],
      cycleSoak: { cycles: 3, soakMinutes: 20 },
    });
    // The draft can be posted as-is.
    expect((await req('POST', '/schedules', res.body.draft)).status).toBe(201);
  });
});

describe('/api/planned-runs', () => {
  it('lists, filters and skips a whole occurrence', async () => {
    const { req, scheduler } = await setup();
    const { body: s } = await req<Schedule>('POST', '/schedules', {
      ...lawnSchedule,
      rrule: 'FREQ=DAILY',
      items: [
        { deviceId: MOCK_IDS.frontLawn, seconds: 600 },
        { deviceId: MOCK_IDS.dripA, seconds: 600 },
      ],
    });
    const list = await req<PlannedRun[]>('GET', '/planned-runs');
    expect(list.body).toHaveLength(4); // 2 zones x (today, tomorrow)
    expect(list.body[0]).toMatchObject({
      scheduleId: s.id,
      status: 'planned',
      occurrenceAt: '2026-06-10T06:00:00.000Z',
      plannedAt: '2026-06-10T06:00:00.000Z',
      seq: 0,
      cycle: 1,
      seconds: 600,
    });
    const drip = await req<PlannedRun[]>('GET', `/planned-runs?deviceId=${MOCK_IDS.dripA}`);
    expect(drip.body.map((p) => p.plannedAt)).toEqual([
      '2026-06-10T06:10:00.000Z',
      '2026-06-11T06:10:00.000Z',
    ]);
    expect((await req('GET', '/planned-runs?status=bogus')).status).toBe(400);

    const skipped = await req<PlannedRun[]>('POST', `/planned-runs/${list.body[0]!.id}/skip`, {});
    expect(skipped.body.map((p) => [p.deviceId, p.skipReason])).toEqual([
      [MOCK_IDS.frontLawn, 'Skipped by you'],
      [MOCK_IDS.dripA, 'Skipped by you'],
    ]);
    expect((await req('POST', `/planned-runs/${list.body[0]!.id}/skip`, {})).status).toBe(409);
    expect((await req('POST', '/planned-runs/9999/skip', {})).status).toBe(404);

    // Skipped runs don't start.
    vi.setSystemTime(new Date('2026-06-10T06:00:00Z'));
    await scheduler.tick();
    const after = await req<PlannedRun[]>('GET', '/planned-runs?status=running');
    expect(after.body).toEqual([]);
  });

  it('skips a single zone when asked', async () => {
    const { req } = await setup();
    await req('POST', '/schedules', {
      ...lawnSchedule,
      items: [
        { deviceId: MOCK_IDS.frontLawn, seconds: 600 },
        { deviceId: MOCK_IDS.dripA, seconds: 600 },
      ],
    });
    const list = await req<PlannedRun[]>('GET', '/planned-runs');
    const res = await req<PlannedRun[]>('POST', `/planned-runs/${list.body[0]!.id}/skip`, {
      wholeOccurrence: false,
      reason: 'Lawn was mowed',
    });
    expect(res.body.map((p) => p.skipReason)).toEqual(['Lawn was mowed']);
  });

  it('reports scheduler status', async () => {
    const { req } = await setup();
    const res = await req('GET', '/scheduler/status');
    expect(res.body).toMatchObject({ running: false, executor: 'cloud', lastTickAt: null });
  });
});
