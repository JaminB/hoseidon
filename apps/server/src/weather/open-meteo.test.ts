import { describe, expect, it, vi } from 'vitest';
import { openDb } from '../db';
import { weatherDaily } from '../db/schema';
import { ARCHIVE_URL, FORECAST_URL, OpenMeteoProvider, locationKey } from './open-meteo';
import { createMockOpenMeteo } from './mock';

const FIXED = () => new Date('2026-06-10T15:00:00Z');
const fixedMock = createMockOpenMeteo(FIXED);
const LOC = { lat: 40.7128, lon: -74.006, timezone: 'America/New_York' };

function setup(start = '2026-06-10T15:00:00Z') {
  const { db } = openDb(':memory:');
  let now = new Date(start);
  const urls: URL[] = [];
  const impl = vi.fn<typeof fetch>(async (input, init) => {
    urls.push(new URL(String(input)));
    return createMockOpenMeteo(() => now)(input, init);
  });
  const log = vi.fn();
  const weather = new OpenMeteoProvider({ db, fetch: impl, now: () => now, log });
  return {
    db,
    weather,
    impl,
    urls,
    log,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
  };
}

describe('OpenMeteoProvider', () => {
  it('fetches forecast days once and serves the rest from the cache', async () => {
    const { weather, impl, urls } = setup();
    const days = await weather.range(LOC, '2026-06-10', '2026-06-14');
    expect(days.map((d) => d.date)).toEqual([
      '2026-06-10',
      '2026-06-11',
      '2026-06-12',
      '2026-06-13',
      '2026-06-14',
    ]);
    expect(days.every((d) => d.forecast && d.rainMm !== null && d.et0Mm !== null)).toBe(true);
    expect(days[0]!.soilMoisture).toBeGreaterThan(0);
    expect(days[0]!.rainProbPct).not.toBeNull();

    expect(impl).toHaveBeenCalledTimes(1);
    const url = urls[0]!;
    expect(url.origin + url.pathname).toBe(FORECAST_URL);
    expect(url.searchParams.get('timezone')).toBe('America/New_York');
    expect(url.searchParams.get('daily')).toContain('et0_fao_evapotranspiration');
    expect(url.searchParams.get('forecast_days')).toBe('5');
    expect(url.searchParams.get('past_days')).toBe('0');

    await weather.range(LOC, '2026-06-11', '2026-06-13');
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('refreshes forecast rows after the TTL, not before', async () => {
    const { weather, impl, advance } = setup();
    await weather.range(LOC, '2026-06-10', '2026-06-12');
    advance(2 * 3_600_000);
    await weather.range(LOC, '2026-06-10', '2026-06-12');
    expect(impl).toHaveBeenCalledTimes(1);
    advance(2 * 3_600_000);
    await weather.range(LOC, '2026-06-10', '2026-06-12');
    expect(impl).toHaveBeenCalledTimes(2);
  });

  it('uses the archive for old days and never refetches them', async () => {
    const { weather, impl, urls, db, advance } = setup();
    const days = await weather.range(LOC, '2026-05-01', '2026-05-10');
    expect(days).toHaveLength(10);
    expect(days.every((d) => !d.forecast)).toBe(true);
    expect(impl).toHaveBeenCalledTimes(1);
    expect(urls[0]!.origin + urls[0]!.pathname).toBe(ARCHIVE_URL);
    expect(urls[0]!.searchParams.get('start_date')).toBe('2026-05-01');
    expect(urls[0]!.searchParams.get('end_date')).toBe('2026-05-10');
    expect(urls[0]!.searchParams.get('daily')).not.toContain('probability');

    advance(48 * 3_600_000);
    await weather.range(LOC, '2026-05-01', '2026-05-10');
    expect(impl).toHaveBeenCalledTimes(1);
    expect(db.select().from(weatherDaily).all()[0]!.source).toBe('archive');
  });

  it('splits a range across the archive and the forecast, using past_days for the recent part', async () => {
    const { weather, urls } = setup();
    const days = await weather.range(LOC, '2026-05-25', '2026-06-12');
    expect(days).toHaveLength(19);
    const [archive, forecast] = urls;
    expect(archive!.hostname).toBe('archive-api.open-meteo.com');
    expect(archive!.searchParams.get('end_date')).toBe('2026-06-02');
    expect(forecast!.hostname).toBe('api.open-meteo.com');
    expect(forecast!.searchParams.get('past_days')).toBe('7');
    expect(forecast!.searchParams.get('forecast_days')).toBe('3');
    expect(days.at(-1)!.forecast).toBe(true);
    expect(days[0]!.forecast).toBe(false);
  });

  it('upgrades a forecast row to observed values once the archive has them', async () => {
    const { weather, advance } = setup();
    const first = await weather.range(LOC, '2026-06-10', '2026-06-10');
    expect(first[0]!.forecast).toBe(true);
    advance(10 * 86_400_000);
    const later = await weather.range(LOC, '2026-06-10', '2026-06-10');
    expect(later[0]!.forecast).toBe(false);
  });

  it('shares rows between gateways at the same rounded location', async () => {
    const { weather, impl } = setup();
    await weather.range(LOC, '2026-06-10', '2026-06-11');
    await weather.range({ ...LOC, lat: 40.7149 }, '2026-06-10', '2026-06-11');
    expect(impl).toHaveBeenCalledTimes(1);
    expect(locationKey(LOC)).toBe('40.71,-74.01');
    await weather.range({ ...LOC, lat: 41.9 }, '2026-06-10', '2026-06-11');
    expect(impl).toHaveBeenCalledTimes(2);
  });

  it('serves stale cache and logs when the API fails', async () => {
    const { db, log, advance } = setup();
    let fail = false;
    const weather = new OpenMeteoProvider({
      db,
      log,
      now: () => new Date('2026-06-10T15:00:00Z'),
      fetch: async (input, init) =>
        fail ? new Response('nope', { status: 503 }) : fixedMock(input, init),
    });
    const ok = await weather.range(LOC, '2026-06-10', '2026-06-11');
    expect(ok).toHaveLength(2);
    advance(1);
    fail = true;
    // Same instant is within the TTL; ask for a day that is not cached to force a fetch.
    const partial = await weather.range(LOC, '2026-06-10', '2026-06-13');
    expect(partial).toHaveLength(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('HTTP 503'));
  });

  it('does not throw on a malformed response', async () => {
    const { db, log } = setup();
    const weather = new OpenMeteoProvider({
      db,
      log,
      fetch: async () => Response.json({ nope: true }),
    });
    await expect(weather.range(LOC, '2026-06-10', '2026-06-11')).resolves.toEqual([]);
    expect(log).toHaveBeenCalled();
  });

  describe('outlook', () => {
    it('reports today with an ET0 baseline from the previous two weeks', async () => {
      const { weather } = setup();
      const o = await weather.outlook(LOC);
      expect(o).not.toBeNull();
      expect(o!.rainMm).not.toBeNull();
      expect(o!.et0Mm).toBeGreaterThan(0);
      expect(o!.et0BaselineMm).toBeGreaterThan(0);
    });

    it('has no baseline when too little history exists', async () => {
      const { db } = setup();
      const weather = new OpenMeteoProvider({
        db,
        now: () => new Date('2026-06-10T15:00:00Z'),
        fetch: async (input, init) => {
          const url = new URL(String(input));
          // Only ever serve the forecast API, with no past days.
          if (url.hostname.startsWith('archive')) return new Response('', { status: 500 });
          url.searchParams.set('past_days', '0');
          return fixedMock(url, init);
        },
      });
      const o = await weather.outlook(LOC);
      expect(o!.et0BaselineMm).toBeNull();
    });
  });
});
