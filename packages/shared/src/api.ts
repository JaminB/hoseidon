import { z } from 'zod';

/**
 * Wire types for the Hoseidon REST API (server -> web). Timestamps are ISO strings.
 * Units are normalized: percentages are 0-100 numbers, durations are seconds, volumes are ml.
 */

/**
 * LinkTap work modes: M = Instant (manual), I = Interval, T = 7-day, O = Odd-even, Y = Month,
 * D = calendar/day plan (unverified), N = no mode. Anything other than M/N means a LinkTap-app
 * plan is active.
 */
export const workModeSchema = z.enum(['M', 'I', 'T', 'O', 'D', 'Y', 'N']);
export type WorkMode = z.infer<typeof workModeSchema>;

/** Alarm flags LinkTap can raise on a taplinker. */
export const alarmFlagSchema = z.enum([
  'noWater',
  'valveBroken',
  'fallFlag',
  'leakFlag',
  'clogFlag',
  'pcFlag',
  'pbFlag',
  'freezeFlag',
]);
export type AlarmFlag = z.infer<typeof alarmFlagSchema>;

/** The subset of alarms that `dismissAlarm` accepts. */
export const dismissableAlarmSchema = z.enum([
  'noWater',
  'valveBroken',
  'fallFlag',
  'pcFlag',
  'pbFlag',
]);
export type DismissableAlarm = z.infer<typeof dismissableAlarmSchema>;

export const wateringSchema = z.object({
  remainingSec: z.number().nullable(),
  totalSec: z.number().nullable(),
  /** Flow rate, ml/min (G2 models only). */
  flowMlPerMin: z.number().nullable(),
  /** Volume so far, ml (G2 models only). */
  volumeMl: z.number().nullable(),
});
export type Watering = z.infer<typeof wateringSchema>;

export const deviceSchema = z.object({
  id: z.string(),
  gatewayId: z.string(),
  /** Outlet number for multi-outlet ValveLinkers ("..._2" -> 2), else null. */
  outlet: z.number().int().nullable(),
  /** Display name: user override, falling back to the LinkTap name. */
  name: z.string(),
  linktapName: z.string(),
  zone: z.string().nullable(),
  online: z.boolean(),
  status: z.string().nullable(),
  batteryPct: z.number().nullable(),
  signalPct: z.number().nullable(),
  workMode: workModeSchema.nullable(),
  alarms: z.array(alarmFlagSchema),
  watering: wateringSchema.nullable(),
  lastSeenAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type Device = z.infer<typeof deviceSchema>;

export const gatewaySchema = z.object({
  id: z.string(),
  name: z.string(),
  linktapName: z.string(),
  online: z.boolean(),
  status: z.string().nullable(),
  lat: z.number().nullable(),
  lon: z.number().nullable(),
  timezone: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type Gateway = z.infer<typeof gatewaySchema>;

export const gatewayWithDevicesSchema = gatewaySchema.extend({ devices: z.array(deviceSchema) });
export type GatewayWithDevices = z.infer<typeof gatewayWithDevicesSchema>;

export const snapshotSchema = z.object({
  at: z.string(),
  online: z.boolean(),
  batteryPct: z.number().nullable(),
  signalPct: z.number().nullable(),
  workMode: workModeSchema.nullable(),
  watering: z.boolean(),
  alarms: z.array(alarmFlagSchema),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

export const runSourceSchema = z.enum(['hoseidon', 'linktap', 'manual']);
export type RunSource = z.infer<typeof runSourceSchema>;

export const runStatusSchema = z.enum(['running', 'completed', 'stopped', 'failed', 'skipped']);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const runSchema = z.object({
  id: z.number().int(),
  deviceId: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  plannedSec: z.number().nullable(),
  durationSec: z.number().nullable(),
  volumeMl: z.number().nullable(),
  source: runSourceSchema,
  scheduleId: z.number().int().nullable(),
  status: runStatusSchema,
  note: z.string().nullable(),
});
export type Run = z.infer<typeof runSchema>;

export const eventSeveritySchema = z.enum(['info', 'warn', 'alert']);
export type EventSeverity = z.infer<typeof eventSeveritySchema>;

export const eventSourceSchema = z.enum(['webhook', 'poller', 'hoseidon']);
export type EventSource = z.infer<typeof eventSourceSchema>;

export const eventSchema = z.object({
  id: z.number().int(),
  at: z.string(),
  type: z.string(),
  source: eventSourceSchema,
  severity: eventSeveritySchema,
  gatewayId: z.string().nullable(),
  deviceId: z.string().nullable(),
  title: z.string(),
  message: z.string().nullable(),
});
export type HoseidonEvent = z.infer<typeof eventSchema>;

export const deviceDetailSchema = z.object({
  device: deviceSchema,
  snapshots: z.array(snapshotSchema),
  runs: z.array(runSchema),
});
export type DeviceDetail = z.infer<typeof deviceDetailSchema>;

/** Request bodies. */
export const runRequestSchema = z.object({
  /** LinkTap instant mode takes 1..1439 minutes plus 0..59 seconds (S models). */
  seconds: z
    .number()
    .int()
    .min(60)
    .max(1439 * 60 + 59),
});
export const pauseRequestSchema = z.object({
  /** 0.1..240 hours, or -1 for indefinitely. */
  hours: z.union([z.literal(-1), z.number().min(0.1).max(240)]),
});
export const dismissAlarmRequestSchema = z.object({ alarm: dismissableAlarmSchema });
export const gatewayPatchSchema = z.object({
  name: z.string().trim().min(1).max(80).nullable().optional(),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lon: z.number().min(-180).max(180).nullable().optional(),
  timezone: z.string().min(1).max(64).nullable().optional(),
});
export const devicePatchSchema = z.object({
  name: z.string().trim().min(1).max(80).nullable().optional(),
  zone: z.string().trim().min(1).max(80).nullable().optional(),
});

/** Command responses carry the rate-limit picture so the UI can show "next command in 9s". */
export const commandResultSchema = z.object({
  ok: z.literal(true),
  nextCommandAt: z.string(),
  run: runSchema.nullable(),
});
export type CommandResult = z.infer<typeof commandResultSchema>;
