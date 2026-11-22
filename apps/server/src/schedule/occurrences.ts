import * as rrule from 'rrule';

// rrule ships a UMD "main" and an ESM "module". Bundlers (tsup, vitest) pick the ESM build with
// named exports; plain Node (tsx in dev) loads the UMD build, which only has a default export.
const { RRule } = (rrule as typeof rrule & { default?: typeof rrule }).default ?? rrule;
type RRule = rrule.RRule;
import { fromWall, parseLocal, toWall } from './time';

export interface Recurrence {
  rrule: string;
  /** Local "YYYY-MM-DDTHH:mm". */
  dtstart: string;
  timezone: string;
}

export class InvalidRecurrenceError extends Error {}

/**
 * Build the rule in "floating" time: rrule.js expands wall-clock fields as if they were UTC, and we
 * convert each result to a real instant in the schedule's zone afterwards. That keeps 06:00 at
 * 06:00 across DST without relying on rrule.js's TZID handling.
 */
function floatingRule(r: Recurrence): RRule {
  let options;
  try {
    options = RRule.parseString(r.rrule.replace(/^RRULE:/i, ''));
  } catch (err) {
    throw new InvalidRecurrenceError(`invalid RRULE: ${(err as Error).message}`);
  }
  if (options.freq === undefined) throw new InvalidRecurrenceError('RRULE needs FREQ');
  if (options.freq > RRule.DAILY) {
    // Hourly/minutely/secondly watering is almost certainly a typo, and floods the planner.
    throw new InvalidRecurrenceError('RRULE FREQ must be DAILY or slower');
  }
  // UNTIL is a wall time too ("until the 30th"), so read it as floating.
  return new RRule({ ...options, dtstart: parseLocal(r.dtstart), tzid: null });
}

/** Throws InvalidRecurrenceError when the rule can't be used. */
export function validateRecurrence(r: Recurrence): void {
  floatingRule(r);
}

const DAY = 86_400_000;

/** Occurrence instants in [from, to), in order. */
export function expandOccurrences(r: Recurrence, from: Date, to: Date, limit = 1000): Date[] {
  if (to <= from) return [];
  const rule = floatingRule(r);
  // Pad the floating window by a day: offsets are at most ±14 h.
  const wallFrom = new Date(toWall(from, r.timezone).getTime() - DAY);
  const wallTo = new Date(toWall(to, r.timezone).getTime() + DAY);
  const out: Date[] = [];
  const seen = new Set<number>();
  rule.between(wallFrom, wallTo, true, (wall) => {
    const at = fromWall(wall, r.timezone);
    // Two wall times can map to one instant (02:00 and 03:00 on a spring-forward day).
    if (at >= from && at < to && !seen.has(at.getTime())) {
      seen.add(at.getTime());
      out.push(at);
    }
    return out.length < limit;
  });
  return out.sort((a, b) => a.getTime() - b.getTime());
}

/** The first occurrence at or after `after`, or null if the rule has ended. */
export function nextOccurrence(r: Recurrence, after: Date): Date | null {
  const rule = floatingRule(r);
  let wall: Date | null = new Date(toWall(after, r.timezone).getTime() - DAY);
  // Walk forward until a converted occurrence lands at or after `after`.
  for (let i = 0; i < 5 && wall; i++) {
    wall = rule.after(wall, i === 0);
    if (!wall) return null;
    const at = fromWall(wall, r.timezone);
    if (at >= after) return at;
  }
  // Rare: many occurrences inside the padding window. Fall back to a bounded expansion.
  return expandOccurrences(r, after, new Date(after.getTime() + 400 * DAY), 1)[0] ?? null;
}
