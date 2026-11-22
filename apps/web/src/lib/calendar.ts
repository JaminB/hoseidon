/** Date math and layout for the week calendar. All in the browser's local time zone. */

export const MIN_PER_DAY = 24 * 60;
export const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
const DAY_SHORT: Record<string, string> = {
  MO: 'Mon',
  TU: 'Tue',
  WE: 'Wed',
  TH: 'Thu',
  FR: 'Fri',
  SA: 'Sat',
  SU: 'Sun',
};

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, n: number): Date {
  // Calendar arithmetic, so DST days stay aligned to local midnight.
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());
}

export function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Minutes since local midnight. */
export function minuteOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

export function snap(minutes: number, step = 15): number {
  return Math.round(minutes / step) * step;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Normalizes a drag (either direction) to a snapped [start, end) of at least one step. */
export function dragRange(a: number, b: number, step = 15): { start: number; end: number } {
  const lo = clamp(Math.floor(Math.min(a, b) / step) * step, 0, MIN_PER_DAY - step);
  const hi = clamp(Math.ceil(Math.max(a, b) / step) * step, lo + step, MIN_PER_DAY);
  return { start: lo, end: hi };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "YYYY-MM-DDTHH:mm" wall time, the format schedules use for dtstart. */
export function toLocalDateTime(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Parses "YYYY-MM-DDTHH:mm" as a local wall time. */
export function fromLocalDateTime(s: string): Date {
  const [y, mo, d, h, mi] = s.split(/[-T:]/).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  return new Date(y, mo - 1, d, h, mi);
}

export function dayCode(d: Date): (typeof DAY_CODES)[number] {
  return DAY_CODES[d.getDay()]!;
}

export interface Interval {
  id: string;
  start: Date;
  end: Date;
}

export interface DayBlock<T extends Interval> {
  item: T;
  /** Minutes since midnight on this day, clipped to the day. */
  top: number;
  bottom: number;
  lane: number;
  lanes: number;
  /** The block continues from the previous day / onto the next. */
  clippedStart: boolean;
  clippedEnd: boolean;
}

/**
 * Lays out intervals for one day: clips them to the day, then packs overlapping ones side by side
 * (each cluster of transitively-overlapping blocks shares a lane count).
 */
export function layoutDay<T extends Interval>(items: T[], day: Date): DayBlock<T>[] {
  const dayStart = startOfDay(day).getTime();
  const dayEnd = addDays(startOfDay(day), 1).getTime();
  const visible = items
    .filter((i) => i.end.getTime() > dayStart && i.start.getTime() < dayEnd)
    .map((item) => {
      const s = Math.max(item.start.getTime(), dayStart);
      const e = Math.min(item.end.getTime(), dayEnd);
      return {
        item,
        top: (s - dayStart) / 60_000,
        // Keep zero-length blocks visible.
        bottom: Math.max((e - dayStart) / 60_000, (s - dayStart) / 60_000 + 1),
        lane: 0,
        lanes: 1,
        clippedStart: item.start.getTime() < dayStart,
        clippedEnd: item.end.getTime() > dayEnd,
      };
    })
    .sort((a, b) => a.top - b.top || b.bottom - a.bottom);

  let cluster: typeof visible = [];
  let clusterEnd = -1;
  const laneEnds: number[] = [];
  const flush = () => {
    const lanes = Math.max(1, laneEnds.length);
    for (const b of cluster) b.lanes = lanes;
    cluster = [];
    laneEnds.length = 0;
  };
  for (const block of visible) {
    if (block.top >= clusterEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= block.top);
    if (lane === -1) lane = laneEnds.push(block.bottom) - 1;
    else laneEnds[lane] = block.bottom;
    block.lane = lane;
    cluster.push(block);
    clusterEnd = Math.max(clusterEnd, block.bottom);
  }
  flush();
  return visible;
}

/** A short human reading of the RRULEs Hoseidon writes. Falls back to the raw rule. */
export function describeRrule(rrule: string): string {
  const parts = Object.fromEntries(
    rrule
      .replace(/^RRULE:/i, '')
      .split(';')
      .map((p) => p.split('=') as [string, string])
      .map(([k, v]) => [k.toUpperCase(), v ?? '']),
  );
  const interval = Number(parts.INTERVAL ?? 1);
  const days = parts.BYDAY ? parts.BYDAY.split(',').map((d) => DAY_SHORT[d] ?? d) : [];
  switch (parts.FREQ) {
    case 'DAILY':
      if (interval === 1) return 'Every day';
      if (interval === 2) return 'Every other day';
      return `Every ${interval} days`;
    case 'WEEKLY': {
      if (days.length === 7) return 'Every day';
      const on = days.length ? days.join(', ') : 'Weekly';
      if (interval === 1) return days.length ? on : 'Every week';
      return `${on} · every ${interval === 2 ? 'other' : `${interval}`} week${interval === 2 ? '' : 's'}`;
    }
    case 'MONTHLY':
      return interval === 1 ? 'Monthly' : `Every ${interval} months`;
    default:
      return rrule;
  }
}
