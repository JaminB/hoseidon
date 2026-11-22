import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { gateways } from '../db/schema';
import { harness } from '../test-utils';
import {
  mockGeocodeFetch,
  parseLinkTapLocation,
  pickPlace,
  resolveGatewayLocation,
  resolveLocation,
  type GeoPlace,
} from './location';

const HI: GeoPlace = {
  name: 'Mountain View',
  latitude: 21.3,
  longitude: -157.8,
  timezone: 'Pacific/Honolulu',
  country: 'United States',
  country_code: 'US',
  admin1: 'Hawaii',
};
const CA: GeoPlace = {
  name: 'Mountain View',
  latitude: 37.38605,
  longitude: -122.08385,
  timezone: 'America/Los_Angeles',
  country: 'United States',
  country_code: 'US',
  admin1: 'California',
};

describe('parseLinkTapLocation', () => {
  it('parses a short code with a locality', () => {
    expect(parseLinkTapLocation('CWC8+R9 Mountain View, CA, USA')).toEqual({
      kind: 'short',
      code: 'CWC8+R9',
      locality: 'Mountain View, CA, USA',
    });
  });

  it('parses a full code', () => {
    expect(parseLinkTapLocation('849VCWC8+R9')).toMatchObject({ kind: 'full' });
    expect(parseLinkTapLocation('849VCWC8+R9 Mountain View, CA, USA')).toMatchObject({
      kind: 'full',
      locality: 'Mountain View, CA, USA',
    });
  });

  it('rejects things that are not plus codes', () => {
    for (const s of ['Not specified', '', '   ', null, undefined, 'Home', '12 Main St, Town']) {
      expect(parseLinkTapLocation(s)).toBeNull();
    }
    // A short code with no locality can't be placed.
    expect(parseLinkTapLocation('CWC8+R9')).toBeNull();
  });
});

describe('pickPlace', () => {
  it('matches state abbreviations and country aliases', () => {
    expect(pickPlace('Mountain View, CA, USA', [HI, CA])).toBe(CA);
    expect(pickPlace('Mountain View, HI, USA', [CA, HI])).toBe(HI);
    expect(pickPlace('Mountain View, California, United States', [HI, CA])).toBe(CA);
  });

  it('takes the first result for a bare city, and null when hints match nothing', () => {
    expect(pickPlace('Mountain View', [HI, CA])).toBe(HI);
    expect(pickPlace('Mountain View, TX, USA', [HI, CA])).toBe(HI); // country only, first wins
    expect(pickPlace('Mountain View, ON, Canada', [HI, CA])).toBeNull();
    expect(pickPlace('Nowhere, CA, USA', [])).toBeNull();
  });
});

describe('resolveLocation', () => {
  it('recovers a short code near the locality and reads the time zone', async () => {
    const short = await resolveLocation(
      parseLinkTapLocation('CWC8+R9 Mountain View, CA, USA')!,
      mockGeocodeFetch,
    );
    expect(short).toEqual({ lat: 37.42206, lon: -122.08406, timezone: 'America/Los_Angeles' });
    // The full code decodes to the same centre.
    const full = await resolveLocation(
      parseLinkTapLocation('849VCWC8+R9 Mountain View, CA, USA')!,
      mockGeocodeFetch,
    );
    expect(full).toEqual(short);
  });

  it('decodes a bare full code without any geocoding', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const out = await resolveLocation(parseLinkTapLocation('849VCWC8+R9')!, fetchFn);
    expect(out).toEqual({ lat: 37.42206, lon: -122.08406, timezone: null });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('returns null when the locality is unknown', async () => {
    const out = await resolveLocation(
      parseLinkTapLocation('CWC8+R9 Atlantis, ZZ, USA')!,
      mockGeocodeFetch,
    );
    expect(out).toBeNull();
  });
});

describe('resolveGatewayLocation', () => {
  const setup = () => {
    const h = harness();
    const id = 'A1B2C3D4004B1200';
    h.db.insert(gateways).values({ id, linktapName: 'GW', updatedAt: new Date() }).run();
    const set = (v: Partial<typeof gateways.$inferInsert>) =>
      h.db.update(gateways).set(v).where(eq(gateways.id, id)).run();
    const get = () => h.db.select().from(gateways).where(eq(gateways.id, id)).get()!;
    return { h, id, set, get };
  };

  it('sets lat/lon/timezone once, and only re-geocodes when the string changes', async () => {
    const { h, id, set, get } = setup();
    set({ locationRaw: 'CWC8+R9 Mountain View, CA, USA' });
    const fetchFn = vi.fn(mockGeocodeFetch);
    expect(await resolveGatewayLocation(h.db, id, { fetch: fetchFn })).toBe(true);
    expect(get()).toMatchObject({
      lat: 37.42206,
      lon: -122.08406,
      timezone: 'America/Los_Angeles',
      locationSource: 'linktap',
    });
    // Same string: no more geocoding.
    expect(await resolveGatewayLocation(h.db, id, { fetch: fetchFn })).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // New string: resolves again.
    set({ locationRaw: '849VCWC8+R9' });
    expect(await resolveGatewayLocation(h.db, id, { fetch: fetchFn })).toBe(true);
  });

  it('never overwrites a manual location', async () => {
    const { h, id, set, get } = setup();
    set({ lat: 1, lon: 2, timezone: 'UTC', locationSource: 'manual', locationRaw: '849VCWC8+R9' });
    const fetchFn = vi.fn(mockGeocodeFetch);
    expect(await resolveGatewayLocation(h.db, id, { fetch: fetchFn })).toBe(false);
    expect(get()).toMatchObject({ lat: 1, lon: 2, locationSource: 'manual' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('leaves unparseable strings unset, logs, and does not retry', async () => {
    const { h, id, set, get } = setup();
    set({ locationRaw: 'Home sweet home' });
    const log = vi.fn();
    const fetchFn = vi.fn(mockGeocodeFetch);
    expect(await resolveGatewayLocation(h.db, id, { fetch: fetchFn, log })).toBe(false);
    expect(await resolveGatewayLocation(h.db, id, { fetch: fetchFn, log })).toBe(false);
    expect(get()).toMatchObject({ lat: null, lon: null, locationSource: null });
    expect(log).toHaveBeenCalledTimes(1);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('retries after a network failure', async () => {
    const { h, id, set, get } = setup();
    set({ locationRaw: 'CWC8+R9 Mountain View, CA, USA' });
    const failing = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await resolveGatewayLocation(h.db, id, { fetch: failing, log: vi.fn() })).toBe(false);
    expect(get().locationResolvedFor).toBeNull();
    expect(await resolveGatewayLocation(h.db, id, { fetch: mockGeocodeFetch })).toBe(true);
  });
});
