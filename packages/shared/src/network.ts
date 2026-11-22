import { z } from 'zod';

/** Wire types for network monitoring and troubleshooting. Timestamps are ISO strings. */

export const DEFAULT_WEAK_SIGNAL_PCT = 40;

export const timelineStateSchema = z.enum(['online', 'offline', 'unknown']);
export type TimelineState = z.infer<typeof timelineStateSchema>;

export const timelineSegmentSchema = z.object({
  start: z.string(),
  end: z.string(),
  /** "unknown" = Hoseidon wasn't polling (it was down), so nobody knows. */
  state: timelineStateSchema,
});
export type TimelineSegment = z.infer<typeof timelineSegmentSchema>;

export const incidentSourceSchema = z.enum(['webhook', 'poll']);
export type IncidentSource = z.infer<typeof incidentSourceSchema>;

export const incidentSchema = z.object({
  /** Stable id: scope, subject and start. */
  id: z.string(),
  scope: z.enum(['gateway', 'device']),
  gatewayId: z.string(),
  deviceId: z.string().nullable(),
  /** Display name of the gateway or timer. */
  name: z.string(),
  start: z.string(),
  /** Null while it is still offline. */
  end: z.string().nullable(),
  durationSec: z.number(),
  ongoing: z.boolean(),
  /** What told us it went offline: a LinkTap webhook (instant) or our next poll (up to 5 min late). */
  source: incidentSourceSchema,
  /** The timer was offline because its gateway was. */
  viaGateway: z.boolean(),
});
export type Incident = z.infer<typeof incidentSchema>;

/** [epoch ms, value] */
export const seriesSchema = z.array(z.tuple([z.number(), z.number()]));
export type Series = z.infer<typeof seriesSchema>;

export const signalStatsSchema = z.object({
  latest: z.number().nullable(),
  avg: z.number().nullable(),
  min: z.number().nullable(),
  /** Share of online samples below the weak-signal threshold, 0-100. */
  weakPct: z.number().nullable(),
  /** Separate stretches spent below the threshold. */
  weakEpisodes: z.number().int(),
  /** Sudden falls of 25+ points between two polls. */
  drops: z.number().int(),
  series: seriesSchema,
});
export type SignalStats = z.infer<typeof signalStatsSchema>;

export const batteryTrendSchema = z.enum(['draining', 'stable', 'charging', 'unknown']);
export type BatteryTrend = z.infer<typeof batteryTrendSchema>;

export const batteryStatsSchema = z.object({
  latest: z.number().nullable(),
  /** Percentage points lost per day (positive = draining). Null without enough data. */
  drainPctPerDay: z.number().nullable(),
  /** Days until empty at the current drain rate. */
  daysLeft: z.number().nullable(),
  trend: batteryTrendSchema,
  series: seriesSchema,
});
export type BatteryStats = z.infer<typeof batteryStatsSchema>;

export const deviceNetworkSchema = z.object({
  id: z.string(),
  gatewayId: z.string(),
  name: z.string(),
  online: z.boolean(),
  lastSeenAt: z.string().nullable(),
  /** Online share of the window, 0-100, or null if it's all unknown. */
  uptimePct: z.number().nullable(),
  segments: z.array(timelineSegmentSchema),
  signal: signalStatsSchema,
  battery: batteryStatsSchema,
  alarms: z.array(z.string()),
});
export type DeviceNetwork = z.infer<typeof deviceNetworkSchema>;

export const gatewayNetworkSchema = z.object({
  id: z.string(),
  name: z.string(),
  online: z.boolean(),
  lastSeenAt: z.string().nullable(),
  /** Gateway firmware version string. */
  version: z.string().nullable().default(null),
  uptimePct: z.number().nullable(),
  segments: z.array(timelineSegmentSchema),
  devices: z.array(deviceNetworkSchema),
});
export type GatewayNetwork = z.infer<typeof gatewayNetworkSchema>;

export const endpointHealthSchema = z.object({
  endpoint: z.string(),
  calls: z.number().int(),
  errors: z.number().int(),
  /** Over the last 50 calls, 0-100. */
  errorRatePct: z.number().nullable(),
  lastOkAt: z.string().nullable(),
  lastErrorAt: z.string().nullable(),
  lastError: z.string().nullable(),
  /** Time calls spent queued behind LinkTap's rate limits. */
  avgWaitMs: z.number(),
  maxWaitMs: z.number(),
});
export type EndpointHealth = z.infer<typeof endpointHealthSchema>;

export const apiHealthSchema = z.object({
  mock: z.boolean(),
  /** Counters reset when the server restarts. */
  since: z.string(),
  endpoints: z.array(endpointHealthSchema),
  nextAvailableAt: z.object({ devices: z.string(), history: z.string(), command: z.string() }),
  poller: z
    .object({
      running: z.boolean(),
      last: z.record(
        z.string(),
        z.object({ at: z.string().nullable(), error: z.string().nullable() }),
      ),
    })
    .nullable(),
});
export type ApiHealth = z.infer<typeof apiHealthSchema>;

export const freshnessSchema = z.object({
  /** Newest device snapshot. */
  lastPollAt: z.string().nullable(),
  ageSec: z.number().nullable(),
  /** No data for more than three poll intervals. */
  stale: z.boolean(),
});
export type Freshness = z.infer<typeof freshnessSchema>;

export const networkOverviewSchema = z.object({
  generatedAt: z.string(),
  windowDays: z.number().int(),
  from: z.string(),
  to: z.string(),
  weakSignalPct: z.number(),
  freshness: freshnessSchema,
  gateways: z.array(gatewayNetworkSchema),
  incidents: z.array(incidentSchema),
  apiHealth: apiHealthSchema,
});
export type NetworkOverview = z.infer<typeof networkOverviewSchema>;

export const networkGatewayDetailSchema = z.object({
  generatedAt: z.string(),
  windowDays: z.number().int(),
  weakSignalPct: z.number(),
  gateway: gatewayNetworkSchema,
  incidents: z.array(incidentSchema),
});
export type NetworkGatewayDetail = z.infer<typeof networkGatewayDetailSchema>;

export const networkDeviceDetailSchema = z.object({
  generatedAt: z.string(),
  windowDays: z.number().int(),
  weakSignalPct: z.number(),
  device: deviceNetworkSchema,
  incidents: z.array(incidentSchema),
});
export type NetworkDeviceDetail = z.infer<typeof networkDeviceDetailSchema>;

export const networkSettingsSchema = z.object({
  weakSignalPct: z.number().int().min(5).max(95),
});
export type NetworkSettings = z.infer<typeof networkSettingsSchema>;

export const checkStatusSchema = z.enum(['pass', 'warn', 'fail', 'unknown']);
export type CheckStatus = z.infer<typeof checkStatusSchema>;

export const diagnosisCheckSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: checkStatusSchema,
  /** What we saw, in plain English. */
  detail: z.string(),
  /** What to try. Null when the check passed. */
  fix: z.string().nullable(),
});
export type DiagnosisCheck = z.infer<typeof diagnosisCheckSchema>;

export const diagnosisSchema = z.object({
  deviceId: z.string(),
  deviceName: z.string(),
  generatedAt: z.string(),
  /** Worst status among the checks. */
  verdict: z.enum(['ok', 'warn', 'fail']),
  summary: z.string(),
  checks: z.array(diagnosisCheckSchema),
});
export type Diagnosis = z.infer<typeof diagnosisSchema>;
