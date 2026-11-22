/**
 * Wall-clock <-> instant conversion for IANA time zones, with an explicit DST policy:
 * - a wall time skipped by spring-forward (02:30 on the change day) moves forward by the gap (03:30)
 * - a wall time that happens twice at fall-back (01:30) uses the first one
 *
 * "Wall" times are represented as a Date whose UTC fields hold the local fields ("floating").
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Instant -> floating wall time in `timeZone`. */
export function toWall(instant: Date, timeZone: string): Date {
  const parts = formatter(timeZone).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return new Date(
    Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour'),
      get('minute'),
      get('second'),
      instant.getUTCMilliseconds(),
    ),
  );
}

/** Offset of `timeZone` from UTC (ms) at `instantMs`. */
function offsetAt(instantMs: number, timeZone: string): number {
  return toWall(new Date(instantMs), timeZone).getTime() - instantMs;
}

/** Floating wall time in `timeZone` -> instant, using the DST policy above. */
export function fromWall(wall: Date, timeZone: string): Date {
  const w = wall.getTime();
  // Offsets either side of any transition near this wall time.
  const before = offsetAt(w - 86_400_000, timeZone);
  const after = offsetAt(w + 86_400_000, timeZone);
  const valid = [w - before, w - after].filter((t) => t + offsetAt(t, timeZone) === w);
  if (valid.length) return new Date(Math.min(...valid));
  // In a spring-forward gap: interpret with the pre-transition offset, which lands past the gap.
  return new Date(w - before);
}

/** "YYYY-MM-DDTHH:mm" -> floating wall Date. */
export function parseLocal(local: string): Date {
  const [y, mo, d, h, mi] = local.split(/[-T:]/).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  return new Date(Date.UTC(y, mo - 1, d, h, mi));
}

/** Floating wall Date -> "YYYY-MM-DDTHH:mm". */
export function formatLocal(wall: Date): string {
  return wall.toISOString().slice(0, 16);
}

/** Today's local date at a given wall time, e.g. for defaults. */
export function localNow(timeZone: string, now = new Date()): string {
  return formatLocal(toWall(now, timeZone));
}
