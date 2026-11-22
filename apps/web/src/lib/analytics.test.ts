import { describe, expect, it } from 'vitest';
import type { AnalyticsDay, WeatherDay } from '@hoseidon/shared';
import { buildChartRows, buildHeatmap, localDate, rangeDates, toDisplayUnits } from './analytics';

const day = (date: string, over: Partial<AnalyticsDay> = {}): AnalyticsDay => ({
  date,
  volumeMl: 0,
  durationSec: 0,
  runs: 0,
  avgFlowMlMin: null,
  skipped: 0,
  ...over,
});
const wx = (date: string, over: Partial<WeatherDay> = {}): WeatherDay => ({
  date,
  rainMm: 0,
  rainProbPct: null,
  et0Mm: 4,
  tMaxC: 20,
  tMinC: 10,
  windMaxKph: 10,
  soilMoisture: null,
  forecast: false,
  ...over,
});

describe('rangeDates', () => {
  it('is inclusive of today', () => {
    const now = new Date(2026, 5, 10, 15);
    expect(rangeDates('7d', now)).toEqual({ from: '2026-06-04', to: '2026-06-10' });
    expect(rangeDates('1y', now).from).toBe('2025-06-11');
  });
  it('formats local dates without a UTC shift', () => {
    expect(localDate(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
});

describe('toDisplayUnits', () => {
  const metric = buildChartRows(
    [day('2026-06-01', { volumeMl: 3785.411784, avgFlowMlMin: 3785.411784, durationSec: 60 })],
    [wx('2026-06-01', { rainMm: 25.4, et0Mm: 2.54 })],
  );
  it('leaves metric rows alone', () => {
    expect(toDisplayUnits(metric, 'metric')).toBe(metric);
  });
  it('converts volume, depth and flow to imperial', () => {
    expect(toDisplayUnits(metric, 'imperial')[0]).toMatchObject({
      liters: 1,
      rainMm: 1,
      et0Mm: 0.1,
      flowLMin: 1,
    });
  });
});

describe('buildChartRows', () => {
  it('joins weather by date and converts units', () => {
    const rows = buildChartRows(
      [day('2026-06-01', { volumeMl: 12_000, durationSec: 600, runs: 1 }), day('2026-06-02')],
      [wx('2026-06-01', { rainMm: 3.2, et0Mm: 5 })],
    );
    expect(rows[0]).toMatchObject({
      liters: 12,
      rainMm: 3.2,
      et0Mm: 5,
      durationMin: 10,
      avgRunMin: 10,
    });
    expect(rows[1]).toMatchObject({ liters: 0, rainMm: null, et0Mm: null, avgRunMin: null });
  });

  it('folds into weeks, summing usage and weather and weighting flow by duration', () => {
    const days = [
      day('2026-06-01', { volumeMl: 10_000, durationSec: 600, runs: 1, avgFlowMlMin: 1000 }),
      day('2026-06-02', { volumeMl: 36_000, durationSec: 1800, runs: 2, avgFlowMlMin: 1200 }),
      day('2026-06-03'),
    ];
    const rows = buildChartRows(
      days,
      days.map((d) => wx(d.date, { rainMm: 1 })),
      7,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      date: '2026-06-01',
      span: 3,
      liters: 46,
      runs: 3,
      durationMin: 40,
      rainMm: 3,
      et0Mm: 12,
    });
    // (1000 * 600 + 1200 * 1800) / 2400 = 1150 ml/min.
    expect(rows[0]!.flowLMin).toBe(1.15);
  });

  it('switches to weekly buckets for long ranges', () => {
    const days = Array.from({ length: 365 }, (_, i) =>
      day(new Date(Date.UTC(2025, 5, 11 + i)).toISOString().slice(0, 10)),
    );
    expect(buildChartRows(days, [])).toHaveLength(53);
    expect(buildChartRows(days.slice(0, 30), [])).toHaveLength(30);
  });
});

describe('buildHeatmap', () => {
  it('lays days out in Sunday-first week columns with padding', () => {
    // 2026-06-10 is a Wednesday.
    const { weeks } = buildHeatmap([
      { date: '2026-06-10', value: 0 },
      { date: '2026-06-11', value: 10 },
      { date: '2026-06-12', value: 40 },
    ]);
    expect(weeks).toHaveLength(1);
    expect(weeks[0]!.map((c) => c?.date ?? null)).toEqual([
      null,
      null,
      null,
      '2026-06-10',
      '2026-06-11',
      '2026-06-12',
      null,
    ]);
  });

  it('assigns levels relative to the busiest day', () => {
    const { weeks, max } = buildHeatmap([
      { date: '2026-06-07', value: 0 },
      { date: '2026-06-08', value: 5 },
      { date: '2026-06-09', value: 20 },
      { date: '2026-06-10', value: 40 },
    ]);
    expect(max).toBe(40);
    expect(weeks[0]!.slice(0, 4).map((c) => c?.level)).toEqual([0, 1, 2, 4]);
  });

  it('handles no data and all-zero data', () => {
    expect(buildHeatmap([])).toEqual({ weeks: [], max: 0 });
    expect(buildHeatmap([{ date: '2026-06-07', value: 0 }]).weeks[0]![0]!.level).toBe(0);
  });
});
