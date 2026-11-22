import { z } from 'zod';
import { isValidTimeZone } from './api';

/**
 * Schedules are owned by Hoseidon (LinkTap's cloud API can't store plans). Times are wall-clock in
 * the schedule's IANA time zone, so "6:00 every day" stays 6:00 across DST changes.
 */

/** Local wall-clock start, "YYYY-MM-DDTHH:mm". The first occurrence is on or after this. */
export const localDateTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'expected YYYY-MM-DDTHH:mm')
  .refine((s) => {
    const [y, mo, d, h, mi] = s.split(/[-T:]/).map(Number) as [
      number,
      number,
      number,
      number,
      number,
    ];
    const t = new Date(Date.UTC(y, mo - 1, d, h, mi));
    return t.getUTCMonth() === mo - 1 && t.getUTCDate() === d && h < 24 && mi < 60;
  }, 'invalid date');

export const timeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, 'unknown time zone');

/**
 * An RFC 5545 RRULE body without DTSTART, e.g. "FREQ=DAILY;INTERVAL=2" or
 * "FREQ=WEEKLY;BYDAY=MO,WE,FR". The "RRULE:" prefix is accepted and stripped. The server checks
 * that it actually parses.
 */
export const rruleSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .transform((s) => s.replace(/^RRULE:/i, ''))
  .refine((s) => /(^|;)FREQ=/i.test(s), 'RRULE needs FREQ')
  .refine((s) => !/DTSTART|TZID/i.test(s), 'put the start in dtstart, not the RRULE');

/** LinkTap instant runs are 1..1439 minutes. */
export const MAX_RUN_SEC = 1439 * 60;

export const scheduleItemSchema = z.object({
  deviceId: z.string().min(1),
  /** Total watering time for this zone per occurrence (split across cycles). */
  seconds: z.number().int().min(60).max(MAX_RUN_SEC),
});
export type ScheduleItem = z.infer<typeof scheduleItemSchema>;

/** Cycle-and-soak: split each zone's time into `cycles` runs with `soakMinutes` rest between. */
export const cycleSoakSchema = z.object({
  cycles: z.number().int().min(1).max(10),
  soakMinutes: z.number().int().min(0).max(240),
});
export type CycleSoak = z.infer<typeof cycleSoakSchema>;

export const skipRulesSchema = z
  .object({
    /** Skip when the next 24 h forecast has more rain than this (mm). */
    rainForecastMm: z.number().min(0).max(500).nullable().default(null),
    /** Skip when the forecast low is at or below this (°C). */
    freezeC: z.number().min(-50).max(20).nullable().default(null),
    /** Skip when forecast wind (max) is at or above this (km/h). */
    windKph: z.number().min(0).max(300).nullable().default(null),
    /** Scale durations by today's ET₀ against the provider's baseline. */
    etScaling: z.boolean().default(false),
    minScale: z.number().min(0.1).max(1).default(0.5),
    maxScale: z.number().min(1).max(3).default(1.5),
  })
  .refine((r) => r.minScale <= r.maxScale, 'minScale must be <= maxScale');
export type SkipRules = z.infer<typeof skipRulesSchema>;

export const DEFAULT_SKIP_RULES: SkipRules = {
  rainForecastMm: null,
  freezeC: null,
  windKph: null,
  etScaling: false,
  minScale: 0.5,
  maxScale: 1.5,
};

export const scheduleColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected #rrggbb');

const scheduleFields = {
  name: z.string().trim().min(1).max(80),
  color: scheduleColorSchema,
  rrule: rruleSchema,
  dtstart: localDateTimeSchema,
  /** Defaults to the first zone's gateway time zone. */
  timezone: timeZoneSchema,
  enabled: z.boolean(),
  items: z.array(scheduleItemSchema).min(1).max(32),
  cycleSoak: cycleSoakSchema.nullable(),
  /** Run zones on the same gateway one at a time (water pressure). */
  sequential: z.boolean(),
  skipRules: skipRulesSchema,
};

export const scheduleInputSchema = z.object({
  ...scheduleFields,
  color: scheduleFields.color.default('#22b8cf'),
  timezone: scheduleFields.timezone.optional(),
  enabled: scheduleFields.enabled.default(true),
  cycleSoak: scheduleFields.cycleSoak.default(null),
  sequential: scheduleFields.sequential.default(true),
  skipRules: scheduleFields.skipRules.default(DEFAULT_SKIP_RULES),
});
export type ScheduleInput = z.input<typeof scheduleInputSchema>;

/** Partial update. No defaults here, so omitted fields stay as they are. */
export const schedulePatchSchema = z
  .object(scheduleFields)
  .partial()
  .refine((o) => Object.keys(o).length > 0, 'nothing to update');
export type SchedulePatch = z.input<typeof schedulePatchSchema>;

export const scheduleWarningSchema = z.object({
  kind: z.enum(['linktap_plan', 'unknown_device', 'offline_device']),
  deviceId: z.string(),
  message: z.string(),
});
export type ScheduleWarning = z.infer<typeof scheduleWarningSchema>;

export const scheduleSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  color: z.string(),
  rrule: z.string(),
  dtstart: z.string(),
  timezone: z.string(),
  enabled: z.boolean(),
  items: z.array(scheduleItemSchema),
  cycleSoak: cycleSoakSchema.nullable(),
  sequential: z.boolean(),
  skipRules: skipRulesSchema,
  gcalEventId: z.string().nullable(),
  /** Next occurrence (ISO), or null if the rule has ended or the schedule is disabled. */
  nextAt: z.string().nullable(),
  warnings: z.array(scheduleWarningSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Schedule = z.infer<typeof scheduleSchema>;

export const plannedRunStatusSchema = z.enum([
  'planned',
  'skipped',
  'running',
  'done',
  'failed',
  'cancelled',
]);
export type PlannedRunStatus = z.infer<typeof plannedRunStatusSchema>;

export const plannedRunSchema = z.object({
  id: z.number().int(),
  scheduleId: z.number().int(),
  deviceId: z.string(),
  gatewayId: z.string(),
  /** The schedule occurrence this run belongs to. */
  occurrenceAt: z.string(),
  /** Zone position in the schedule and cycle number (1-based). */
  seq: z.number().int(),
  cycle: z.number().int(),
  /** Estimated start; the engine starts it once the zones ahead of it are done. */
  plannedAt: z.string(),
  seconds: z.number().int(),
  baseSeconds: z.number().int(),
  scale: z.number(),
  status: plannedRunStatusSchema,
  skipReason: z.string().nullable(),
  error: z.string().nullable(),
  runId: z.number().int().nullable(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
});
export type PlannedRun = z.infer<typeof plannedRunSchema>;

export const previewSlotSchema = z.object({
  deviceId: z.string(),
  gatewayId: z.string().nullable(),
  seq: z.number().int(),
  cycle: z.number().int(),
  start: z.string(),
  end: z.string(),
  seconds: z.number().int(),
});

export const previewOccurrenceSchema = z.object({
  scheduleId: z.number().int(),
  name: z.string(),
  color: z.string(),
  start: z.string(),
  end: z.string(),
  slots: z.array(previewSlotSchema),
  /** Other schedules whose occurrences overlap this one on a shared gateway. */
  overlapsWith: z.array(z.number().int()),
});
export type PreviewOccurrence = z.infer<typeof previewOccurrenceSchema>;

export const skipPlannedRunSchema = z.object({
  reason: z.string().trim().min(1).max(200).optional(),
  /** Skip every not-yet-started run of the same occurrence. Default true. */
  wholeOccurrence: z.boolean().default(true),
});
