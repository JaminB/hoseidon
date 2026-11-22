/**
 * The repeat picker in the schedule sheet, and its round trip to the RRULEs the server stores.
 * Anything the picker can't express is kept as a raw "custom" rule.
 */

export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export type Repeat =
  | { kind: 'daily'; interval: number }
  | { kind: 'weekly'; days: Weekday[]; interval: number }
  | { kind: 'custom'; rrule: string };

export function parseRepeat(rrule: string): Repeat {
  const body = rrule.replace(/^RRULE:/i, '').trim();
  const parts = new Map(
    body
      .split(';')
      .filter(Boolean)
      .map((p) => {
        const [k = '', v = ''] = p.split('=');
        return [k.toUpperCase(), v.toUpperCase()] as const;
      }),
  );
  const interval = Number(parts.get('INTERVAL') ?? '1');
  const known = new Set(['FREQ', 'INTERVAL', 'BYDAY']);
  const extra = [...parts.keys()].some((k) => !known.has(k));
  if (extra || !Number.isInteger(interval) || interval < 1) return { kind: 'custom', rrule: body };

  if (parts.get('FREQ') === 'DAILY' && !parts.has('BYDAY')) return { kind: 'daily', interval };
  if (parts.get('FREQ') === 'WEEKLY') {
    const days = (parts.get('BYDAY') ?? '').split(',').filter(Boolean);
    if (
      days.length &&
      days.every((d): d is Weekday => (WEEKDAYS as readonly string[]).includes(d))
    ) {
      return { kind: 'weekly', days: WEEKDAYS.filter((d) => days.includes(d)), interval };
    }
  }
  return { kind: 'custom', rrule: body };
}

export function toRrule(r: Repeat): string {
  switch (r.kind) {
    case 'daily':
      return r.interval === 1 ? 'FREQ=DAILY' : `FREQ=DAILY;INTERVAL=${r.interval}`;
    case 'weekly': {
      const days = WEEKDAYS.filter((d) => r.days.includes(d)).join(',');
      return `FREQ=WEEKLY${r.interval > 1 ? `;INTERVAL=${r.interval}` : ''};BYDAY=${days}`;
    }
    case 'custom':
      return r.rrule;
  }
}
