import { describe, expect, it } from 'vitest';
import {
  expandOccurrences,
  InvalidRecurrenceError,
  nextOccurrence,
  validateRecurrence,
} from './occurrences';
import { fromWall, parseLocal, toWall } from './time';

const NY = 'America/New_York';
const iso = (dates: Date[]) => dates.map((d) => d.toISOString());

describe('fromWall / toWall', () => {
  it('round-trips ordinary times', () => {
    const at = fromWall(parseLocal('2026-06-10T06:00'), NY);
    expect(at.toISOString()).toBe('2026-06-10T10:00:00.000Z');
    expect(toWall(at, NY).toISOString()).toBe('2026-06-10T06:00:00.000Z');
  });

  it('moves times in the spring-forward gap forward', () => {
    // 2026-03-08 02:30 does not exist in New York; it becomes 03:30 EDT.
    expect(fromWall(parseLocal('2026-03-08T02:30'), NY).toISOString()).toBe(
      '2026-03-08T07:30:00.000Z',
    );
  });

  it('uses the first of two repeated fall-back times', () => {
    // 2026-11-01 01:30 happens at 05:30Z (EDT) and 06:30Z (EST).
    expect(fromWall(parseLocal('2026-11-01T01:30'), NY).toISOString()).toBe(
      '2026-11-01T05:30:00.000Z',
    );
  });

  it('handles zones east of UTC and half-hour offsets', () => {
    expect(fromWall(parseLocal('2026-01-15T06:00'), 'Australia/Adelaide').toISOString()).toBe(
      '2026-01-14T19:30:00.000Z',
    );
  });
});

describe('expandOccurrences', () => {
  it('keeps the wall-clock time across spring-forward', () => {
    const r = { rrule: 'FREQ=DAILY', dtstart: '2026-03-06T06:00', timezone: NY };
    const got = expandOccurrences(r, new Date('2026-03-06T00:00Z'), new Date('2026-03-10T00:00Z'));
    expect(iso(got)).toEqual([
      '2026-03-06T11:00:00.000Z', // EST
      '2026-03-07T11:00:00.000Z',
      '2026-03-08T10:00:00.000Z', // EDT from here on
      '2026-03-09T10:00:00.000Z',
    ]);
  });

  it('keeps the wall-clock time across fall-back', () => {
    const r = { rrule: 'FREQ=DAILY', dtstart: '2026-10-30T19:30', timezone: NY };
    const got = expandOccurrences(r, new Date('2026-10-30T00:00Z'), new Date('2026-11-03T00:00Z'));
    expect(iso(got)).toEqual([
      '2026-10-30T23:30:00.000Z',
      '2026-10-31T23:30:00.000Z',
      '2026-11-02T00:30:00.000Z', // Nov 1 19:30 EST
    ]);
  });

  it('runs a 02:30 schedule at 03:30 on the spring-forward day', () => {
    const r = { rrule: 'FREQ=DAILY', dtstart: '2026-03-07T02:30', timezone: NY };
    const got = expandOccurrences(r, new Date('2026-03-07T00:00Z'), new Date('2026-03-10T00:00Z'));
    expect(iso(got)).toEqual([
      '2026-03-07T07:30:00.000Z',
      '2026-03-08T07:30:00.000Z', // 03:30 EDT
      '2026-03-09T06:30:00.000Z', // 02:30 EDT
    ]);
  });

  it('runs a 01:30 schedule once on the fall-back day', () => {
    const r = { rrule: 'FREQ=DAILY', dtstart: '2026-10-31T01:30', timezone: NY };
    const got = expandOccurrences(r, new Date('2026-10-31T00:00Z'), new Date('2026-11-03T00:00Z'));
    expect(iso(got)).toEqual([
      '2026-10-31T05:30:00.000Z',
      '2026-11-01T05:30:00.000Z',
      '2026-11-02T06:30:00.000Z',
    ]);
  });

  it('expands every-other-day and weekly BYDAY rules', () => {
    const alt = { rrule: 'FREQ=DAILY;INTERVAL=2', dtstart: '2026-06-01T06:00', timezone: 'UTC' };
    expect(
      iso(expandOccurrences(alt, new Date('2026-06-01T00:00Z'), new Date('2026-06-08T00:00Z'))),
    ).toEqual([
      '2026-06-01T06:00:00.000Z',
      '2026-06-03T06:00:00.000Z',
      '2026-06-05T06:00:00.000Z',
      '2026-06-07T06:00:00.000Z',
    ]);
    const mwf = { rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR', dtstart: '2026-06-01T05:30', timezone: NY };
    const got = expandOccurrences(
      mwf,
      new Date('2026-06-01T00:00Z'),
      new Date('2026-06-08T00:00Z'),
    );
    expect(got.map((d) => toWall(d, NY).toISOString().slice(0, 16))).toEqual([
      '2026-06-01T05:30',
      '2026-06-03T05:30',
      '2026-06-05T05:30',
    ]);
  });

  it('honours the window bounds, COUNT and UNTIL', () => {
    const r = { rrule: 'FREQ=DAILY;COUNT=3', dtstart: '2026-06-01T06:00', timezone: 'UTC' };
    expect(
      expandOccurrences(r, new Date('2026-06-02T06:00Z'), new Date('2026-07-01T00:00Z')),
    ).toHaveLength(2);
    const until = {
      rrule: 'FREQ=DAILY;UNTIL=20260603T235900',
      dtstart: '2026-06-01T06:00',
      timezone: NY,
    };
    expect(
      expandOccurrences(until, new Date('2026-05-01T00:00Z'), new Date('2026-07-01T00:00Z')),
    ).toHaveLength(3);
    expect(
      expandOccurrences(r, new Date('2026-06-02T00:00Z'), new Date('2026-06-01T00:00Z')),
    ).toEqual([]);
  });

  it('never returns occurrences before dtstart', () => {
    const r = { rrule: 'FREQ=DAILY', dtstart: '2026-06-10T06:00', timezone: NY };
    const got = expandOccurrences(r, new Date('2026-06-01T00:00Z'), new Date('2026-06-12T00:00Z'));
    expect(iso(got)).toEqual(['2026-06-10T10:00:00.000Z', '2026-06-11T10:00:00.000Z']);
  });
});

describe('nextOccurrence', () => {
  const r = { rrule: 'FREQ=WEEKLY;BYDAY=SA', dtstart: '2026-01-01T07:00', timezone: NY };

  it('finds the next one, inclusive', () => {
    expect(nextOccurrence(r, new Date('2026-06-10T00:00Z'))?.toISOString()).toBe(
      '2026-06-13T11:00:00.000Z',
    );
    expect(nextOccurrence(r, new Date('2026-06-13T11:00Z'))?.toISOString()).toBe(
      '2026-06-13T11:00:00.000Z',
    );
  });

  it('returns null when the rule has ended', () => {
    const done = { ...r, rrule: 'FREQ=DAILY;COUNT=1' };
    expect(nextOccurrence(done, new Date('2026-06-10T00:00Z'))).toBeNull();
  });
});

describe('validateRecurrence', () => {
  it('rejects junk and sub-daily rules', () => {
    const base = { dtstart: '2026-06-01T06:00', timezone: 'UTC' };
    expect(() => validateRecurrence({ ...base, rrule: 'FREQ=HOURLY' })).toThrow(
      InvalidRecurrenceError,
    );
    expect(() => validateRecurrence({ ...base, rrule: 'INTERVAL=2' })).toThrow(
      InvalidRecurrenceError,
    );
    expect(() => validateRecurrence({ ...base, rrule: 'FREQ=DAILY;BYDAY=XX' })).toThrow();
    expect(() => validateRecurrence({ ...base, rrule: 'FREQ=DAILY' })).not.toThrow();
  });
});
