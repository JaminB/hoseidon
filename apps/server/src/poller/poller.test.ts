import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { devices, deviceSnapshots, events, gateways, runs } from '../db/schema';
import { MOCK_IDS } from '../linktap/mock';
import { harness } from '../test-utils';

describe('Poller against the mock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  const eventTypes = (h: ReturnType<typeof harness>) =>
    h.db
      .select()
      .from(events)
      .all()
      .map((e) => `${e.type}:${e.deviceId ?? e.gatewayId}`);

  it('stores gateways, devices and a snapshot per device', async () => {
    const h = harness();
    await h.poller.pollDevices();
    expect(h.poller.status().last.devices.error).toBeNull();
    expect(h.db.select().from(gateways).all()).toHaveLength(2);
    const devs = h.db.select().from(devices).all();
    expect(devs).toHaveLength(6);
    expect(devs.find((d) => d.id === MOCK_IDS.backFence)?.online).toBe(false);
    expect(devs.find((d) => d.id === MOCK_IDS.backFence)?.lastSeenAt).toBeNull();
    expect(h.db.select().from(deviceSnapshots).all()).toHaveLength(6);
    // First sight is not a transition: no events yet.
    expect(h.db.select().from(events).all()).toHaveLength(0);
  });

  it('opens a run for watering LinkTap started, then closes it via status polling', async () => {
    const h = harness();
    await h.poller.pollDevices();
    const open = h.db.select().from(runs).where(eq(runs.deviceId, MOCK_IDS.frontLawn)).all();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ source: 'linktap', status: 'running', plannedSec: 600 });
    // Started three minutes before the poll.
    expect(Date.now() - open[0]!.startedAt.getTime()).toBeCloseTo(180_000, -3);

    await h.poller.pollRunning();
    expect(h.mock.calls.filter((c) => c.endpoint === 'getWateringStatus')).toHaveLength(1);

    vi.advanceTimersByTime(8 * 60_000);
    await h.poller.pollRunning();
    const [done] = h.db.select().from(runs).where(eq(runs.deviceId, MOCK_IDS.frontLawn)).all();
    expect(done).toMatchObject({ status: 'completed', durationSec: 600 });
    const lawn = h.db.select().from(devices).where(eq(devices.id, MOCK_IDS.frontLawn)).get();
    expect(lawn?.watering).toBeNull();

    // Nothing is running any more, so the next status tick makes no calls.
    const calls = h.mock.calls.length;
    await h.poller.pollRunning();
    expect(h.mock.calls.length).toBe(calls);
  });

  it('derives offline/online, signal and alarm events from transitions', async () => {
    const h = harness();
    await h.poller.pollDevices();

    h.mock.setGatewayOnline(MOCK_IDS.garage, false);
    h.mock.find(MOCK_IDS.dripA)!.signal = 12;
    h.mock.find(MOCK_IDS.frontLawn)!.alarms.add('fallFlag');
    h.mock.find(MOCK_IDS.veggies)!.alarms.delete('noWater');
    vi.advanceTimersByTime(5 * 60_000);
    await h.poller.pollDevices();

    expect(eventTypes(h).sort()).toEqual(
      [
        `gateway.offline:${MOCK_IDS.garage}`,
        `device.offline:${MOCK_IDS.sideYard}`,
        `device.signal_low:${MOCK_IDS.dripA}`,
        `device.alarm:${MOCK_IDS.frontLawn}`,
        `device.alarm_cleared:${MOCK_IDS.veggies}`,
      ].sort(),
    );
    const side = h.db.select().from(devices).where(eq(devices.id, MOCK_IDS.sideYard)).get();
    expect(side?.online).toBe(false);
    // last_seen sticks at the last time we saw it online.
    expect(side?.lastSeenAt?.toISOString()).toBe('2026-06-01T12:00:00.000Z');

    h.mock.setGatewayOnline(MOCK_IDS.garage, true);
    vi.advanceTimersByTime(25 * 60_000);
    await h.poller.pollDevices();
    const back = h.db.select().from(events).where(eq(events.type, 'gateway.online')).get();
    expect(back?.message).toBe('Offline for about 30 min');
    expect(eventTypes(h)).toContain(`device.online:${MOCK_IDS.sideYard}`);
  });

  it('ingests history into runs, merging with known runs and staying idempotent', async () => {
    const h = harness();
    await h.poller.pollDevices();
    // First pick: a device never fetched (alphabetical order of id is fine, any will do).
    await h.poller.pollHistoryNext();
    const fetched = h.db
      .select()
      .from(devices)
      .all()
      .filter((d) => d.historyFetchedAt !== null);
    expect(fetched).toHaveLength(1);
    const id = fetched[0]!.id;
    const count = h.db.select().from(runs).where(eq(runs.deviceId, id)).all().length;
    expect(count).toBeGreaterThan(3);

    // Re-ingesting the same history adds nothing.
    const entries = await h.client.getWateringHistory(
      { gatewayId: fetched[0]!.gatewayId, taplinkerId: id },
      'UTC',
    );
    const { ingestHistory } = await import('./ingest');
    expect(ingestHistory(h.db, id, entries, new Date())).toEqual({ added: 0, updated: 0 });
  });

  it('fills in volume for a finished run when history arrives, and prioritizes that device', async () => {
    const h = harness();
    await h.poller.pollDevices();
    // Fetch history for everyone once.
    for (let i = 0; i < 6; i++) await h.poller.pollHistoryNext();

    vi.advanceTimersByTime(8 * 60_000); // the lawn run finishes
    await h.poller.pollRunning();
    const lawnRun = () =>
      h.db
        .select()
        .from(runs)
        .where(eq(runs.deviceId, MOCK_IDS.frontLawn))
        .all()
        .find((r) => r.plannedSec === 600)!;
    expect(lawnRun().volumeMl).not.toBe(3800 * 10);

    vi.advanceTimersByTime(60_000);
    await h.poller.pollHistoryNext();
    expect(h.mock.calls.at(-1)?.body.taplinkerId).toBe(MOCK_IDS.frontLawn);
    expect(lawnRun()).toMatchObject({ status: 'completed', durationSec: 600, volumeMl: 38_000 });
  });

  it('one device failing history does not starve the others', async () => {
    const h = harness();
    await h.poller.pollDevices();
    const real = h.mock.handle.bind(h.mock);
    const tried: unknown[] = [];
    h.mock.handle = (endpoint, body) => {
      if (endpoint !== 'getWateringHistory') return real(endpoint, body);
      tried.push(body.taplinkerId);
      return tried.length === 1 ? { result: 'error', message: 'boom' } : real(endpoint, body);
    };
    await h.poller.pollHistoryNext();
    vi.advanceTimersByTime(1000);
    await h.poller.pollHistoryNext();
    expect(tried).toHaveLength(2);
    expect(tried[0]).not.toBe(tried[1]);
  });

  it('a stale "still watering" sample does not reopen a run that closed meanwhile', async () => {
    const h = harness();
    await h.poller.pollDevices();
    const { ingestWateringStatus, openRun, closeRun } = await import('./ingest');
    const sampledAt = new Date();
    vi.advanceTimersByTime(1000);
    const open = openRun(h.db, MOCK_IDS.frontLawn)!;
    closeRun(h.db, open, new Date(), 'stopped');
    vi.advanceTimersByTime(1000);
    ingestWateringStatus(
      h.db,
      MOCK_IDS.frontLawn,
      { remainingSec: 300, totalSec: 600, flowMlPerMin: null, volumeMl: null },
      new Date(),
      sampledAt,
    );
    expect(openRun(h.db, MOCK_IDS.frontLawn)).toBeUndefined();
  });

  it('running outlets take turns at the account-wide status limit', async () => {
    const h = harness({ realLimits: true });
    // Front Lawn is already running (seeded); start Drip A too, then let the poller see both.
    await h.client.startWatering({
      gatewayId: MOCK_IDS.backyard,
      taplinkerId: MOCK_IDS.dripA,
      seconds: 600,
    });
    await h.poller.pollDevices();
    const polled = () =>
      h.mock.calls.filter((c) => c.endpoint === 'getWateringStatus').map((c) => c.body.taplinkerId);

    await h.poller.pollRunning();
    expect(polled()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(31_000);
    await h.poller.pollRunning();
    await vi.advanceTimersByTimeAsync(31_000);
    await h.poller.pollRunning();
    const seen = polled();
    expect(seen).toHaveLength(3);
    expect(new Set(seen.slice(0, 2))).toEqual(new Set([MOCK_IDS.frontLawn, MOCK_IDS.dripA]));
    expect(seen[2]).toBe(seen[0]);
    // The enforcing mock never had to reject a call.
    expect(h.poller.status().last.status.error).toBeNull();
  });

  it('a rate-limited status poll is not a device failure', async () => {
    const h = harness();
    await h.poller.pollDevices();
    const { LinkTapError } = await import('../linktap/client');
    vi.spyOn(h.client, 'getWateringStatus').mockRejectedValueOnce(
      new LinkTapError(
        'getWateringStatus',
        'The minimum interval of calling this API is 30 seconds.',
        'rate_limit',
      ),
    );
    await h.poller.pollRunning();
    expect(h.poller.status().last.status.error).toBeNull();
    // The run is untouched and the next tick polls it again.
    expect(
      h.db.select().from(runs).where(eq(runs.deviceId, MOCK_IDS.frontLawn)).get()?.status,
    ).toBe('running');
    await h.poller.pollRunning();
    expect(h.mock.calls.filter((c) => c.endpoint === 'getWateringStatus')).toHaveLength(1);
  });

  it('closes a run on the post-run {"dur"} status and reconciles it from history', async () => {
    const h = harness();
    await h.poller.pollDevices();
    vi.advanceTimersByTime(8 * 60_000); // the 10-minute lawn run (3 min in) is over
    const reply = await h.mock.transport()('getWateringStatus', {
      username: 'u',
      apiKey: 'k',
      gatewayId: MOCK_IDS.backyard,
      taplinkerId: MOCK_IDS.frontLawn,
    });
    expect(reply).toEqual({ result: 'ok', status: { dur: '600' } });

    await h.poller.pollRunning();
    const run = () =>
      h.db
        .select()
        .from(runs)
        .where(eq(runs.deviceId, MOCK_IDS.frontLawn))
        .all()
        .find((r) => r.plannedSec === 600)!;
    expect(run()).toMatchObject({ status: 'completed', volumeMl: null });
    const lawn = h.db.select().from(devices).where(eq(devices.id, MOCK_IDS.frontLawn)).get();
    expect(lawn?.watering).toBeNull();

    expect(await h.poller.reconcileHistory(MOCK_IDS.frontLawn)).toBe(true);
    expect(run()).toMatchObject({ status: 'completed', durationSec: 600, volumeMl: 38_000 });
  });

  it('when running, fetches history shortly after a status poll sees a run end', async () => {
    const h = harness();
    h.poller.start();
    await vi.advanceTimersByTimeAsync(0); // first getAllDevices
    vi.setSystemTime(Date.now() + 8 * 60_000);
    const before = h.mock.calls.filter((c) => c.endpoint === 'getWateringHistory').length;
    await h.poller.pollRunning();
    await vi.advanceTimersByTimeAsync(5_000);
    const history = h.mock.calls.filter((c) => c.endpoint === 'getWateringHistory');
    expect(history.length).toBe(before + 1);
    expect(history.at(-1)?.body.taplinkerId).toBe(MOCK_IDS.frontLawn);
    h.poller.stop();
  });

  it('a null status in the first minute after a start does not close the run (start latency)', async () => {
    const h = harness();
    await h.poller.pollDevices();
    const { ingestWateringStatus, openRun, recordStart, START_GRACE_MS } = await import('./ingest');
    h.db.transaction((tx) =>
      recordStart(tx, { deviceId: MOCK_IDS.dripA, seconds: 60, now: new Date() }),
    );
    vi.advanceTimersByTime(12_000);
    ingestWateringStatus(h.db, MOCK_IDS.dripA, null, new Date());
    expect(openRun(h.db, MOCK_IDS.dripA)).toBeDefined();
    vi.advanceTimersByTime(START_GRACE_MS);
    expect(ingestWateringStatus(h.db, MOCK_IDS.dripA, null, new Date())).toEqual({ closed: true });
    expect(openRun(h.db, MOCK_IDS.dripA)).toBeUndefined();
  });

  it('records errors without throwing', async () => {
    const h = harness();
    h.mock.handle = () => ({ result: 'error', message: 'nope' });
    await h.poller.pollDevices();
    expect(h.poller.status().last.devices.error).toMatch(/nope/);
  });

  it('start() polls on intervals and stop() stops', async () => {
    const h = harness();
    h.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.mock.calls.filter((c) => c.endpoint === 'getAllDevices')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(h.mock.calls.filter((c) => c.endpoint === 'getAllDevices')).toHaveLength(2);
    expect(h.mock.calls.some((c) => c.endpoint === 'getWateringStatus')).toBe(true);
    expect(h.mock.calls.some((c) => c.endpoint === 'getWateringHistory')).toBe(true);
    h.poller.stop();
    const n = h.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(h.mock.calls.length).toBe(n);
  });
});
