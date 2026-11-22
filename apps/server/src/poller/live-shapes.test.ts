import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Gateway, GatewayWithDevices } from '@hoseidon/shared';
import { devices, deviceSnapshots, events, gateways, runs } from '../db/schema';
import { mockGeocodeFetch } from '../linktap/location';
import { MOCK_IDS } from '../linktap/mock';
import { harness } from '../test-utils';

/** The poller/API behaviour that came out of the first live capture (2026-11-22). */
describe('live API shapes through the poller', () => {
  it('stores gateway firmware and the device extras (dType, flow meter, vel, plan)', async () => {
    const h = harness();
    await h.poller.pollDevices();
    const gw = h.db.select().from(gateways).where(eq(gateways.id, MOCK_IDS.backyard)).get();
    expect(gw?.version).toBe('G0609472606040836I_C0502012507221443');
    const drip = h.db.select().from(devices).where(eq(devices.id, MOCK_IDS.dripA)).get();
    expect(drip).toMatchObject({ dType: 16, flowMeter: true, flowMlPerMin: 0 });
    expect(drip?.plan).toMatchObject({ action: false });
    // No flow meter on the veggie beds; no dType on a single-outlet device.
    const veg = h.db.select().from(devices).where(eq(devices.id, MOCK_IDS.veggies)).get();
    expect(veg).toMatchObject({ dType: null, flowMeter: false });
    // vel is captured on the snapshot even though nothing was watering there.
    const snap = h.db
      .select()
      .from(deviceSnapshots)
      .where(eq(deviceSnapshots.deviceId, MOCK_IDS.dripA))
      .get();
    expect(snap).toMatchObject({ watering: false, flowMlPerMin: 0 });
    // The running outlet reports its flow.
    const lawn = h.db.select().from(devices).where(eq(devices.id, MOCK_IDS.frontLawn)).get();
    expect(lawn?.flowMlPerMin).toBe(3800);
  });

  it('turns the `fall` flag into the fall alarm and an event', async () => {
    const h = harness();
    await h.poller.pollDevices();
    h.mock.find(MOCK_IDS.frontLawn)!.alarms.add('fallFlag');
    await h.poller.pollDevices();
    const lawn = h.db.select().from(devices).where(eq(devices.id, MOCK_IDS.frontLawn)).get();
    expect(lawn?.alarms).toEqual(['fallFlag']);
    expect(
      h.db
        .select()
        .from(events)
        .all()
        .map((e) => e.type),
    ).toContain('device.alarm');
  });

  it('sets the gateway location from LinkTap, once, and shows where it came from', async () => {
    const h = harness({ geocode: mockGeocodeFetch });
    await h.poller.pollDevices();
    const list = (await (await h.app.request('/api/gateways')).json()) as GatewayWithDevices[];
    const backyard = list.find((g) => g.id === MOCK_IDS.backyard)!;
    expect(backyard).toMatchObject({
      lat: 37.42206,
      lon: -122.08406,
      timezone: 'America/Los_Angeles',
      locationSource: 'linktap',
      linktapLocation: 'CWC8+R9 Mountain View, CA, USA',
      version: 'G0609472606040836I_C0502012507221443',
    });
    // "Not specified" stays unset.
    expect(list.find((g) => g.id === MOCK_IDS.garage)).toMatchObject({
      lat: null,
      locationSource: null,
      linktapLocation: null,
    });
  });

  it('a manual location wins and survives later polls; reverting re-derives from LinkTap', async () => {
    const h = harness({ geocode: mockGeocodeFetch });
    await h.poller.pollDevices();
    const patch = async (body: object) => {
      const res = await h.app.request(`/api/gateways/${MOCK_IDS.backyard}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as Gateway;
    };
    expect(await patch({ lat: 40, lon: -105, timezone: 'America/Denver' })).toMatchObject({
      lat: 40,
      locationSource: 'manual',
    });
    await h.poller.pollDevices();
    const row = () => h.db.select().from(gateways).where(eq(gateways.id, MOCK_IDS.backyard)).get();
    expect(row()).toMatchObject({ lat: 40, lon: -105, timezone: 'America/Denver' });

    await patch({ useLinktapLocation: true });
    await h.poller.resolveLocations();
    expect(row()).toMatchObject({ lat: 37.42206, locationSource: 'linktap' });
  });

  it('ingests live-shaped history: end time, mode, no zero-length runs', async () => {
    const h = harness();
    await h.poller.pollDevices();
    h.db.delete(runs).run();
    await h.poller.pollHistoryNext();
    const rows = h.db.select().from(runs).all();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.durationSec! > 0 && r.mode === 'M')).toBe(true);
  });
});
