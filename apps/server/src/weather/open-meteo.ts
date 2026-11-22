import { and, eq, gte, lte } from 'drizzle-orm';
import { z } from 'zod';
import type { WeatherDay } from '@hoseidon/shared';
import type { Db } from '../db/types';
import { weatherDaily, type WeatherDailyRow } from '../db/schema';
import type { WeatherLocation, WeatherOutlook, WeatherProvider } from '../schedule/weather';
import { addDays, dateInZone, dateRange, diffDays, isValidTimeZone } from './dates';

export const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
export const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';

/** Forecast rows are refreshed at most this often. */
const FORECAST_TTL_MS = 3 * 3_600_000;
/** The archive lags real time by days; anything newer comes from the forecast API. */
const ARCHIVE_LAG_DAYS = 7;
const MAX_PAST_DAYS = 92;
const MAX_FORECAST_DAYS = 16;
/** ET0 "normal" = the mean of this many days before today, if enough of them are known. */
const BASELINE_DAYS = 14;
const BASELINE_MIN_DAYS = 7;

const DAILY_FIELDS = [
  'precipitation_sum',
  'et0_fao_evapotranspiration',
  'temperature_2m_max',
  'temperature_2m_min',
  'wind_speed_10m_max',
];

const series = z.array(z.number().nullable()).optional();
const responseSchema = z.looseObject({
  daily: z.looseObject({
    time: z.array(z.string()),
    precipitation_sum: series,
    precipitation_probability_max: series,
    et0_fao_evapotranspiration: series,
    temperature_2m_max: series,
    temperature_2m_min: series,
    wind_speed_10m_max: series,
  }),
  hourly: z
    .looseObject({
      time: z.array(z.string()),
      soil_moisture_0_to_7cm: series,
    })
    .optional(),
});
type Response = z.infer<typeof responseSchema>;

export interface WeatherServiceOptions {
  db: Db;
  /** Injected for tests and the offline mock. Default: global fetch. */
  fetch?: typeof fetch;
  now?: () => Date;
  log?: (msg: string) => void;
}

export const locationKey = (loc: Pick<WeatherLocation, 'lat' | 'lon'>) =>
  `${loc.lat.toFixed(2)},${loc.lon.toFixed(2)}`;

const round = (n: number | null | undefined, digits = 2) =>
  n == null ? null : Math.round(n * 10 ** digits) / 10 ** digits;

/**
 * Open-Meteo weather, cached per day and location in `weather_daily`. Forecast days are refetched
 * every few hours; once the archive has observed values for a day it is final.
 */
export class OpenMeteoProvider implements WeatherProvider {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly o: WeatherServiceOptions) {
    // Wrapped: workerd rejects fetch called as a method of another object (this.fetchFn(...)).
    this.fetchFn = o.fetch ?? ((input, init) => fetch(input, init));
    this.now = o.now ?? (() => new Date());
  }

  /** Today's date at the location. */
  today(loc: Pick<WeatherLocation, 'timezone'>): string {
    return dateInZone(this.now(), isValidTimeZone(loc.timezone) ? loc.timezone : 'UTC');
  }

  /** Daily weather from `from` to `to` (local dates, inclusive), fetching whatever is missing. */
  async range(loc: WeatherLocation, from: string, to: string): Promise<WeatherDay[]> {
    const key = locationKey(loc);
    await this.ensure(loc, key, from, to);
    return this.o.db
      .select()
      .from(weatherDaily)
      .where(
        and(
          eq(weatherDaily.locationKey, key),
          gte(weatherDaily.date, from),
          lte(weatherDaily.date, to),
        ),
      )
      .orderBy(weatherDaily.date)
      .all()
      .map(toDay);
  }

  async outlook(loc: WeatherLocation): Promise<WeatherOutlook | null> {
    const today = this.today(loc);
    const days = await this.range(loc, addDays(today, -BASELINE_DAYS), today);
    const t = days.find((d) => d.date === today);
    if (!t) return null;
    const past = days
      .filter((d) => d.date < today && d.et0Mm !== null)
      .map((d) => d.et0Mm as number);
    const baseline =
      past.length >= BASELINE_MIN_DAYS ? past.reduce((a, b) => a + b, 0) / past.length : null;
    return {
      rainMm: t.rainMm,
      minTempC: t.tMinC,
      maxWindKph: t.windMaxKph,
      et0Mm: t.et0Mm,
      et0BaselineMm: round(baseline),
    };
  }

  // ---- cache ----------------------------------------------------------------------------------

  private async ensure(loc: WeatherLocation, key: string, from: string, to: string) {
    const today = this.today(loc);
    const horizon = addDays(today, MAX_FORECAST_DAYS - 1);
    const wanted = dateRange(from, to < horizon ? to : horizon);
    if (!wanted.length) return;

    const cached = new Map(
      this.o.db
        .select()
        .from(weatherDaily)
        .where(
          and(
            eq(weatherDaily.locationKey, key),
            gte(weatherDaily.date, wanted[0]!),
            lte(weatherDaily.date, wanted[wanted.length - 1]!),
          ),
        )
        .all()
        .map((r) => [r.date, r]),
    );
    const nowMs = this.now().getTime();
    const stale = (d: string) => {
      const row = cached.get(d);
      return (
        !row || (row.source === 'forecast' && nowMs - row.fetchedAt.getTime() > FORECAST_TTL_MS)
      );
    };
    const need = wanted.filter(stale);
    if (!need.length) return;

    const archiveCutoff = addDays(today, -ARCHIVE_LAG_DAYS);
    const archive = need.filter((d) => d < archiveCutoff);
    const recent = need.filter((d) => d >= archiveCutoff);
    if (archive.length) {
      await this.fetchInto(loc, key, ARCHIVE_URL, {
        start_date: archive[0]!,
        end_date: archive[archive.length - 1]!,
      });
    }
    if (recent.length) {
      const first = recent[0]!;
      const last = recent[recent.length - 1]!;
      await this.fetchInto(
        loc,
        key,
        FORECAST_URL,
        {
          past_days: String(Math.min(MAX_PAST_DAYS, Math.max(0, diffDays(today, first)))),
          forecast_days: String(
            Math.min(MAX_FORECAST_DAYS, Math.max(1, diffDays(last, today) + 1)),
          ),
        },
        'precipitation_probability_max',
      );
    }
  }

  /** A failed fetch is logged and leaves the cache as it was: callers get what we have. */
  private async fetchInto(
    loc: WeatherLocation,
    key: string,
    base: string,
    params: Record<string, string>,
    extraDaily?: string,
  ) {
    try {
      const url = new URL(base);
      url.searchParams.set('latitude', String(loc.lat));
      url.searchParams.set('longitude', String(loc.lon));
      url.searchParams.set(
        'daily',
        [...DAILY_FIELDS, ...(extraDaily ? [extraDaily] : [])].join(','),
      );
      url.searchParams.set('hourly', 'soil_moisture_0_to_7cm');
      url.searchParams.set('timezone', isValidTimeZone(loc.timezone) ? loc.timezone : 'auto');
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

      const res = await this.fetchFn(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
      const data = responseSchema.parse(await res.json());
      this.store(key, data, base === FORECAST_URL);
    } catch (err) {
      this.o.log?.(`weather: ${(err as Error).message}`);
    }
  }

  private store(key: string, data: Response, isForecast: boolean) {
    const { daily, hourly } = data;
    const soil = new Map<string, number[]>();
    hourly?.time.forEach((t, i) => {
      const v = hourly.soil_moisture_0_to_7cm?.[i];
      if (v == null) return;
      const date = t.slice(0, 10);
      soil.set(date, [...(soil.get(date) ?? []), v]);
    });
    const fetchedAt = this.now();
    const rows = daily.time.map((date, i): WeatherDailyRow => {
      const rainMm = round(daily.precipitation_sum?.[i]);
      const s = soil.get(date);
      return {
        locationKey: key,
        date,
        rainMm,
        rainProbPct: round(daily.precipitation_probability_max?.[i], 0),
        et0Mm: round(daily.et0_fao_evapotranspiration?.[i]),
        tMaxC: round(daily.temperature_2m_max?.[i], 1),
        tMinC: round(daily.temperature_2m_min?.[i], 1),
        windMaxKph: round(daily.wind_speed_10m_max?.[i], 1),
        soilMoisture: s?.length ? round(s.reduce((a, b) => a + b, 0) / s.length, 3) : null,
        // Archive rows are final only once they carry observed values.
        source: !isForecast && rainMm !== null ? 'archive' : 'forecast',
        fetchedAt,
      };
    });
    this.o.db.transaction((tx) => {
      for (const row of rows) {
        tx.insert(weatherDaily)
          .values(row)
          .onConflictDoUpdate({
            target: [weatherDaily.locationKey, weatherDaily.date],
            set: {
              rainMm: row.rainMm,
              // The archive has no probability; keep the forecast's.
              ...(row.rainProbPct !== null ? { rainProbPct: row.rainProbPct } : {}),
              et0Mm: row.et0Mm,
              tMaxC: row.tMaxC,
              tMinC: row.tMinC,
              windMaxKph: row.windMaxKph,
              soilMoisture: row.soilMoisture,
              source: row.source,
              fetchedAt: row.fetchedAt,
            },
          })
          .run();
      }
    });
  }
}

function toDay(r: WeatherDailyRow): WeatherDay {
  return {
    date: r.date,
    rainMm: r.rainMm,
    rainProbPct: r.rainProbPct,
    et0Mm: r.et0Mm,
    tMaxC: r.tMaxC,
    tMinC: r.tMinC,
    windMaxKph: r.windMaxKph,
    soilMoisture: r.soilMoisture,
    forecast: r.source === 'forecast',
  };
}
