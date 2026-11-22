import { z } from 'zod';

/** LinkTap work modes: Manual, Instant, sevenday/Timer, Odd-even, Day interval, Year/month, None. */
export const workModeSchema = z.enum(['M', 'I', 'T', 'O', 'D', 'Y', 'N']);
export type WorkMode = z.infer<typeof workModeSchema>;

export const healthSchema = z.object({
  ok: z.literal(true),
  name: z.literal('hoseidon'),
  version: z.string(),
  mock: z.boolean(),
});
export type Health = z.infer<typeof healthSchema>;

/** LinkTap reports percentages as strings like "66%". Returns null if unparseable. */
export function parsePercent(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const n = Number.parseFloat(value.replace('%', ''));
  return Number.isFinite(n) ? n : null;
}
