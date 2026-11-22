import type { BatteryStats, SignalStats, TimelineSegment, TimelineState } from '@hoseidon/shared';

/**
 * Pure metric derivation for the Network page. Everything here takes plain data and a window, so
 * it is testable without a database.
 */

const MIN = 60_000;
const DAY = 86_400_000;

/** getAllDevices is polled every 5 min; more than three missed polls means we were not watching. */
export const GAP_MS = 20 * MIN;
/** A fall this big between two polls is a drop worth calling out. */
export const DROP_POINTS = 25;
/** Max points sent to the browser per series. */
export const MAX_SERIES_POINTS = 120;

export interface Transition {
  at: number;
  online: boolean;
  source: 'webhook' | 'poll';
}

export interface TimelineInput {
  from: number;
  to: number;
  /** Where the subject is now; used when there is no transition to infer the start from. */
  onlineNow: boolean;
  /** All transitions, any order. Repeats of the same state are ignored. */
  transitions: Transition[];
  /** Times we polled (any device of the gateway). Gaps longer than GAP_MS become "unknown". */
  polls: number[];
  /** Earliest time we have any data; before it the state is unknown. */
  firstDataAt: number | null;
  gapMs?: number;
}

export interface Incident {
  start: number;
  end: number | null;
  source: 'webhook' | 'poll';
}

export interface Timeline {
  segments: Array<{ start: number; end: number; state: TimelineState }>;
  /** Online / (online + offline), 0-100. Null when everything is unknown. */
  uptimePct: number | null;
  incidents: Incident[];
}

/**
 * Builds the online/offline/unknown timeline for [from, to].
 *
 * State before the first transition is the opposite of that transition (an "offline" event means
 * it was online before), or the current state when there are none. Stretches where we weren't
 * polling are "unknown", and so is anything before we had data.
 */
export function buildTimeline(input: TimelineInput): Timeline {
  const { from, to, gapMs = GAP_MS } = input;

  // Drop repeats so each transition really changes state.
  const sorted = [...input.transitions].sort((a, b) => a.at - b.at);
  const changes: Transition[] = [];
  for (const t of sorted) {
    const prev = changes.at(-1);
    if (!prev || prev.online !== t.online) changes.push(t);
  }

  // State at the start of the window: the last transition before it, else the opposite of the
  // first one after it (an "offline" event means it was online before), else the current state.
  const before = changes.filter((t) => t.at <= from).at(-1);
  const after = changes.filter((t) => t.at > from);
  let state = before ? before.online : after[0] ? !after[0].online : input.onlineNow;
  let open: Incident | null = state
    ? null
    : { start: before?.at ?? from, end: null, source: before?.source ?? 'poll' };
  const known: Array<{ start: number; end: number; online: boolean }> = [];
  const incidents: Incident[] = [];
  let cursor = from;

  for (const t of after) {
    if (t.at >= to) break;
    known.push({ start: cursor, end: t.at, online: state });
    cursor = t.at;
    state = t.online;
    if (!t.online) {
      open = { start: t.at, end: null, source: t.source };
    } else if (open) {
      incidents.push({ ...open, end: t.at });
      open = null;
    }
  }
  known.push({ start: cursor, end: to, online: state });
  if (open) incidents.push(open);

  // Cut out the stretches we cannot vouch for.
  const unknown = unknownRanges(input.polls, from, to, gapMs, input.firstDataAt);
  const segments = mergeSegments(applyUnknown(known, unknown));

  let up = 0;
  let down = 0;
  for (const s of segments) {
    if (s.state === 'online') up += s.end - s.start;
    else if (s.state === 'offline') down += s.end - s.start;
  }
  return {
    segments,
    uptimePct: up + down === 0 ? null : (up / (up + down)) * 100,
    incidents,
  };
}

function unknownRanges(
  polls: number[],
  from: number,
  to: number,
  gapMs: number,
  firstDataAt: number | null,
): Array<[number, number]> {
  if (polls.length === 0) return [[from, to]];
  const ranges: Array<[number, number]> = [];
  const sorted = [...polls].sort((a, b) => a - b);
  const start = Math.max(from, firstDataAt ?? sorted[0]!);
  if (start > from) ranges.push([from, start]);
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!;
    const b = sorted[i]!;
    if (b - a > gapMs) ranges.push([Math.max(a + gapMs, from), Math.min(b, to)]);
  }
  // The most recent poll is the end of what we know, up to one gap.
  const last = sorted.at(-1)!;
  if (to - last > gapMs) ranges.push([Math.max(last + gapMs, from), to]);
  return ranges.filter(([a, b]) => b > a);
}

function applyUnknown(
  known: Array<{ start: number; end: number; online: boolean }>,
  unknown: Array<[number, number]>,
): Timeline['segments'] {
  const out: Timeline['segments'] = [];
  for (const k of known) {
    let cur = k.start;
    const overlaps = unknown
      .filter(([a, b]) => b > k.start && a < k.end)
      .sort((x, y) => x[0] - y[0]);
    for (const [a, b] of overlaps) {
      const s = Math.max(a, k.start);
      const e = Math.min(b, k.end);
      if (s > cur) out.push({ start: cur, end: s, state: k.online ? 'online' : 'offline' });
      if (e > Math.max(s, cur)) out.push({ start: Math.max(s, cur), end: e, state: 'unknown' });
      cur = Math.max(cur, e);
    }
    if (k.end > cur) out.push({ start: cur, end: k.end, state: k.online ? 'online' : 'offline' });
  }
  return out;
}

function mergeSegments(segs: Timeline['segments']): Timeline['segments'] {
  const out: Timeline['segments'] = [];
  for (const s of segs) {
    if (s.end <= s.start) continue;
    const prev = out.at(-1);
    if (prev && prev.state === s.state && prev.end === s.start) prev.end = s.end;
    else out.push({ ...s });
  }
  return out;
}

export const toSegments = (segs: Timeline['segments']): TimelineSegment[] =>
  segs.map((s) => ({
    start: new Date(s.start).toISOString(),
    end: new Date(s.end).toISOString(),
    state: s.state,
  }));

// ---- series -------------------------------------------------------------------------------------

export interface Sample {
  at: number;
  online: boolean;
  value: number | null;
}

/** Averages `points` into at most `max` evenly sized time buckets (keeps sparklines light). */
export function downsample(points: Array<[number, number]>, max = MAX_SERIES_POINTS) {
  if (points.length <= max) return points;
  const t0 = points[0]![0];
  const span = points.at(-1)![0] - t0 || 1;
  const sums = new Map<number, { t: number; v: number; n: number }>();
  for (const [t, v] of points) {
    const i = Math.min(max - 1, Math.floor(((t - t0) / span) * max));
    const b = sums.get(i) ?? { t: 0, v: 0, n: 0 };
    b.t += t;
    b.v += v;
    b.n++;
    sums.set(i, b);
  }
  return [...sums.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, b]): [number, number] => [Math.round(b.t / b.n), Math.round((b.v / b.n) * 10) / 10]);
}

export function signalStats(samples: Sample[], weakBelowPct: number): SignalStats {
  // Signal only means something while the timer is reachable.
  const usable = samples
    .filter((s) => s.online && s.value !== null)
    .sort((a, b) => a.at - b.at) as Array<Sample & { value: number }>;
  if (usable.length === 0) {
    return {
      latest: null,
      avg: null,
      min: null,
      weakPct: null,
      weakEpisodes: 0,
      drops: 0,
      series: [],
    };
  }
  let sum = 0;
  let weak = 0;
  let episodes = 0;
  let drops = 0;
  let inWeak = false;
  let prev: (Sample & { value: number }) | null = null;
  for (const s of usable) {
    sum += s.value;
    const isWeak = s.value < weakBelowPct;
    if (isWeak) weak++;
    if (isWeak && !inWeak) episodes++;
    inWeak = isWeak;
    // Compare neighbours only when they are consecutive polls, not either side of an outage.
    if (prev && s.at - prev.at <= GAP_MS && prev.value - s.value >= DROP_POINTS) drops++;
    prev = s;
  }
  return {
    latest: usable.at(-1)!.value,
    avg: Math.round((sum / usable.length) * 10) / 10,
    min: Math.min(...usable.map((s) => s.value)),
    weakPct: Math.round((weak / usable.length) * 1000) / 10,
    weakEpisodes: episodes,
    drops,
    series: downsample(usable.map((s): [number, number] => [s.at, s.value])),
  };
}

// ---- battery ------------------------------------------------------------------------------------

/** A rise this big between two samples is a recharge or new batteries. */
const RECHARGE_JUMP = 10;
const MIN_SPAN_MS = 12 * 60 * MIN;
const MIN_SAMPLES = 5;
/** Slower than this, in points per day, counts as stable. */
const STABLE_PER_DAY = 0.3;

/**
 * Battery level now, drain rate and days left. The drain is a least-squares slope over the samples
 * since the last recharge. LinkTap reports coarse steps, so we need half a day of data first.
 */
export function batteryStats(samples: Array<{ at: number; value: number | null }>): BatteryStats {
  const pts = samples
    .filter((s): s is { at: number; value: number } => s.value !== null)
    .sort((a, b) => a.at - b.at);
  if (pts.length === 0) {
    return { latest: null, drainPctPerDay: null, daysLeft: null, trend: 'unknown', series: [] };
  }
  const latest = pts.at(-1)!.value;
  const series = downsample(pts.map((p): [number, number] => [p.at, p.value]));

  // Only the stretch since the last recharge says anything about the drain rate.
  let start = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i]!.value - pts[i - 1]!.value >= RECHARGE_JUMP) start = i;
  }
  const recent = pts.slice(start);
  const recharged = start > 0;
  const span = recent.at(-1)!.at - recent[0]!.at;
  if (recent.length < MIN_SAMPLES || span < MIN_SPAN_MS) {
    return {
      latest,
      drainPctPerDay: null,
      daysLeft: null,
      trend: recharged ? 'charging' : 'unknown',
      series,
    };
  }

  const slope = slopePerDay(recent);
  const drain = -slope;
  const round1 = (n: number) => Math.round(n * 10) / 10;
  if (Math.abs(drain) < STABLE_PER_DAY || drain < 0) {
    return {
      latest,
      drainPctPerDay: drain > 0 ? round1(drain) : 0,
      daysLeft: null,
      trend: drain < -STABLE_PER_DAY ? 'charging' : 'stable',
      series,
    };
  }
  return {
    latest,
    drainPctPerDay: round1(drain),
    daysLeft: Math.max(0, Math.round(latest / drain)),
    trend: 'draining',
    series,
  };
}

/** Least-squares slope of value against time, in points per day. */
function slopePerDay(pts: Array<{ at: number; value: number }>): number {
  const n = pts.length;
  const t0 = pts[0]!.at;
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  for (const p of pts) {
    const x = (p.at - t0) / DAY;
    sx += x;
    sy += p.value;
    sxy += x * p.value;
    sxx += x * x;
  }
  const denom = n * sxx - sx * sx;
  return denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
}

/** Worst-case freshness of the data we hold. */
export function freshness(lastPollAt: number | null, now: number, gapMs = GAP_MS) {
  const ageMs = lastPollAt === null ? null : Math.max(0, now - lastPollAt);
  return {
    lastPollAt: lastPollAt === null ? null : new Date(lastPollAt).toISOString(),
    ageSec: ageMs === null ? null : Math.round(ageMs / 1000),
    stale: ageMs === null || ageMs > gapMs,
  };
}
