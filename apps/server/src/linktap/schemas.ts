import { z } from 'zod';

/**
 * Raw LinkTap cloud API response shapes. These are inferred from the public docs and community
 * integrations, not a published schema, so everything is loose: unknown keys pass through and
 * almost every field is optional. Normalization (normalize.ts) turns these into our own types.
 */

/** Numbers sometimes arrive as strings; accept both. */
const num = z.union([z.number(), z.string()]).nullish();
const flag = z.union([z.boolean(), z.number(), z.string()]).nullish();

/**
 * A live run. getWateringStatus (verified live, every value a STRING) sends
 * { onDuration, onDurSec, total, totalSec, onStamp, firstDt, vel, vol, dur, cm, ... }:
 * onDuration/total are whole minutes with onDurSec/totalSec as the seconds part, `dur` is the
 * planned length in seconds, `onStamp` the run start (epoch ms), `vel` the flow (ml/min).
 * After a run ends it sends just { dur } (idle, not watering). getAllDevices' `watering` is still
 * the inferred { remaining, total, vel, vol } (minutes).
 */
export const rawWateringSchema = z.looseObject({
  remaining: num,
  total: num,
  totalSec: num,
  onDuration: num,
  onDurSec: num,
  onStamp: num,
  dur: num,
  vel: num,
  vol: num,
  cm: z.string().nullish(),
});
export type RawWatering = z.infer<typeof rawWateringSchema>;

export const rawTaplinkerSchema = z.looseObject({
  taplinkerId: z.string(),
  taplinkerName: z.string().nullish(),
  location: z.string().nullish(),
  status: z.string().nullish(),
  batteryStatus: z.union([z.string(), z.number()]).nullish(),
  signal: z.union([z.string(), z.number()]).nullish(),
  workMode: z.string().nullish(),
  dType: num,
  flowMeterStatus: z.string().nullish(),
  /** Last/current flow rate, ml/min. Present even when `watering` is null. */
  vel: num,
  /** Last instant-mode plan: { action, duration, Y, X (month), Z (day), H, M, eco... }. */
  plan: z.looseObject({}).nullish(),
  watering: rawWateringSchema.nullish(),
  noWater: flag,
  valveBroken: flag,
  /** Real API name for the "device fell over" alarm; `fallFlag` is kept for older docs. */
  fall: flag,
  fallFlag: flag,
  leakFlag: flag,
  clogFlag: flag,
  pcFlag: flag,
  pbFlag: flag,
  freezeFlag: flag,
});
export type RawTaplinker = z.infer<typeof rawTaplinkerSchema>;

export const rawGatewaySchema = z.looseObject({
  gatewayId: z.string(),
  name: z.string().nullish(),
  location: z.string().nullish(),
  status: z.string().nullish(),
  version: z.string().nullish(),
  taplinker: z.array(rawTaplinkerSchema).nullish(),
});
export type RawGateway = z.infer<typeof rawGatewaySchema>;

export const okSchema = z.looseObject({ result: z.literal('ok') });
export const errorSchema = z.looseObject({
  result: z.literal('error'),
  message: z.string().nullish(),
});

export const getAllDevicesSchema = okSchema.extend({
  devices: z.array(rawGatewaySchema).nullish(),
});

export const getWateringStatusSchema = okSchema.extend({ status: rawWateringSchema.nullish() });

/** One history record: END date/time in gateway-local time, duration, volume. */
export const rawHistoryEntrySchema = z.looseObject({
  Y: z.union([z.string(), z.number()]),
  H: num,
  M: num,
  ss: num,
  D: num,
  S: num,
  vol: num,
  /** Work mode the run happened under (e.g. "M"). */
  cm: z.string().nullish(),
  /** ISO UTC time LinkTap stored the record (sometimes batched later than the event). */
  createdAt: z.string().nullish(),
  macaddr: z.string().nullish(),
});
export type RawHistoryEntry = z.infer<typeof rawHistoryEntrySchema>;

export const getWateringHistorySchema = okSchema.extend({
  // Verified against the live API: the records come back under `status` (the same key
  // getWateringStatus uses). `history`/`data` are kept in case other firmware differs.
  status: z.array(rawHistoryEntrySchema).nullish(),
  history: z.array(rawHistoryEntrySchema).nullish(),
  data: z.array(rawHistoryEntrySchema).nullish(),
});
