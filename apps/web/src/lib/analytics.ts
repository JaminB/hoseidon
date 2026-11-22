import type { AnalyticsDay, SkipReasonKind, WeatherDay } from '@hoseidon/shared';

export const RANGES = [
  { value: '7d', label: '7d', days: 7 },
  { value: '30d', label: '30d', days: 30 },
  { value: '90d', label: '90d', days: 90 },
  { value: '1y', label: '1y', days: 365 },
] as const;
export type RangeKey = (typeof RANGES)[number]['value'];

/** Local "YYYY-MM-DD" of a Date in the browser's zone. */
export function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Parse "YYYY-MM-DD" as a local-midnight Date (not UTC, so labels don't slip a day). */
export function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

export function rangeDates(range: RangeKey, now = new Date()): { from: string; to: string } {
  const days = RANGES.find((r) => r.value === range)!.days;
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  return { from: localDate(from), to: localDate(now) };
}

export const mlToL = (ml: number) => ml / 1000;

/** "12.4 L" / "1,250 L" / "3.2 kL": volumes at a glance. */
export function formatLiters(ml: number): string {
  const l = mlToL(ml);
  if (l >= 10_000) return `${(l / 1000).toFixed(1)} kL`;
  if (l >= 100) return `${Math.round(l).toLocaleString()} L`;
  if (l >= 10) return `${l.toFixed(0)} L`;
  return `${l.toFixed(1)} L`;
}

export const formatMm = (mm: number | null) =>
  mm === null ? '—' : `${Math.round(mm * 10) / 10} mm`;

const fahrenheit = () =>
  typeof navigator !== 'undefined' && /^en-(US|LR|MM)\b/.test(navigator.language);

/** Temperature in the viewer's usual unit: Fahrenheit for en-US, Celsius elsewhere. */
export function formatTemp(c: number | null, f = fahrenheit()): string {
  if (c === null) return '—';
  return f ? `${Math.round((c * 9) / 5 + 32)}°` : `${Math.round(c)}°`;
}

export const SKIP_LABEL: Record<SkipReasonKind, string> = {
  rain: 'Rain forecast',
  freeze: 'Freeze risk',
  wind: 'High wind',
  manual: 'Skipped by you',
  missed: 'Missed (server down)',
  other: 'Other',
};

// ---- chart rows --------------------------------------------------------------------------------

export interface ChartRow {
  /** First local date of the bucket (a day, or the Monday of a week). */
  date: string;
  /** Number of days summed into the row. */
  span: number;
  liters: number;
  rainMm: number | null;
  et0Mm: number | null;
  runs: number;
  durationMin: number;
  avgRunMin: number | null;
  flowLMin: number | null;
}

/** Above this many days charts switch to weekly buckets so bars stay readable. */
export const WEEKLY_ABOVE_DAYS = 120;

/**
 * Join daily usage with daily weather by date, then optionally fold into weeks.
 * Weather is null for days it doesn't cover (no location, or the fetch failed).
 */
export function buildChartRows(
  days: AnalyticsDay[],
  weather: WeatherDay[],
  bucketDays = days.length > WEEKLY_ABOVE_DAYS ? 7 : 1,
): ChartRow[] {
  const w = new Map(weather.map((d) => [d.date, d]));
  const rows: ChartRow[] = [];
  for (let i = 0; i < days.length; i += bucketDays) {
    const chunk = days.slice(i, i + bucketDays);
    const sum = (f: (d: AnalyticsDay) => number) => chunk.reduce((a, d) => a + f(d), 0);
    const wx = chunk.map((d) => w.get(d.date));
    const wsum = (f: (d: WeatherDay) => number | null) => {
      const vals = wx.map((d) => (d ? f(d) : null)).filter((v): v is number => v !== null);
      return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) * 10) / 10 : null;
    };
    const runs = sum((d) => d.runs);
    const durationSec = sum((d) => d.durationSec);
    // Weighted by duration, so a long run counts for more than a short one.
    const flowDays = chunk.filter((d) => d.avgFlowMlMin !== null);
    const flowWeight = flowDays.reduce((a, d) => a + d.durationSec, 0);
    rows.push({
      date: chunk[0]!.date,
      span: chunk.length,
      liters: Math.round(mlToL(sum((d) => d.volumeMl)) * 10) / 10,
      rainMm: wsum((d) => d.rainMm),
      et0Mm: wsum((d) => d.et0Mm),
      runs,
      durationMin: Math.round((durationSec / 60) * 10) / 10,
      avgRunMin: runs ? Math.round((durationSec / runs / 60) * 10) / 10 : null,
      flowLMin: flowWeight
        ? Math.round(
            (flowDays.reduce((a, d) => a + (d.avgFlowMlMin as number) * d.durationSec, 0) /
              flowWeight /
              1000) *
              100,
          ) / 100
        : null,
    });
  }
  return rows;
}

// ---- heatmap -----------------------------------------------------------------------------------

export interface HeatCell {
  date: string;
  value: number;
  /** 0 (nothing) to 4 (the heaviest quarter). */
  level: 0 | 1 | 2 | 3 | 4;
}

/**
 * GitHub-style grid: columns are weeks (Sunday first), rows are weekdays. Cells before `from` or
 * after `to` in the first and last week are null so the grid stays rectangular.
 */
export function buildHeatmap(days: { date: string; value: number }[]): {
  weeks: (HeatCell | null)[][];
  max: number;
} {
  if (!days.length) return { weeks: [], max: 0 };
  const max = Math.max(...days.map((d) => d.value));
  const level = (v: number): HeatCell['level'] =>
    v <= 0 || max <= 0
      ? 0
      : (Math.min(4, Math.max(1, Math.ceil((v / max) * 4))) as HeatCell['level']);
  const lead = parseDate(days[0]!.date).getDay();
  const cells: (HeatCell | null)[] = [
    ...Array<null>(lead).fill(null),
    ...days.map((d) => ({ date: d.date, value: d.value, level: level(d.value) })),
  ];
  while (cells.length % 7) cells.push(null);
  const weeks: (HeatCell | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return { weeks, max };
}
