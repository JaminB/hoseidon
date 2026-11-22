import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import type { ScheduleInput } from '@hoseidon/shared';
import { events, gateways, plannedRuns, runs, schedules } from '../db/schema';
import { MOCK_IDS } from '../linktap/mock';
import { harness } from '../test-utils';
import { SchedulerEngine } from './engine';
import type { WeatherOutlook, WeatherProvider } from './weather';

const T0 = new Date('2026-06-10T06:00:00Z');
const MIN = 60_000;
const at = (offsetMin: number) => new Date(T0.getTime() + offsetMin * MIN);

type H = Awaited<ReturnType<typeof setup>>;

async function setup(opts: Parameters<typeof harness>[0] = {}) {
  vi.setSystemTime(at(-30));
  const h = harness({ mock: { seedRunning: false }, ...opts });
  await h.poller.pollDevices();
  return h;
}

async function createSchedule(h: H, input: Partial<ScheduleInput> = {}) {
  const res = await h.app.request('/api/schedules', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Morning',
      rrule: 'FREQ=DAILY',
      dtstart: '2026-06-10T06:00',
      timezone: 'UTC',
      items: [{ deviceId: MOCK_IDS.frontLawn, seconds: 600 }],
      ...input,
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: number };
}

const planned = (h: H) =>
  h.db
    .select()
    .from(plannedRuns)
    .where(eq(plannedRuns.occurrenceAt, T0))
    .orderBy(asc(plannedRuns.cycle), asc(plannedRuns.seq))
    .all();
const statuses = (h: H) => planned(h).map((p) => `${p.deviceId.slice(-4)}#${p.cycle}:${p.status}`);
const startCalls = (h: H) =>
  h.mock.calls.filter((c) => c.endpoint === 'activateInstantMode' && c.body.action === true);

/** Jump to `min` minutes after T0, let the poller notice finished runs, then tick. */
async function tickAt(h: H, min: number) {
  vi.setSystemTime(at(min));
  await h.poller.pollRunning();
  await h.scheduler.tick();
}

const patchSchedule = (h: H, id: number, body: unknown) =>
  h.app.request(`/api/schedules/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const stopDevice = (h: H, id: string) =>
  h.app.request(`/api/devices/${id}/stop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('SchedulerEngine', () => {
  it('materializes upcoming occurrences on create and runs them on time', async () => {
    const h = await setup();
    await createSchedule(h);
    // 48 h horizon from 05:30: today and tomorrow at 06:00.
    expect(h.db.select().from(plannedRuns).all()).toHaveLength(2);

    await tickAt(h, -1);
    expect(statuses(h)).toEqual(['0011#1:planned']);

    await tickAt(h, 0);
    const [p] = planned(h);
    expect(p).toMatchObject({ status: 'running', seconds: 600, attempts: 1 });
    expect(startCalls(h)[0]?.body).toMatchObject({ duration: 10 });
    const run = h.db.select().from(runs).where(eq(runs.id, p!.runId!)).get();
    expect(run).toMatchObject({ source: 'hoseidon', scheduleId: p!.scheduleId, status: 'running' });

    await tickAt(h, 11);
    expect(planned(h)[0]).toMatchObject({ status: 'done' });
  });

  it('runs zones on one gateway one at a time, other gateways in parallel', async () => {
    const h = await setup();
    await createSchedule(h, {
      items: [
        { deviceId: MOCK_IDS.frontLawn, seconds: 600 },
        { deviceId: MOCK_IDS.dripA, seconds: 300 },
        { deviceId: MOCK_IDS.sideYard, seconds: 300 },
      ],
    });
    await tickAt(h, 0);
    expect(statuses(h)).toEqual(['0011#1:running', '13_1#1:planned', '0021#1:running']);

    await tickAt(h, 5);
    expect(statuses(h)).toEqual(['0011#1:running', '13_1#1:planned', '0021#1:done']);

    await tickAt(h, 10.5);
    expect(statuses(h)).toEqual(['0011#1:done', '13_1#1:running', '0021#1:done']);
    const [lawn, drip] = planned(h);
    expect(drip!.startedAt!.getTime()).toBeGreaterThanOrEqual(lawn!.endedAt!.getTime());
  });

  it('starts zones together when the schedule is not sequential', async () => {
    const h = await setup();
    await createSchedule(h, {
      sequential: false,
      items: [
        { deviceId: MOCK_IDS.frontLawn, seconds: 600 },
        { deviceId: MOCK_IDS.dripA, seconds: 300 },
      ],
    });
    await tickAt(h, 0);
    expect(statuses(h)).toEqual(['0011#1:running', '13_1#1:running']);
  });

  it('cycles and soaks', async () => {
    const h = await setup();
    await createSchedule(h, {
      items: [{ deviceId: MOCK_IDS.frontLawn, seconds: 1200 }],
      cycleSoak: { cycles: 2, soakMinutes: 15 },
    });
    await tickAt(h, 0);
    expect(statuses(h)).toEqual(['0011#1:running', '0011#2:planned']);
    expect(planned(h).map((p) => p.seconds)).toEqual([600, 600]);

    // The poller notices at 10.5, but the run ended at 10: soak until 25.
    await tickAt(h, 10.5);
    expect(statuses(h)).toEqual(['0011#1:done', '0011#2:planned']);
    await tickAt(h, 24.5);
    expect(statuses(h)).toEqual(['0011#1:done', '0011#2:planned']);
    await tickAt(h, 25);
    expect(statuses(h)).toEqual(['0011#1:done', '0011#2:running']);
  });

  it('retries a start that silently fails, then fails loudly', async () => {
    const h = await setup();
    await createSchedule(h, {
      items: [
        { deviceId: MOCK_IDS.frontLawn, seconds: 600 },
        { deviceId: MOCK_IDS.dripA, seconds: 600 },
      ],
    });
    h.mock.failStartsSilently(MOCK_IDS.frontLawn, 5);
    await tickAt(h, 0);
    const [lawn, drip] = planned(h);
    expect(lawn).toMatchObject({ status: 'failed', attempts: 2 });
    expect(lawn!.error).toMatch(/did not report watering/);
    // The next zone isn't held up by the failure.
    expect(drip!.status).toBe('running');
    const failedRun = h.db.select().from(runs).where(eq(runs.id, lawn!.runId!)).get();
    expect(failedRun).toMatchObject({ status: 'failed', durationSec: 0 });
    const ev = h.db.select().from(events).where(eq(events.type, 'schedule.run_failed')).all();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ severity: 'alert', deviceId: MOCK_IDS.frontLawn });
  });

  it('succeeds on the retry', async () => {
    const h = await setup();
    await createSchedule(h);
    h.mock.failStartsSilently(MOCK_IDS.frontLawn, 1);
    await tickAt(h, 0);
    expect(planned(h)[0]).toMatchObject({ status: 'running', attempts: 2 });
    expect(startCalls(h)).toHaveLength(2);
  });

  it('stops the rest of an occurrence when the schedule is turned off', async () => {
    const h = await setup();
    const { id } = await createSchedule(h, {
      items: [
        { deviceId: MOCK_IDS.frontLawn, seconds: 600 },
        { deviceId: MOCK_IDS.dripA, seconds: 300 },
      ],
    });
    await tickAt(h, 0);
    expect(statuses(h)).toEqual(['0011#1:running', '13_1#1:planned']);
    // Zone 1 has passed its weather check and zone 2 is queued behind it.
    expect((await patchSchedule(h, id, { enabled: false })).status).toBe(200);
    expect((await stopDevice(h, MOCK_IDS.frontLawn)).status).toBe(200);
    await tickAt(h, 1);
    expect(startCalls(h)).toHaveLength(1);
    expect(planned(h)[1]).toMatchObject({ status: 'skipped', skipReason: 'Schedule turned off' });
  });

  it('does not start a queued zone of a schedule disabled behind the API', async () => {
    const h = await setup();
    const { id } = await createSchedule(h, {
      items: [
        { deviceId: MOCK_IDS.frontLawn, seconds: 600 },
        { deviceId: MOCK_IDS.dripA, seconds: 300 },
      ],
    });
    await tickAt(h, 0);
    h.db.update(schedules).set({ enabled: false }).where(eq(schedules.id, id)).run();
    await stopDevice(h, MOCK_IDS.frontLawn);
    await tickAt(h, 1);
    expect(startCalls(h)).toHaveLength(1);
  });

  it('does not water twice when a running schedule is moved', async () => {
    const h = await setup();
    const { id } = await createSchedule(h, {
      items: [
        { deviceId: MOCK_IDS.frontLawn, seconds: 600 },
        { deviceId: MOCK_IDS.dripA, seconds: 300 },
      ],
    });
    await tickAt(h, 0);
    await patchSchedule(h, id, { dtstart: '2026-06-10T18:00' });
    await stopDevice(h, MOCK_IDS.frontLawn);
    await tickAt(h, 1);
    expect(startCalls(h)).toHaveLength(1);
    expect(planned(h)[1]).toMatchObject({ status: 'skipped', skipReason: 'Schedule changed' });
  });

  it('honours Stop pressed while a start is still being verified', async () => {
    const h = await setup();
    await createSchedule(h);
    h.mock.failStartsSilently(MOCK_IDS.frontLawn, 1);
    vi.spyOn(h.executor, 'verify').mockImplementationOnce(async (d) => {
      h.scheduler.noteStop(d.id); // the Stop button, mid-verify
      return false;
    });
    await tickAt(h, 0);
    // No retry start behind the Stop, and the zone isn't left watering.
    expect(startCalls(h)).toHaveLength(1);
    expect(planned(h)[0]).toMatchObject({ status: 'cancelled', skipReason: 'Stopped by you' });
    expect(h.mock.find(MOCK_IDS.frontLawn)?.run ?? null).toBeNull();
    expect(h.db.select().from(runs).all()).toHaveLength(0);
  });

  it('an accepted but unconfirmed start is tracked and flagged, never re-sent', async () => {
    const h = await setup();
    await createSchedule(h);
    vi.spyOn(h.executor, 'confirmStart').mockResolvedValueOnce('unknown');
    await tickAt(h, 0);
    expect(startCalls(h)).toHaveLength(1);
    expect(planned(h)[0]).toMatchObject({ status: 'running', attempts: 1 });
    const [run] = h.db.select().from(runs).all();
    expect(run).toMatchObject({ status: 'running', source: 'hoseidon', plannedSec: 600 });
    const ev = h.db.select().from(events).where(eq(events.type, 'schedule.run_unverified')).get();
    expect(ev).toMatchObject({ severity: 'warn', deviceId: MOCK_IDS.frontLawn });
    expect(ev?.title).toMatch(/couldn't confirm/);
  });

  it('records no run when Stop lands after the start was verified', async () => {
    const h = await setup();
    await createSchedule(h);
    const verify = h.executor.verify.bind(h.executor);
    vi.spyOn(h.executor, 'verify').mockImplementationOnce(async (d) => {
      const ok = await verify(d);
      h.scheduler.noteStop(d.id);
      return ok;
    });
    await tickAt(h, 0);
    expect(planned(h)[0]).toMatchObject({ status: 'cancelled' });
    expect(h.db.select().from(runs).all()).toHaveLength(0);
  });

  it('skips devices that are offline or have a blocking alarm', async () => {
    const h = await setup();
    await createSchedule(h, {
      sequential: false,
      items: [
        { deviceId: MOCK_IDS.veggies, seconds: 600 },
        { deviceId: MOCK_IDS.backFence, seconds: 600 },
      ],
    });
    await tickAt(h, 0);
    expect(planned(h).map((p) => [p.status, p.skipReason])).toEqual([
      ['skipped', 'Alarm: no water'],
      ['skipped', 'Device offline'],
    ]);
    expect(startCalls(h)).toHaveLength(0);
  });

  it('waits while the gateway is busy with another run', async () => {
    const h = await setup();
    await createSchedule(h, { items: [{ deviceId: MOCK_IDS.dripA, seconds: 300 }] });
    // A manual 10-minute run on another zone of the same gateway, started a minute before.
    vi.setSystemTime(at(-1));
    const res = await h.app.request(`/api/devices/${MOCK_IDS.frontLawn}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seconds: 600 }),
    });
    expect(res.status).toBe(200);
    await tickAt(h, 0);
    expect(statuses(h)).toEqual(['13_1#1:planned']);
    await tickAt(h, 9.5);
    expect(statuses(h)).toEqual(['13_1#1:running']);
  });

  it('skips runs missed by more than 10 minutes while down', async () => {
    const h = await setup();
    await createSchedule(h);
    // A fresh engine (as after a restart) first ticks 15 minutes late.
    const engine = new SchedulerEngine({ db: h.db, executor: h.executor });
    vi.setSystemTime(at(15));
    await engine.tick();
    expect(planned(h)[0]).toMatchObject({ status: 'skipped' });
    expect(planned(h)[0]!.skipReason).toMatch(/^Missed \(Wed 6:00 AM\): Hoseidon was offline/);
    expect(h.db.select().from(events).where(eq(events.type, 'schedule.missed')).all()).toHaveLength(
      1,
    );
    expect(startCalls(h)).toHaveLength(0);
  });

  it('still starts a run that is less than 10 minutes late', async () => {
    const h = await setup();
    await createSchedule(h);
    await tickAt(h, 8);
    expect(planned(h)[0]!.status).toBe('running');
  });

  it('skips the rest of an occurrence missed mid-way after a restart', async () => {
    const h = await setup();
    await createSchedule(h, {
      items: [
        { deviceId: MOCK_IDS.frontLawn, seconds: 600 },
        { deviceId: MOCK_IDS.dripA, seconds: 600 },
      ],
    });
    await tickAt(h, 0);
    // Down from 06:01 until 06:40: the lawn finished at 06:10, drip was due then.
    const engine = new SchedulerEngine({ db: h.db, executor: h.executor });
    vi.setSystemTime(at(40));
    await h.poller.pollRunning();
    await engine.tick();
    expect(planned(h).map((p) => [p.status, p.skipReason])).toEqual([
      ['done', null],
      ['skipped', 'Missed: Hoseidon was offline'],
    ]);
  });

  it('applies weather skip rules per occurrence', async () => {
    const outlook: WeatherOutlook = {
      rainMm: 8,
      minTempC: 12,
      maxWindKph: 10,
      et0Mm: 3,
      et0BaselineMm: 4,
    };
    const weather: WeatherProvider = { outlook: vi.fn(async () => outlook) };
    const h = await setup({ engine: { weather } });
    h.db.update(gateways).set({ lat: 40.7, lon: -74 }).run();
    await createSchedule(h, {
      items: [
        { deviceId: MOCK_IDS.frontLawn, seconds: 600 },
        { deviceId: MOCK_IDS.dripA, seconds: 600 },
      ],
      skipRules: { rainForecastMm: 5 },
    });
    await tickAt(h, 0);
    expect(planned(h).map((p) => [p.status, p.skipReason])).toEqual([
      ['skipped', '8 mm rain forecast'],
      ['skipped', '8 mm rain forecast'],
    ]);
    expect(weather.outlook).toHaveBeenCalledTimes(1);
    const ev = h.db.select().from(events).where(eq(events.type, 'schedule.skipped')).all();
    expect(ev).toHaveLength(1);
    expect(ev[0]!.message).toBe('8 mm rain forecast');
  });

  it('scales durations by ET₀', async () => {
    const weather: WeatherProvider = {
      outlook: async () => ({
        rainMm: 0,
        minTempC: 15,
        maxWindKph: 5,
        et0Mm: 3,
        et0BaselineMm: 4,
      }),
    };
    const h = await setup({ engine: { weather } });
    h.db.update(gateways).set({ lat: 40.7, lon: -74 }).run();
    await createSchedule(h, {
      items: [{ deviceId: MOCK_IDS.frontLawn, seconds: 1200 }],
      skipRules: { etScaling: true },
    });
    await tickAt(h, 0);
    expect(planned(h)[0]).toMatchObject({ status: 'running', scale: 0.75, seconds: 900 });
    expect(startCalls(h)[0]?.body).toMatchObject({ duration: 15 });
  });

  it('ignores skip rules when the gateway has no location', async () => {
    const weather: WeatherProvider = { outlook: vi.fn(async () => null) };
    const h = await setup({ engine: { weather } });
    await createSchedule(h, { skipRules: { rainForecastMm: 0 } });
    await tickAt(h, 0);
    expect(planned(h)[0]!.status).toBe('running');
    expect(weather.outlook).not.toHaveBeenCalled();
  });

  it('cancels later cycles when the user stops a run', async () => {
    const h = await setup();
    await createSchedule(h, {
      items: [{ deviceId: MOCK_IDS.frontLawn, seconds: 1200 }],
      cycleSoak: { cycles: 2, soakMinutes: 5 },
    });
    await tickAt(h, 0);
    vi.setSystemTime(at(3));
    const res = await h.app.request(`/api/devices/${MOCK_IDS.frontLawn}/stop`, { method: 'POST' });
    expect(res.status).toBe(200);
    await tickAt(h, 4);
    expect(planned(h).map((p) => [p.status, p.skipReason])).toEqual([
      ['cancelled', null],
      ['skipped', 'Previous cycle cancelled'],
    ]);
  });

  it('closes runs whose time is up even if the poller is not running', async () => {
    const h = await setup();
    await createSchedule(h);
    vi.setSystemTime(at(0));
    await h.scheduler.tick();
    vi.setSystemTime(at(13));
    await h.scheduler.tick(); // no pollRunning
    const [p] = planned(h);
    expect(p).toMatchObject({ status: 'done', endedAt: at(10) });
    expect(h.db.select().from(runs).where(eq(runs.id, p!.runId!)).get()).toMatchObject({
      status: 'completed',
      durationSec: 600,
    });
  });

  it('re-plans upcoming runs on edit without touching ones under way', async () => {
    const h = await setup();
    const s = await createSchedule(h, {
      items: [
        { deviceId: MOCK_IDS.frontLawn, seconds: 600 },
        { deviceId: MOCK_IDS.dripA, seconds: 600 },
      ],
    });
    await tickAt(h, 0);
    vi.setSystemTime(at(1));
    const res = await h.app.request(`/api/schedules/${s.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ deviceId: MOCK_IDS.sideYard, seconds: 300 }] }),
    });
    expect(res.status).toBe(200);
    // Today's occurrence keeps its plan; tomorrow's now waters the side yard.
    expect(statuses(h)).toEqual(['0011#1:running', '13_1#1:planned']);
    const tomorrow = h.db
      .select()
      .from(plannedRuns)
      .where(eq(plannedRuns.occurrenceAt, at(24 * 60)))
      .all();
    expect(tomorrow.map((p) => p.deviceId)).toEqual([MOCK_IDS.sideYard]);
  });

  it('drops upcoming runs when disabled', async () => {
    const h = await setup();
    const s = await createSchedule(h);
    await h.app.request(`/api/schedules/${s.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(h.db.select().from(plannedRuns).all()).toHaveLength(0);
    await tickAt(h, 0);
    expect(startCalls(h)).toHaveLength(0);
  });

  describe('a restart (or a Cloudflare deploy) in the middle of a launch', () => {
    /** The slot was claimed and maybe the start sent, then the process died. */
    async function interrupted(h: H) {
      await createSchedule(h);
      vi.setSystemTime(at(0));
      const [row] = planned(h);
      h.db
        .update(plannedRuns)
        .set({ status: 'running', updatedAt: at(0) })
        .where(eq(plannedRuns.id, row!.id))
        .run();
      return row!;
    }

    it('never re-sends, and fails the run when nothing shows it started', async () => {
      const h = await setup();
      await interrupted(h);
      const fresh = new SchedulerEngine({ db: h.db, executor: h.executor });
      vi.setSystemTime(at(2));
      await fresh.tick();
      expect(planned(h)[0]!.status).toBe('running'); // still waiting for evidence
      vi.setSystemTime(at(6));
      await fresh.tick();
      expect(planned(h)[0]).toMatchObject({
        status: 'failed',
        error: 'Interrupted while starting',
      });
      expect(startCalls(h)).toHaveLength(0);
    });

    it('adopts the run LinkTap reports, and flags it', async () => {
      const h = await setup();
      const row = await interrupted(h);
      // The start did go out: the poller later saw the zone watering.
      h.db
        .insert(runs)
        .values({
          deviceId: MOCK_IDS.frontLawn,
          startedAt: at(0.2),
          plannedSec: null,
          source: 'linktap',
          status: 'running',
        })
        .run();
      const fresh = new SchedulerEngine({ db: h.db, executor: h.executor });
      vi.setSystemTime(at(6));
      await fresh.tick();
      const p = planned(h)[0]!;
      expect(p.status).toBe('running');
      expect(p.runId).not.toBeNull();
      const run = h.db.select().from(runs).where(eq(runs.id, p.runId!)).get()!;
      expect(run).toMatchObject({ source: 'hoseidon', scheduleId: row.scheduleId });
      expect(
        h.db
          .select()
          .from(events)
          .all()
          .some((e) => e.type === 'schedule.run_unverified'),
      ).toBe(true);
      expect(startCalls(h)).toHaveLength(0);
    });
  });

  it('does not overlap ticks', async () => {
    const h = await setup();
    await createSchedule(h);
    vi.setSystemTime(at(0));
    await Promise.all([h.scheduler.tick(), h.scheduler.tick()]);
    expect(startCalls(h)).toHaveLength(1);
  });
});
