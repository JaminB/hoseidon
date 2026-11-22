import type { SkipRules } from '@hoseidon/shared';

/** What the skip rules need to know about the next day at a location. */
export interface WeatherOutlook {
  /** Forecast rain over the next 24 h, mm. */
  rainMm: number | null;
  /** Forecast minimum temperature over the next 24 h, °C. */
  minTempC: number | null;
  /** Forecast maximum wind over the next 24 h, km/h. */
  maxWindKph: number | null;
  /** Reference evapotranspiration for today, mm. */
  et0Mm: number | null;
  /** "Normal" ET₀ the schedule's durations were tuned for (e.g. a recent average), mm. */
  et0BaselineMm: number | null;
}

export interface WeatherLocation {
  lat: number;
  lon: number;
  timezone: string;
}

/** Phase 4 plugs Open-Meteo in here. Returning null means "no data": nothing is skipped. */
export interface WeatherProvider {
  outlook(location: WeatherLocation, at: Date): Promise<WeatherOutlook | null>;
}

export class NullWeatherProvider implements WeatherProvider {
  async outlook(): Promise<null> {
    return null;
  }
}

export interface SkipDecision {
  skip: string | null;
  scale: number;
  /** Why the scale is what it is, for the run's note. */
  note: string | null;
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** Apply a schedule's skip rules to an outlook. Missing data never causes a skip. */
export function evaluateSkipRules(rules: SkipRules, outlook: WeatherOutlook | null): SkipDecision {
  if (!outlook) return { skip: null, scale: 1, note: null };
  const { rainMm, minTempC, maxWindKph, et0Mm, et0BaselineMm } = outlook;
  if (rules.rainForecastMm !== null && rainMm !== null && rainMm > rules.rainForecastMm) {
    return { skip: `${fmt(rainMm)} mm rain forecast`, scale: 1, note: null };
  }
  if (rules.freezeC !== null && minTempC !== null && minTempC <= rules.freezeC) {
    return { skip: `Freeze risk (low of ${fmt(minTempC)} °C)`, scale: 1, note: null };
  }
  if (rules.windKph !== null && maxWindKph !== null && maxWindKph >= rules.windKph) {
    return { skip: `High wind (${fmt(maxWindKph)} km/h)`, scale: 1, note: null };
  }
  if (rules.etScaling && et0Mm !== null && et0BaselineMm !== null && et0BaselineMm > 0) {
    const raw = et0Mm / et0BaselineMm;
    const scale = Math.min(rules.maxScale, Math.max(rules.minScale, raw));
    const rounded = Math.round(scale * 100) / 100;
    return {
      skip: null,
      scale: rounded,
      note: `ET₀ ${fmt(et0Mm)} mm vs ${fmt(et0BaselineMm)} mm normal → ${Math.round(rounded * 100)}%`,
    };
  }
  return { skip: null, scale: 1, note: null };
}
