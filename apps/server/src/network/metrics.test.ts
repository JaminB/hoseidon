import { describe, expect, it } from 'vitest';
import {
  batteryStats,
  buildTimeline,
  downsample,
  freshness,
  signalStats,
  type Transition,
} from './metrics';
import { classifyTransition } from './overview';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 5, 1);

/** Polls every 5 minutes from `a` to `b`. */
const polls = (a: number, b: number) => {
  const out: number[] = [];
  for (let t = a; t <= b; t += 5 * MIN) out.push(t);
  return out;
};

describe('buildTimeline', () => {
  const from = T0;
  const to = T0 + DAY;

  it('is fully online with no transitions', () => {
    const t = buildTimeline({
      from,
      to,
      onlineNow: true,
      transitions: [],
      polls: polls(from, to),
      firstDataAt: from,
    });
    expect(t.segments).toEqual([{ start: from, end: to, state: 'online' }]);
    expect(t.uptimePct).toBe(100);
    expect(t.incidents).toEqual([]);
  });

  it('records an offline stretch with its source and duration', () => {
    const t = buildTimeline({
      from,
      to,
      onlineNow: true,
      transitions: [
        { at: from + 6 * HOUR, online: false, source: 'webhook' },
        { at: from + 8 * HOUR, online: true, source: 'poll' },
      ],
      polls: polls(from, to),
      firstDataAt: from,
    });
    expect(t.segments.map((s) => s.state)).toEqual(['online', 'offline', 'online']);
    expect(t.incidents).toEqual([
      { start: from + 6 * HOUR, end: from + 8 * HOUR, source: 'webhook' },
    ]);
    expect(t.uptimePct).toBeCloseTo((22 / 24) * 100, 5);
  });

  it('infers the start state from the first transition and ignores repeats', () => {
    const transitions: Transition[] = [
      { at: from + 2 * HOUR, online: true, source: 'poll' },
      { at: from + 3 * HOUR, online: true, source: 'poll' },
    ];
    const t = buildTimeline({
      from,
      to,
      onlineNow: true,
      transitions,
      polls: polls(from, to),
      firstDataAt: from,
    });
    // "online" at 2h means it was offline before.
    expect(t.segments.map((s) => s.state)).toEqual(['offline', 'online']);
    expect(t.incidents).toHaveLength(1);
    expect(t.incidents[0]).toMatchObject({ start: from, end: from + 2 * HOUR });
  });

  it('keeps an incident that began before the window and is still open', () => {
    const t = buildTimeline({
      from,
      to,
      onlineNow: false,
      transitions: [{ at: from - 3 * HOUR, online: false, source: 'webhook' }],
      polls: polls(from, to),
      firstDataAt: from - DAY,
    });
    expect(t.segments).toEqual([{ start: from, end: to, state: 'offline' }]);
    expect(t.incidents).toEqual([{ start: from - 3 * HOUR, end: null, source: 'webhook' }]);
    expect(t.uptimePct).toBe(0);
  });

  it('marks gaps in polling and time before any data as unknown, not as downtime', () => {
    const t = buildTimeline({
      from,
      to,
      onlineNow: true,
      transitions: [],
      // Data starts at 6h, and the server was off from 12h to 18h.
      polls: [...polls(from + 6 * HOUR, from + 12 * HOUR), ...polls(from + 18 * HOUR, to)],
      firstDataAt: from + 6 * HOUR,
    });
    const states = t.segments.map((s) => s.state);
    expect(states).toEqual(['unknown', 'online', 'unknown', 'online']);
    expect(t.segments[0]).toMatchObject({ start: from, end: from + 6 * HOUR });
    // Unknown time is left out of uptime entirely.
    expect(t.uptimePct).toBe(100);
  });

  it('is all unknown, with no uptime figure, when nothing was polled', () => {
    const t = buildTimeline({
      from,
      to,
      onlineNow: true,
      transitions: [],
      polls: [],
      firstDataAt: null,
    });
    expect(t.segments).toEqual([{ start: from, end: to, state: 'unknown' }]);
    expect(t.uptimePct).toBeNull();
  });
});

describe('signalStats', () => {
  const at = (i: number) => T0 + i * 5 * MIN;

  it('counts weak episodes and sudden drops, ignoring offline samples', () => {
    const values = [80, 78, 40, 38, 36, 70, 72, 30, 60];
    const samples = values.map((value, i) => ({ at: at(i), online: true, value }));
    // An offline reading of 0 must not count as a weak signal.
    samples.push({ at: at(9), online: false, value: 0 });
    const s = signalStats(samples, 40);
    expect(s.latest).toBe(60);
    expect(s.min).toBe(30);
    // Below 40: 38, 36, then 30 -> two episodes.
    expect(s.weakEpisodes).toBe(2);
    expect(s.weakPct).toBeCloseTo((3 / 9) * 100, 0);
    // 78 -> 40 (38 points) and 72 -> 30 (42 points) are drops; 40 -> 38 is not.
    expect(s.drops).toBe(2);
    expect(s.series).toHaveLength(9);
  });

  it('does not call a fall across an outage a drop', () => {
    const s = signalStats(
      [
        { at: at(0), online: true, value: 90 },
        { at: at(0) + 3 * HOUR, online: true, value: 40 },
      ],
      40,
    );
    expect(s.drops).toBe(0);
  });

  it('is empty without usable samples', () => {
    const s = signalStats([{ at: at(0), online: false, value: null }], 40);
    expect(s).toMatchObject({
      latest: null,
      avg: null,
      weakPct: null,
      weakEpisodes: 0,
      series: [],
    });
  });
});

describe('batteryStats', () => {
  /** One sample every 3 hours for `days`, starting at `start`% and losing `perDay`. */
  const run = (start: number, perDay: number, days: number, t0 = T0) =>
    Array.from({ length: days * 8 + 1 }, (_, i) => ({
      at: t0 + i * 3 * HOUR,
      value: Math.round(start - (perDay * i) / 8),
    }));

  it('estimates drain and days left', () => {
    const b = batteryStats(run(90, 2, 10));
    expect(b.trend).toBe('draining');
    expect(b.drainPctPerDay).toBeGreaterThan(1.8);
    expect(b.drainPctPerDay).toBeLessThan(2.2);
    expect(b.latest).toBe(70);
    expect(b.daysLeft).toBeGreaterThanOrEqual(32);
    expect(b.daysLeft).toBeLessThanOrEqual(39);
  });

  it('calls a flat line stable and gives no days left', () => {
    const b = batteryStats(run(80, 0, 5));
    expect(b.trend).toBe('stable');
    expect(b.daysLeft).toBeNull();
  });

  it('restarts the trend after new batteries go in', () => {
    const old = run(30, 3, 5);
    const fresh = run(100, 1, 5, T0 + 5 * DAY + 3 * HOUR);
    const b = batteryStats([...old, ...fresh]);
    expect(b.trend).toBe('draining');
    expect(b.drainPctPerDay).toBeLessThan(1.5);
    expect(b.latest).toBe(95);
  });

  it('needs half a day of data before it will guess', () => {
    const b = batteryStats(
      run(90, 2, 0).concat({ at: T0 + HOUR, value: 89 }, { at: T0 + 2 * HOUR, value: 89 }),
    );
    expect(b.drainPctPerDay).toBeNull();
    expect(b.trend).toBe('unknown');
    expect(b.latest).toBe(89);
  });

  it('handles no readings', () => {
    expect(batteryStats([{ at: T0, value: null }])).toMatchObject({
      latest: null,
      trend: 'unknown',
    });
  });
});

describe('downsample', () => {
  it('leaves short series alone and averages long ones into buckets', () => {
    const pts: Array<[number, number]> = Array.from({ length: 1000 }, (_, i) => [i * MIN, i % 100]);
    expect(downsample(pts.slice(0, 50))).toHaveLength(50);
    const out = downsample(pts, 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out[0]![0]).toBeLessThan(out.at(-1)![0]);
  });
});

describe('freshness', () => {
  it('is stale past the poll gap or when there is no data', () => {
    expect(freshness(T0, T0 + 4 * MIN).stale).toBe(false);
    expect(freshness(T0, T0 + 30 * MIN)).toMatchObject({ stale: true, ageSec: 1800 });
    expect(freshness(null, T0)).toMatchObject({ stale: true, ageSec: null, lastPollAt: null });
  });
});

describe('classifyTransition', () => {
  it('reads our own and LinkTap webhook event names', () => {
    expect(classifyTransition('gateway.offline')).toEqual({ scope: 'gateway', online: false });
    expect(classifyTransition('gateway.online')).toEqual({ scope: 'gateway', online: true });
    expect(classifyTransition('device.offline')).toEqual({ scope: 'device', online: false });
    expect(classifyTransition('linktap.gatewayOffline')).toEqual({
      scope: 'gateway',
      online: false,
    });
    expect(classifyTransition('linktap.taplinkerOnline')).toEqual({
      scope: 'device',
      online: true,
    });
    expect(classifyTransition('device.alarm')).toBeNull();
    expect(classifyTransition('linktap.wateringOn')).toBeNull();
  });
});
