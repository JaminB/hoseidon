/** Local calendar dates as "YYYY-MM-DD" strings; arithmetic on them is done in UTC, so it is DST-free. */

const cache = new Map<string, Intl.DateTimeFormat>();

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The calendar date of `instant` in `timeZone`. */
export function dateInZone(instant: Date | number, timeZone: string): string {
  let f = cache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    cache.set(timeZone, f);
  }
  return f.format(instant);
}

const toUtc = (date: string) => Date.parse(`${date}T00:00:00Z`);

export function addDays(date: string, n: number): string {
  return new Date(toUtc(date) + n * 86_400_000).toISOString().slice(0, 10);
}

export function diffDays(a: string, b: string): number {
  return Math.round((toUtc(a) - toUtc(b)) / 86_400_000);
}

/** Every date from `from` to `to`, inclusive. Empty when `to` is before `from`. */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 800; d = addDays(d, 1)) out.push(d);
  return out;
}

export const isLocalDate = (s: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
