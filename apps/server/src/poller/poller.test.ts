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
