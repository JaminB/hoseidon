import { describe, expect, it } from 'vitest';
import { DEFAULT_SKIP_RULES } from '@hoseidon/shared';
import type { ScheduleRow } from '../db/schema';
import {
  minutes,
  nearestColorId,
  occurrenceLogEvent,
  runLogEvent,
  scheduleEvent,
  skipOverlay,
  toGoogleRrule,
  type MapContext,
} from './mapping';

const NAMES: Record<string, string> = { a: 'Front Lawn', b: 'Veggie Beds', c: 'Drip' };
const ctx: MapContext = {
  deviceName: (id) => NAMES[id] ?? id,
  gatewayOf: (id) => (id === 'c' ? 'gw2' : 'gw1'),
  quantize: (s) => Math.max(60, Math.round(s / 60) * 60),
};

function schedule(over: Partial<ScheduleRow> = {}): ScheduleRow {
  const at = new Date('2026-06-01T00:00:00Z');
  return {
    id: 7,
    name: 'Morning lawn',
    color: '#22b8cf',
    rrule: 'FREQ=DAILY;INTERVAL=2',
    dtstart: '2026-06-10T06:00',
    timezone: 'America/New_York',
    enabled: true,
    items: [{ deviceId: 'a', seconds: 900 }],
    cycleSoak: null,
    sequential: true,
    skipRules: DEFAULT_SKIP_RULES,
    gcalEventId: null,
    effectiveFrom: at,
    createdAt: at,
    updatedAt: at,
    ...over,
  };
}

describe('toGoogleRrule', () => {
  it('prefixes RRULE: and normalizes case', () => {
    expect(toGoogleRrule('freq=weekly;byday=mo,we,fr', 'UTC')).toBe(
      'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR',
    );
    expect(toGoogleRrule('RRULE:FREQ=DAILY;COUNT=5', 'UTC')).toBe('RRULE:FREQ=DAILY;COUNT=5');
  });

  it('turns a wall-clock UNTIL into UTC in the schedule zone (DST aware)', () => {
    // 23:59:59 local in New York: EDT (-4) in June, EST (-5) in December.
    expect(toGoogleRrule('FREQ=DAILY;UNTIL=20260630T235959', 'America/New_York')).toBe(
      'RRULE:FREQ=DAILY;UNTIL=20260701T035959Z',
    );
    expect(toGoogleRrule('FREQ=DAILY;UNTIL=20261231T235959Z', 'America/New_York')).toBe(
      'RRULE:FREQ=DAILY;UNTIL=20270101T045959Z',
    );
  });

  it('reads a date-only UNTIL as local midnight, like the engine', () => {
    expect(toGoogleRrule('FREQ=DAILY;UNTIL=20260630', 'Europe/Berlin')).toBe(
      'RRULE:FREQ=DAILY;UNTIL=20260629T220000Z',
    );
  });
});

describe('nearestColorId', () => {
  it('maps schedule colors onto the Google palette', () => {
    expect(nearestColorId('#22b8cf')).toBe('7'); // aqua -> Peacock
    expect(nearestColorId('#0b8043')).toBe('10'); // Basil itself
    expect(nearestColorId('#d00a0a')).toBe('11'); // red -> Tomato
    expect(nearestColorId('#e8590c')).toBe('6'); // orange -> Tangerine
    expect(nearestColorId('#fab005')).toBe('5'); // yellow -> Banana
    expect(nearestColorId('nope')).toBe('7');
  });
});

describe('minutes', () => {
  it('formats durations', () => {
    expect(minutes(59)).toBe('1 min');
    expect(minutes(900)).toBe('15 min');
    expect(minutes(3600)).toBe('1 h');
    expect(minutes(4500)).toBe('1 h 15 min');
  });
});

describe('scheduleEvent', () => {
  it('builds a recurring event in the schedule zone', () => {
    const ev = scheduleEvent(schedule(), ctx);
    expect(ev).toMatchObject({
      summary: '💧 Morning lawn',
      start: { dateTime: '2026-06-10T06:00:00', timeZone: 'America/New_York' },
      end: { dateTime: '2026-06-10T06:15:00', timeZone: 'America/New_York' },
      recurrence: ['RRULE:FREQ=DAILY;INTERVAL=2'],
      colorId: '7',
      transparency: 'transparent',
      reminders: { useDefault: false },
      extendedProperties: { private: { hoseidonScheduleId: '7', hoseidonKind: 'schedule' } },
    });
    expect(ev.description).toContain('• Front Lawn: 15 min');
    expect(ev.description).toContain('Managed by Hoseidon');
  });

  it('spans every zone, cycle and soak', () => {
    // a and b share gw1 and run one after another; 2 cycles each with a 20-minute soak.
    // c1: a 06:00-06:05, b 06:05-06:10. c2: a 06:25-06:30 (soak after 06:05), b 06:30-06:35.
    const ev = scheduleEvent(
      schedule({
        items: [
          { deviceId: 'a', seconds: 600 },
          { deviceId: 'b', seconds: 600 },
        ],
        cycleSoak: { cycles: 2, soakMinutes: 20 },
        skipRules: { ...DEFAULT_SKIP_RULES, rainForecastMm: 5, etScaling: true },
      }),
      ctx,
    );
    expect(ev.end!.dateTime).toBe('2026-06-10T06:35:00');
    expect(ev.description).toContain('• Veggie Beds: 10 min (2 × 5 min, 20 min soak)');
    expect(ev.description).toContain('Zones run one at a time.');
    expect(ev.description).toContain('Skips on rain over 5 mm.');
    expect(ev.description).toContain('evapotranspiration');
  });

  it('overlaps zones on different gateways or when not sequential', () => {
    const ev = scheduleEvent(
      schedule({
        items: [
          { deviceId: 'a', seconds: 600 },
          { deviceId: 'c', seconds: 1200 },
        ],
      }),
      ctx,
    );
    expect(ev.end!.dateTime).toBe('2026-06-10T06:20:00');
  });
});

describe('skipOverlay', () => {
  const s = schedule();
  it('is null when nothing was skipped', () => {
    expect(skipOverlay(s, [{ deviceId: 'a', status: 'done', skipReason: null }], ctx)).toBeNull();
  });

  it('marks a fully skipped occurrence grey with the reason', () => {
    const o = skipOverlay(
      s,
      [
        { deviceId: 'a', status: 'skipped', skipReason: 'Rain forecast 8 mm' },
        { deviceId: 'b', status: 'skipped', skipReason: 'Rain forecast 8 mm' },
      ],
      ctx,
    );
    expect(o).toMatchObject({ summary: '⏭ Morning lawn (skipped)', colorId: '8' });
    expect(o!.description).toMatch(/^⏭ Front Lawn, Veggie Beds: Rain forecast 8 mm/);
  });

  it('marks a partial skip', () => {
    const o = skipOverlay(
      s,
      [
        { deviceId: 'a', status: 'done', skipReason: null },
        { deviceId: 'b', status: 'skipped', skipReason: 'Skipped by you' },
      ],
      ctx,
    );
    expect(o).toMatchObject({ summary: '💧 Morning lawn (partly skipped)', colorId: '7' });
  });
});

describe('run log events', () => {
  const t = (iso: string) => new Date(iso);
  it('summarizes an occurrence from its real runs', () => {
    const ev = occurrenceLogEvent(
      schedule(),
      [
        { deviceId: 'a', status: 'done', skipReason: null, error: null, runId: 1 },
        { deviceId: 'a', status: 'done', skipReason: null, error: null, runId: 2 },
        { deviceId: 'b', status: 'skipped', skipReason: 'Freeze', error: null, runId: null },
      ],
      [
        {
          id: 1,
          deviceId: 'a',
          startedAt: t('2026-06-10T10:00:00Z'),
          endedAt: t('2026-06-10T10:05:00Z'),
          durationSec: 300,
          volumeMl: 20_000,
        },
        {
          id: 2,
          deviceId: 'a',
          startedAt: t('2026-06-10T10:25:00Z'),
          endedAt: t('2026-06-10T10:30:00Z'),
          durationSec: 300,
          volumeMl: 21_000,
        },
      ],
      ctx,
    );
    expect(ev).toMatchObject({
      summary: '✓ Morning lawn · 10 min',
      start: { dateTime: '2026-06-10T06:00:00', timeZone: 'America/New_York' },
      end: { dateTime: '2026-06-10T06:30:00' },
      extendedProperties: { private: { hoseidonKind: 'log' } },
    });
    expect(ev!.description).toContain('✓ Front Lawn: 10 min, 41 L');
    expect(ev!.description).toContain('⏭ Veggie Beds: Freeze');
  });

  it('is null when nothing watered', () => {
    expect(
      occurrenceLogEvent(
        schedule(),
        [{ deviceId: 'a', status: 'skipped', skipReason: 'Rain', error: null, runId: null }],
        [],
        ctx,
      ),
    ).toBeNull();
  });

  it('logs a manual run', () => {
    const ev = runLogEvent(
      {
        id: 9,
        deviceId: 'b',
        source: 'manual',
        startedAt: t('2026-06-10T12:00:00Z'),
        endedAt: t('2026-06-10T12:10:00Z'),
        durationSec: null,
        volumeMl: null,
      },
      'UTC',
      ctx,
    );
    expect(ev).toMatchObject({
      summary: '✓ Veggie Beds · 10 min',
      start: { dateTime: '2026-06-10T12:00:00', timeZone: 'UTC' },
      end: { dateTime: '2026-06-10T12:10:00' },
    });
    expect(ev!.description).toContain('Started by hand.');
  });
});
