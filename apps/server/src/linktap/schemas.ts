import { z } from 'zod';

/**
 * Raw LinkTap cloud API response shapes. These are inferred from the public docs and community
 * integrations, not a published schema, so everything is loose: unknown keys pass through and
 * almost every field is optional. Normalization (normalize.ts) turns these into our own types.
 */

/** Numbers sometimes arrive as strings; accept both. */
const num = z.union([z.number(), z.string()]).nullish();
const flag = z.union([z.boolean(), z.number(), z.string()]).nullish();

export const rawWateringSchema = z.looseObject({
  remaining: num,
  total: num,
  onDuration: num,
  vel: num,
  vol: num,
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
  watering: rawWateringSchema.nullish(),
  noWater: flag,
  valveBroken: flag,
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

/** One history record: start date/time in gateway-local time, duration, volume (G2 only). */
export const rawHistoryEntrySchema = z.looseObject({
  Y: z.union([z.string(), z.number()]),
  H: num,
  M: num,
  ss: num,
  D: num,
  S: num,
  vol: num,
});
export type RawHistoryEntry = z.infer<typeof rawHistoryEntrySchema>;

export const getWateringHistorySchema = okSchema.extend({
  history: z.array(rawHistoryEntrySchema).nullish(),
  // Some integrations report the array under `data`; accept either.
  data: z.array(rawHistoryEntrySchema).nullish(),
});
