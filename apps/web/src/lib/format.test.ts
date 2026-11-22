import { describe, expect, it } from 'vitest';
import { batteryLevel, formatClock, formatDuration, formatRelative, signalBars } from './format';
import { isDismissable, isLinkTapPlan } from './linktap';

describe('formatDuration', () => {
  it.each([
    [0, '0 min'],
    [30, '30 s'],
    [60, '1 min'],
    [600, '10 min'],
    [3600, '1 h'],
    [3900, '1 h 5 min'],
  ])('%i -> %s', (sec, text) => expect(formatDuration(sec)).toBe(text));
});

describe('formatClock', () => {
  it('ticks like a countdown', () => {
    expect(formatClock(245)).toBe('4:05');
    expect(formatClock(3729)).toBe('1:02:09');
    expect(formatClock(0.2)).toBe('0:01');
    expect(formatClock(-5)).toBe('0:00');
  });
});

describe('formatRelative', () => {
  const now = Date.parse('2026-11-21T12:00:00Z');
  it('reads naturally both ways', () => {
    expect(formatRelative('2026-11-21T12:00:20Z', now)).toBe('now');
    expect(formatRelative('2026-11-21T12:05:00Z', now)).toBe('in 5 min');
    expect(formatRelative('2026-11-21T09:00:00Z', now)).toBe('3 h ago');
    expect(formatRelative('2026-11-23T12:00:00Z', now)).toBe('in 2 d');
  });
});

describe('device helpers', () => {
  it('buckets battery and signal', () => {
    expect(batteryLevel(null)).toBe('unknown');
    expect(batteryLevel(3)).toBe('critical');
    expect(batteryLevel(14)).toBe('low');
    expect(batteryLevel(84)).toBe('full');
    expect([0, 18, 40, 72, 95, null].map(signalBars)).toEqual([0, 1, 2, 3, 4, 0]);
  });

  it('flags LinkTap-app plans and dismissable alarms', () => {
    expect(['M', 'N', 'T', 'I', null].map((m) => isLinkTapPlan(m as never))).toEqual([
      false,
      false,
      true,
      true,
      false,
    ]);
    expect(isDismissable('noWater')).toBe(true);
    expect(isDismissable('leakFlag')).toBe(false);
  });
});
