import type { BatteryStats, Incident, Series, TimelineSegment } from '@hoseidon/shared';

/** Pure helpers for the Network page: geometry, labels and tones. */

export type Tone = 'ok' | 'warn' | 'danger' | 'muted';

export const NETWORK_WINDOWS = [
  { value: '1', label: '24h' },
  { value: '7', label: '7d' },
  { value: '30', label: '30d' },
] as const;

/** Signal colour: weak (below the threshold) is a warning, under half of it is a problem. */
export function signalTone(pct: number | null, weakBelow: number): Tone {
  if (pct === null) return 'muted';
  if (pct < weakBelow / 2) return 'danger';
  if (pct < weakBelow) return 'warn';
  return 'ok';
}

/** Topology line weight: a strong link is a thick line, a weak one is a thread. */
export function linkWidth(pct: number | null): number {
  if (pct === null) return 1.5;
  return 1.5 + (Math.max(0, Math.min(100, pct)) / 100) * 4.5;
}

export interface Bar {
  /** Percent of the bar's width. */
  left: number;
  width: number;
  state: TimelineSegment['state'];
  start: string;
  end: string;
}

/** Lays timeline segments out as percentages of the window, clamped and gap-free. */
export function segmentBars(segments: TimelineSegment[], from: number, to: number): Bar[] {
  const span = to - from;
  if (span <= 0) return [];
  const bars: Bar[] = [];
  for (const s of segments) {
    const a = Math.max(from, new Date(s.start).getTime());
    const b = Math.min(to, new Date(s.end).getTime());
    if (b <= a) continue;
    bars.push({
      left: ((a - from) / span) * 100,
      width: ((b - a) / span) * 100,
      state: s.state,
      start: s.start,
      end: s.end,
    });
  }
  return bars;
}

/** "99.8%", "100%", or an em dash when we have nothing to go on. */
export function formatUptime(pct: number | null): string {
  if (pct === null) return '—';
  if (pct >= 99.95) return '100%';
  return `${pct.toFixed(pct >= 99 ? 1 : 0)}%`;
}

export function uptimeTone(pct: number | null): Tone {
  if (pct === null) return 'muted';
  if (pct >= 99) return 'ok';
  if (pct >= 90) return 'warn';
  return 'danger';
}

export interface Spark {
  line: string;
  area: string;
  /** Where the threshold line sits, in viewBox y, or null when it is out of range. */
  thresholdY: number | null;
  last: { x: number; y: number } | null;
}

/**
 * SVG paths for a sparkline in a `width` x `height` box. The y axis is fixed to `domain` (0-100
 * for percentages) so two sparklines are comparable at a glance.
 */
export function sparkline(
  series: Series,
  width: number,
  height: number,
  {
    domain = [0, 100],
    threshold,
    pad = 2,
  }: { domain?: [number, number]; threshold?: number; pad?: number } = {},
): Spark {
  const [lo, hi] = domain;
  const y = (v: number) => {
    const t = (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo || 1);
    return pad + (1 - t) * (height - 2 * pad);
  };
  const thresholdY =
    threshold === undefined || threshold < lo || threshold > hi ? null : y(threshold);
  if (series.length === 0) return { line: '', area: '', thresholdY, last: null };

  const t0 = series[0]![0];
  const span = series.at(-1)![0] - t0;
  const x = (t: number) => (span === 0 ? width / 2 : pad + ((t - t0) / span) * (width - 2 * pad));
  const pts = series.map(([t, v]) => ({ x: x(t), y: y(v) }));
  const fmt = (n: number) => Math.round(n * 10) / 10;
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${fmt(p.x)} ${fmt(p.y)}`).join(' ');
  const first = pts[0]!;
  const last = pts.at(-1)!;
  const area = `${line} L${fmt(last.x)} ${height} L${fmt(first.x)} ${height} Z`;
  return { line, area, thresholdY, last };
}

/** "−2.1%/day · about 34 days left", "stable", "recharged". */
export function batteryLabel(b: BatteryStats): string {
  switch (b.trend) {
    case 'draining':
      return `−${b.drainPctPerDay}%/day · about ${b.daysLeft} day${b.daysLeft === 1 ? '' : 's'} left`;
    case 'stable':
      return 'Holding steady';
    case 'charging':
      return 'Recently recharged';
    default:
      return 'Not enough data yet';
  }
}

export function batteryTone(b: BatteryStats): Tone {
  if (b.latest === null) return 'muted';
  if (b.latest < 10 || (b.daysLeft !== null && b.daysLeft < 7)) return 'danger';
  if (b.latest < 20 || (b.daysLeft !== null && b.daysLeft < 21)) return 'warn';
  return 'ok';
}

/** "45 min", "3 h", "5 days": coarse on purpose, for outage lengths. */
export function formatOutage(sec: number): string {
  if (sec >= 2 * 86_400) return `${Math.round(sec / 86_400)} days`;
  if (sec >= 3600) return `${Math.round(sec / 3600)} h`;
  return `${Math.max(1, Math.round(sec / 60))} min`;
}

/** One-line description of an incident for the log. */
export function incidentSummary(i: Incident): string {
  const how =
    i.source === 'webhook'
      ? 'reported by LinkTap'
      : 'spotted on a poll (can be a few minutes late)';
  const why = i.viaGateway ? ' · gateway was down' : '';
  return `${how}${why}`;
}

export const TONE_VAR: Record<Tone, string> = {
  ok: 'var(--app-ok)',
  warn: 'var(--app-warn)',
  danger: 'var(--app-danger)',
  muted: 'var(--app-subtle)',
};
