import { describe, expect, it } from 'vitest';
import { parseRepeat, toRrule } from './repeat';

describe('repeat <-> RRULE', () => {
  it.each([
    ['FREQ=DAILY', { kind: 'daily', interval: 1 }],
    ['FREQ=DAILY;INTERVAL=2', { kind: 'daily', interval: 2 }],
    ['FREQ=WEEKLY;BYDAY=MO,WE,FR', { kind: 'weekly', days: ['MO', 'WE', 'FR'], interval: 1 }],
    ['FREQ=WEEKLY;INTERVAL=2;BYDAY=SA', { kind: 'weekly', days: ['SA'], interval: 2 }],
  ])('round-trips %s', (rule, repeat) => {
    expect(parseRepeat(rule)).toEqual(repeat);
    expect(toRrule(parseRepeat(rule))).toBe(rule);
  });

  it('orders weekdays Monday first and accepts the RRULE: prefix', () => {
    expect(parseRepeat('RRULE:FREQ=WEEKLY;BYDAY=su,mo')).toEqual({
      kind: 'weekly',
      days: ['MO', 'SU'],
      interval: 1,
    });
  });

  it('keeps rules the picker cannot show as custom', () => {
    for (const rule of [
      'FREQ=MONTHLY;BYMONTHDAY=1',
      'FREQ=DAILY;COUNT=5',
      'FREQ=WEEKLY;BYDAY=1MO',
    ]) {
      expect(parseRepeat(rule)).toEqual({ kind: 'custom', rrule: rule });
      expect(toRrule(parseRepeat(rule))).toBe(rule);
    }
  });
});
