import { describe, expect, it } from 'vitest';
import {
  addDays,
  describeRrule,
  dragRange,
  fromLocalDateTime,
  layoutDay,
  toLocalDateTime,
  visibleHourRange,
} from './calendar';

const at = (s: string) => fromLocalDateTime(s);
const block = (id: string, start: string, end: string) => ({ id, start: at(start), end: at(end) });

describe('week math', () => {
  it('adds calendar days', () => {
    expect(toLocalDateTime(addDays(at('2026-12-31T06:30'), 1))).toBe('2027-01-01T06:30');
  });

  it('round-trips local date-times', () => {
    expect(toLocalDateTime(at('2026-03-08T05:45'))).toBe('2026-03-08T05:45');
  });
});

describe('dragRange', () => {
  it('snaps outward to 15 minutes in either direction', () => {
    expect(dragRange(362, 391)).toEqual({ start: 360, end: 405 });
    expect(dragRange(391, 362)).toEqual({ start: 360, end: 405 });
  });

  it('is at least one step and stays inside the day', () => {
    expect(dragRange(400, 400)).toEqual({ start: 390, end: 405 });
    expect(dragRange(1435, 1500)).toEqual({ start: 1425, end: 1440 });
  });
});

describe('layoutDay', () => {
  const day = at('2026-11-21T00:00');

  it('gives non-overlapping blocks the full width', () => {
    const out = layoutDay(
      [
        block('a', '2026-11-21T06:00', '2026-11-21T06:30'),
        block('b', '2026-11-21T07:00', '2026-11-21T07:10'),
      ],
      day,
    );
    expect(out.map((b) => [b.item.id, b.lane, b.lanes])).toEqual([
      ['a', 0, 1],
      ['b', 0, 1],
    ]);
    expect(out[0]).toMatchObject({ top: 360, bottom: 390 });
  });

  it('packs overlapping blocks into lanes per cluster', () => {
    const out = layoutDay(
      [
        block('a', '2026-11-21T06:00', '2026-11-21T07:00'),
        block('b', '2026-11-21T06:30', '2026-11-21T07:30'),
        block('c', '2026-11-21T07:00', '2026-11-21T07:15'),
        block('d', '2026-11-21T09:00', '2026-11-21T09:30'),
      ],
      day,
    );
    const lanes = Object.fromEntries(out.map((b) => [b.item.id, [b.lane, b.lanes]]));
    expect(lanes).toEqual({ a: [0, 2], b: [1, 2], c: [0, 2], d: [0, 1] });
  });

  it('places blocks on the wall-clock grid on DST days', () => {
    const springForward = at('2026-03-08T00:00');
    const out = layoutDay([block('a', '2026-03-08T06:00', '2026-03-08T06:30')], springForward);
    expect(out[0]).toMatchObject({ top: 360, bottom: 390 });
  });

  it('clips blocks that cross midnight', () => {
    const out = layoutDay([block('a', '2026-11-20T23:30', '2026-11-21T00:30')], day);
    expect(out[0]).toMatchObject({ top: 0, bottom: 30, clippedStart: true, clippedEnd: false });
    expect(layoutDay([block('x', '2026-11-22T00:00', '2026-11-22T01:00')], day)).toEqual([]);
  });
});

describe('describeRrule', () => {
  it.each([
    ['FREQ=DAILY', 'Every day'],
    ['FREQ=DAILY;INTERVAL=2', 'Every other day'],
    ['FREQ=DAILY;INTERVAL=3', 'Every 3 days'],
    ['FREQ=WEEKLY;BYDAY=MO,WE,FR', 'Mon, Wed, Fri'],
    ['FREQ=WEEKLY;INTERVAL=2;BYDAY=SA', 'Sat · every other week'],
    ['FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU', 'Every day'],
    [
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TU,WE,TH,FR,SA,SU',
      'Mon, Tue, Wed, Thu, Fri, Sat, Sun · every other week',
    ],
    ['FREQ=YEARLY', 'FREQ=YEARLY'],
  ])('%s -> %s', (rule, text) => {
    expect(describeRrule(rule)).toBe(text);
  });
});

describe('visibleHourRange', () => {
  const day = at('2026-11-21T00:00');

  it('fits the earliest and latest block, with padding', () => {
    const items = [
      block('a', '2026-11-21T05:00', '2026-11-21T05:30'),
      block('b', '2026-11-21T22:55', '2026-11-21T23:10'),
    ];
    expect(visibleHourRange(items, [day])).toEqual([4, 24]);
  });

  it('keeps a minimum height and falls back when nothing is scheduled', () => {
    expect(visibleHourRange([block('a', '2026-11-21T06:00', '2026-11-21T06:30')], [day])).toEqual([
      3, 11,
    ]);
    expect(visibleHourRange([], [day])).toEqual([5, 19]);
  });

  it('ignores blocks on days that are not shown', () => {
    const later = [block('a', '2026-11-25T22:00', '2026-11-25T22:30')];
    expect(visibleHourRange(later, [day])).toEqual([5, 19]);
  });
});
