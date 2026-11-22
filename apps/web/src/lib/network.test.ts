import { describe, expect, it } from 'vitest';
import type { BatteryStats } from '@hoseidon/shared';
import {
  batteryLabel,
  batteryTone,
  formatOutage,
  formatUptime,
  linkWidth,
  segmentBars,
  signalTone,
  sparkline,
  uptimeTone,
} from './network';

describe('signalTone / linkWidth', () => {
  it('grades against the configured threshold', () => {
    expect(signalTone(80, 40)).toBe('ok');
    expect(signalTone(39, 40)).toBe('warn');
    expect(signalTone(19, 40)).toBe('danger');
    expect(signalTone(null, 40)).toBe('muted');
    expect(signalTone(55, 60)).toBe('warn');
  });

  it('makes strong links thicker, within bounds', () => {
    expect(linkWidth(100)).toBeGreaterThan(linkWidth(50));
    expect(linkWidth(50)).toBeGreaterThan(linkWidth(10));
    expect(linkWidth(500)).toBe(linkWidth(100));
    expect(linkWidth(null)).toBeGreaterThan(0);
  });
});

describe('segmentBars', () => {
  const T = Date.UTC(2026, 5, 1);
  const H = 3_600_000;
  const iso = (ms: number) => new Date(ms).toISOString();

  it('turns segments into percentages of the window', () => {
    const bars = segmentBars(
      [
        { start: iso(T), end: iso(T + 6 * H), state: 'online' },
        { start: iso(T + 6 * H), end: iso(T + 9 * H), state: 'offline' },
        { start: iso(T + 9 * H), end: iso(T + 24 * H), state: 'online' },
      ],
      T,
      T + 24 * H,
    );
    expect(bars.map((b) => [b.left, b.width, b.state])).toEqual([
      [0, 25, 'online'],
      [25, 12.5, 'offline'],
      [37.5, 62.5, 'online'],
    ]);
  });

  it('clamps segments to the window and drops empty ones', () => {
    const bars = segmentBars(
      [
        { start: iso(T - 5 * H), end: iso(T + 2 * H), state: 'offline' },
        { start: iso(T + 30 * H), end: iso(T + 40 * H), state: 'online' },
      ],
      T,
      T + 24 * H,
    );
    expect(bars).toHaveLength(1);
    expect(bars[0]).toMatchObject({ left: 0, state: 'offline' });
    expect(bars[0]!.width).toBeCloseTo((2 / 24) * 100);
  });
});

describe('uptime formatting', () => {
  it('formats and grades', () => {
    expect(formatUptime(null)).toBe('—');
    expect(formatUptime(100)).toBe('100%');
    expect(formatUptime(99.97)).toBe('100%');
    expect(formatUptime(99.4)).toBe('99.4%');
    expect(formatUptime(87.3)).toBe('87%');
    expect(uptimeTone(99.9)).toBe('ok');
    expect(uptimeTone(95)).toBe('warn');
    expect(uptimeTone(60)).toBe('danger');
    expect(uptimeTone(null)).toBe('muted');
  });
});

describe('sparkline', () => {
  it('maps values into the box with a fixed domain', () => {
    const s = sparkline(
      [
        [0, 0],
        [10, 100],
      ],
      100,
      50,
      { threshold: 50, pad: 0 },
    );
    expect(s.line).toBe('M0 50 L100 0');
    expect(s.thresholdY).toBe(25);
    expect(s.area.endsWith('Z')).toBe(true);
    expect(s.last).toEqual({ x: 100, y: 0 });
  });

  it('copes with one point and no points', () => {
    expect(sparkline([[5, 50]], 100, 40).line).toMatch(/^M50 /);
    expect(sparkline([], 100, 40)).toMatchObject({ line: '', last: null });
  });

  it('clamps out-of-range values', () => {
    const s = sparkline([[0, 250]], 10, 10, { pad: 0 });
    expect(s.last?.y).toBe(0);
  });
});

describe('battery labels', () => {
  const base: BatteryStats = {
    latest: 70,
    drainPctPerDay: 2,
    daysLeft: 35,
    trend: 'draining',
    series: [],
  };
  it('describes drain, stable and unknown', () => {
    expect(batteryLabel(base)).toBe('−2%/day · about 35 days left');
    expect(batteryLabel({ ...base, trend: 'stable' })).toBe('Holding steady');
    expect(batteryLabel({ ...base, trend: 'unknown' })).toBe('Not enough data yet');
    expect(batteryLabel({ ...base, daysLeft: 1 })).toContain('1 day left');
  });
  it('flags short runways even when the level looks fine', () => {
    expect(batteryTone(base)).toBe('ok');
    expect(batteryTone({ ...base, daysLeft: 10 })).toBe('warn');
    expect(batteryTone({ ...base, daysLeft: 3 })).toBe('danger');
    expect(batteryTone({ ...base, latest: 8, daysLeft: null })).toBe('danger');
  });
});

describe('formatOutage', () => {
  it('picks a coarse unit', () => {
    expect(formatOutage(20)).toBe('1 min');
    expect(formatOutage(45 * 60)).toBe('45 min');
    expect(formatOutage(3 * 3600)).toBe('3 h');
    expect(formatOutage(5 * 86_400)).toBe('5 days');
  });
});
