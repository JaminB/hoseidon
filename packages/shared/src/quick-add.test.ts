import { describe, expect, it } from 'vitest';
import { matchDevice, parseQuickAdd } from './quick-add';
import { scheduleInputSchema } from './schedule';

const devices = [
  { id: 'front', name: 'Front Lawn' },
  { id: 'back', name: 'Back Beds' },
  { id: 'veg', name: 'Veggie Beds' },
  { id: 'dripA', name: 'Drip Line A' },
  { id: 'dripB', name: 'Drip Line B' },
  { id: 'side', name: 'Side Yard' },
];
const now = new Date('2026-06-10T12:00:00Z');
const parse = (text: string, tz = 'America/New_York') =>
  parseQuickAdd(text, { devices, now, timeZone: tz });

describe('parseQuickAdd', () => {
  it('parses "every other day 6am front lawn 15m"', () => {
    const r = parse('every other day 6am front lawn 15m');
    expect(r.ok).toBe(true);
    expect(r.draft).toEqual({
      name: 'Front Lawn',
      rrule: 'FREQ=DAILY;INTERVAL=2',
      dtstart: '2026-06-10T06:00',
      timezone: 'America/New_York',
      items: [{ deviceId: 'front', seconds: 900 }],
      cycleSoak: null,
    });
    expect(r.summary).toBe('Every other day at 6:00 AM');
    expect(r.warnings).toEqual([]);
  });

  it('parses days, 24h time, cycles and soak', () => {
    const r = parse('mon wed fri at 5:30 back beds 10 min x3 soak 20');
    expect(r.ok).toBe(true);
    expect(r.draft.rrule).toBe('FREQ=WEEKLY;BYDAY=MO,WE,FR');
    expect(r.draft.dtstart).toBe('2026-06-10T05:30');
    // "10 min x3" = three 10-minute cycles.
    expect(r.draft.items).toEqual([{ deviceId: 'back', seconds: 1800 }]);
    expect(r.draft.cycleSoak).toEqual({ cycles: 3, soakMinutes: 20 });
    expect(r.summary).toBe('Mon, Wed, Fri at 5:30 AM, 3 cycles with 20 min soak');
  });

  it('accepts several zones with their own durations', () => {
    const r = parse('daily 7:15pm front lawn 15m, drip line a 10 min and side yard 1h');
    expect(r.ok).toBe(true);
    expect(r.draft.rrule).toBe('FREQ=DAILY');
    expect(r.draft.dtstart).toBe('2026-06-10T19:15');
    expect(r.draft.items).toEqual([
      { deviceId: 'front', seconds: 900 },
      { deviceId: 'dripA', seconds: 600 },
      { deviceId: 'side', seconds: 3600 },
    ]);
    expect(r.draft.name).toBe('Front Lawn + 2 more');
  });

  it('shares one duration across zones listed together', () => {
    const r = parse('weekends 8am front lawn and back beds 12 minutes');
    expect(r.draft.rrule).toBe('FREQ=WEEKLY;BYDAY=SA,SU');
    expect(r.draft.items).toEqual([
      { deviceId: 'front', seconds: 720 },
      { deviceId: 'back', seconds: 720 },
    ]);
    expect(r.draft.name).toBe('Front Lawn + Back Beds');
  });

  it.each([
    ['every 3 days 6am lawn 5m', 'FREQ=DAILY;INTERVAL=3'],
    ['every day 6am lawn 5m', 'FREQ=DAILY'],
    ['weekdays 6am lawn 5m', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'],
    ['tuesdays and thursdays 6am lawn 5m', 'FREQ=WEEKLY;BYDAY=TU,TH'],
    ['every other monday 6am lawn 5m', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO'],
    ['weekly 6am lawn 5m', 'FREQ=WEEKLY'],
    ['odd days 6am lawn 5m', 'FREQ=MONTHLY;BYMONTHDAY=1,3,5,7,9,11,13,15,17,19,21,23,25,27,29,31'],
    ['even days 6am lawn 5m', 'FREQ=MONTHLY;BYMONTHDAY=2,4,6,8,10,12,14,16,18,20,22,24,26,28,30'],
  ])('repeat: %s', (text, rrule) => {
    const r = parse(text);
    expect(r.draft.rrule).toBe(rrule);
    expect(r.draft.items).toEqual([{ deviceId: 'front', seconds: 300 }]);
  });

  it.each([
    ['12am', '00:00'],
    ['12pm', '12:00'],
    ['6:45 a.m.', '06:45'],
    ['at 18:05', '18:05'],
    ['at 7', '07:00'],
    ['noon', '12:00'],
  ])('time: %s', (time, hhmm) => {
    expect(parse(`daily ${time} front lawn 5m`).draft.dtstart).toBe(`2026-06-10T${hhmm}`);
  });

  it('uses the local date in the given time zone', () => {
    // 02:00 UTC on the 10th is still the 9th in New York.
    const r = parseQuickAdd('daily 6am front lawn 5m', {
      devices,
      timeZone: 'America/New_York',
      now: new Date('2026-06-10T02:00:00Z'),
    });
    expect(r.draft.dtstart).toBe('2026-06-09T06:00');
  });

  it('defaults repeat and time with warnings', () => {
    const r = parse('front lawn 10m');
    expect(r.ok).toBe(true);
    expect(r.draft.rrule).toBe('FREQ=DAILY');
    expect(r.draft.dtstart).toBe('2026-06-10T06:00');
    expect(r.warnings).toHaveLength(2);
  });

  it('defaults soak when only cycles are given', () => {
    expect(parse('daily 6am lawn 5m 2x').draft.cycleSoak).toEqual({ cycles: 2, soakMinutes: 30 });
    expect(parse('daily 6am lawn 5m soak 1h').draft.cycleSoak).toEqual({
      cycles: 2,
      soakMinutes: 60,
    });
  });

  it('reports zones without durations and unknown devices', () => {
    const missing = parse('daily 6am front lawn');
    expect(missing.ok).toBe(false);
    expect(missing.errors[0]).toMatch(/No duration for "front lawn"/);

    const unknown = parse('daily 6am rose garden 5m');
    expect(unknown.ok).toBe(false);
    expect(unknown.errors).toContain('No device matches "rose garden".');
    expect(unknown.zones[0]).toMatchObject({ query: 'rose garden', deviceId: null });
    expect(unknown.draft.items).toEqual([]);
  });

  it('rejects out-of-range durations and times', () => {
    expect(parse('daily 6am lawn 30s').errors).toContain('"lawn" must run at least 1 minute.');
    expect(parse('daily 6am lawn 25h').ok).toBe(false);
    expect(parse('daily 13pm lawn 5m').ok).toBe(false);
    expect(parse('daily 6am lawn 5m x20').errors).toContain('Cycles must be 1 to 10.');
  });

  it('works without a device list', () => {
    const r = parseQuickAdd('daily 6am rose garden 5m', { now });
    expect(r.ok).toBe(true);
    expect(r.zones).toEqual([
      { query: 'rose garden', deviceId: null, deviceName: null, seconds: 300 },
    ]);
    expect(r.draft.name).toBe('Rose Garden');
    expect(r.draft.timezone).toBe('UTC');
  });

  it('produces drafts the schedule schema accepts', () => {
    const r = parse('mon wed fri at 5:30 back beds 10 min x3 soak 20');
    expect(scheduleInputSchema.safeParse(r.draft).success).toBe(true);
  });
});

describe('matchDevice', () => {
  it('prefers exact, then prefix, then word overlap', () => {
    expect(matchDevice('front lawn', devices)?.id).toBe('front');
    expect(matchDevice('veggie', devices)?.id).toBe('veg');
    expect(matchDevice('drip b', devices)?.id).toBe('dripB');
    expect(matchDevice('lawn', devices)?.id).toBe('front');
    expect(matchDevice('the moon', devices)).toBeNull();
    expect(matchDevice('', devices)).toBeNull();
  });
});
