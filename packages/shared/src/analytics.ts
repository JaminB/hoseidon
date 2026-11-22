import { z } from 'zod';

/** "YYYY-MM-DD" in the location's (or schedule's) own time zone. */
export const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const weatherDaySchema = z.object({
  date: localDateSchema,
  rainMm: z.number().nullable(),
  /** Chance of rain, 0-100. Forecast days only. */
  rainProbPct: z.number().nullable(),
  /** Reference evapotranspiration, mm. */
  et0Mm: z.number().nullable(),
  tMaxC: z.number().nullable(),
  tMinC: z.number().nullable(),
  windMaxKph: z.number().nullable(),
  /** Mean volumetric soil moisture in the top 7 cm, m³/m³. */
  soilMoisture: z.number().nullable(),
  /** True until the observed (archive) value replaces the forecast. */
  forecast: z.boolean(),
});
export type WeatherDay = z.infer<typeof weatherDaySchema>;

export const WEATHER_ATTRIBUTION = 'Weather data by Open-Meteo.com (CC BY 4.0)';

export const weatherResponseSchema = z.object({
  gatewayId: z.string(),
  /** False when the gateway has no location yet. */
  available: z.boolean(),
  timezone: z.string().nullable(),
  today: localDateSchema,
  days: z.array(weatherDaySchema),
  attribution: z.string(),
});
export type WeatherResponse = z.infer<typeof weatherResponseSchema>;

export const SKIP_REASONS = ['rain', 'freeze', 'wind', 'manual', 'missed', 'other'] as const;
export const skipReasonKindSchema = z.enum(SKIP_REASONS);
export type SkipReasonKind = z.infer<typeof skipReasonKindSchema>;

export const analyticsDaySchema = z.object({
  date: localDateSchema,
  volumeMl: z.number(),
  durationSec: z.number(),
  runs: z.number(),
  /** Mean flow over the day's runs that reported volume, ml/min. Null when none did. */
  avgFlowMlMin: z.number().nullable(),
  skipped: z.number(),
});
export type AnalyticsDay = z.infer<typeof analyticsDaySchema>;

export const analyticsSchema = z.object({
  from: localDateSchema,
  to: localDateSchema,
  timezone: z.string(),
  /** One entry per local day in the range, including empty days. */
  days: z.array(analyticsDaySchema),
  totals: z.object({
    volumeMl: z.number(),
    durationSec: z.number(),
    runs: z.number(),
    skipped: z.number(),
    avgFlowMlMin: z.number().nullable(),
  }),
  /** False when no run in the range reported a volume (older models), so flow charts hide. */
  hasFlow: z.boolean(),
  skipReasons: z.array(z.object({ kind: skipReasonKindSchema, count: z.number() })),
  saved: z.object({
    /** Cycles skipped for rain, freeze or wind. */
    skippedRuns: z.number(),
    /** Watering time not run because of weather skips plus ET₀ scaling. */
    seconds: z.number(),
    /** The same in volume at the device's average flow; null when flow is unknown. */
    volumeMl: z.number().nullable(),
  }),
});
export type Analytics = z.infer<typeof analyticsSchema>;

export const analyticsSummarySchema = analyticsSchema.extend({
  devices: z.array(
    z.object({
      deviceId: z.string(),
      name: z.string(),
      volumeMl: z.number(),
      durationSec: z.number(),
      runs: z.number(),
    }),
  ),
});
export type AnalyticsSummary = z.infer<typeof analyticsSummarySchema>;

/** Classify a planned run's skip text into a bucket for the breakdown. */
export function classifySkipReason(reason: string | null): SkipReasonKind {
  if (!reason) return 'other';
  const r = reason.toLowerCase();
  if (r.includes('rain')) return 'rain';
  if (r.includes('freeze')) return 'freeze';
  if (r.includes('wind')) return 'wind';
  if (r.startsWith('missed')) return 'missed';
  if (r.startsWith('skipped by you')) return 'manual';
  return 'other';
}
