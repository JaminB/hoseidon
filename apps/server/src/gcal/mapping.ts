import { createHash } from 'node:crypto';
import type { PlannedRunRow, RunRow, ScheduleRow } from '../db/schema';
import { planOccurrence } from '../schedule/plan';
import { fromWall, parseLocal, toWall } from '../schedule/time';
import type { GEvent } from './calendar';

/**
 * Pure Hoseidon -> Google Calendar mapping. Everything here is deterministic, so a hash of the
 * result tells the sync whether Google needs an update.
 */

export const FOOTER =
  'Managed by Hoseidon 🔱. Edits made here are overwritten; change the schedule in Hoseidon.';

export interface MapContext {
  deviceName: (id: string) => string;
  gatewayOf: (id: string) => string | null;
  /** Executor rounding (LinkTap runs whole minutes). */
  quantize: (seconds: number, deviceId: string) => number;
}

// ---- RRULE --------------------------------------------------------------------------------------

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function basicUtc(d: Date): string {
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/**
 * Our RRULE bodies are read in floating wall time (UNTIL included, see schedule/occurrences.ts).
 * Google reads them against DTSTART's time zone, which is the same except for UNTIL: RFC 5545
 * wants a UTC UNTIL when DTSTART has a TZID. Convert it the same way the engine reads it, so both
 * stop at the same occurrence.
 */
export function toGoogleRrule(rrule: string, timeZone: string): string {
  const parts = rrule
    .replace(/^RRULE:/i, '')
    .split(';')
    .filter(Boolean)
    .map((part) => {
      const [rawKey, value = ''] = part.split('=');
      const key = (rawKey ?? '').toUpperCase();
      if (key !== 'UNTIL') return `${key}=${value.toUpperCase()}`;
      const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?Z?$/i.exec(value);
      if (!m) return `UNTIL=${value}`;
      const [y, mo, d, h = '0', mi = '0', s = '0'] = m.slice(1);
      const wall = new Date(Date.UTC(+y!, +mo! - 1, +d!, +h, +mi, +s));
      return `UNTIL=${basicUtc(fromWall(wall, timeZone))}`;
    });
  return `RRULE:${parts.join(';')}`;
}

// ---- colors -------------------------------------------------------------------------------------

/** Google Calendar's fixed event palette (colorId -> hex). */
export const GOOGLE_EVENT_COLORS: Record<string, string> = {
  '1': '#7986cb',
  '2': '#33b679',
  '3': '#8e24aa',
  '4': '#e67c73',
  '5': '#f6bf26',
  '6': '#f4511e',
  '7': '#039be5',
  '8': '#616161',
  '9': '#3f51b5',
  '10': '#0b8043',
  '11': '#d50000',
};
export const SKIPPED_COLOR_ID = '8';

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as number[];

/** Closest Google event color to a schedule's hex, by (weighted) RGB distance. */
export function nearestColorId(hex: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return '7';
  const [r, g, b] = rgb(hex) as [number, number, number];
  let best = '7';
  let bestD = Infinity;
  for (const [id, c] of Object.entries(GOOGLE_EVENT_COLORS)) {
    if (id === SKIPPED_COLOR_ID) continue;
    const [cr, cg, cb] = rgb(c) as [number, number, number];
    const d = 2 * (r - cr) ** 2 + 4 * (g - cg) ** 2 + 3 * (b - cb) ** 2;
    if (d < bestD) [best, bestD] = [id, d];
  }
  return best;
}

// ---- text ---------------------------------------------------------------------------------------

export function minutes(sec: number): string {
  const m = Math.max(0, Math.round(sec / 60));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

const liters = (ml: number) => `${Math.round(ml / 100) / 10} L`;

/**
 * Floating wall "YYYY-MM-DDTHH:mm:ss" for Google's dateTime + timeZone pair. Only for recurring
 * series, which need wall time; one-off logs send UTC instants so a repeated DST hour stays exact.
 */
const wallString = (instant: Date, timeZone: string) =>
  toWall(instant, timeZone).toISOString().slice(0, 19);

function skipRulesText(s: ScheduleRow): string | null {
  const r = s.skipRules;
  const out: string[] = [];
  if (r.rainForecastMm !== null) out.push(`rain over ${r.rainForecastMm} mm`);
  if (r.freezeC !== null) out.push(`at or below ${r.freezeC} °C`);
  if (r.windKph !== null) out.push(`wind ${r.windKph} km/h or more`);
  const lines = out.length ? [`Skips on ${out.join(', ')}.`] : [];
  if (r.etScaling) lines.push(`Scales with evapotranspiration (${r.minScale}× to ${r.maxScale}×).`);
  return lines.length ? lines.join(' ') : null;
}

// ---- schedules ----------------------------------------------------------------------------------

/** The occurrence length the planner expects: every zone and cycle, soaks included. */
export function occurrenceSeconds(s: ScheduleRow, at: Date, ctx: MapContext): number {
  const slots = planOccurrence({
    items: s.items,
    cycleSoak: s.cycleSoak ?? null,
    sequential: s.sequential,
    occurrenceAt: at,
    gatewayOf: ctx.gatewayOf,
    quantize: ctx.quantize,
  });
  const end = Math.max(at.getTime(), ...slots.map((x) => x.end.getTime()));
  return Math.max(60, Math.round((end - at.getTime()) / 1000));
}

export function scheduleDescription(s: ScheduleRow, ctx: MapContext): string {
  const cycles = s.cycleSoak?.cycles ?? 1;
  const zones = s.items.map((item) => {
    const split =
      cycles > 1
        ? ` (${cycles} × ${minutes(item.seconds / cycles)}, ${s.cycleSoak?.soakMinutes ?? 0} min soak)`
        : '';
    return `• ${ctx.deviceName(item.deviceId)}: ${minutes(item.seconds)}${split}`;
  });
  const lines = [...zones, ''];
  if (s.items.length > 1)
    lines.push(s.sequential ? 'Zones run one at a time.' : 'Zones run at the same time.');
  const rules = skipRulesText(s);
  if (rules) lines.push(rules);
  lines.push('', FOOTER);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

export function scheduleEvent(s: ScheduleRow, ctx: MapContext): GEvent {
  const first = fromWall(parseLocal(s.dtstart), s.timezone);
  const end = new Date(first.getTime() + occurrenceSeconds(s, first, ctx) * 1000);
  return {
    status: 'confirmed',
    summary: `💧 ${s.name}`,
    description: scheduleDescription(s, ctx),
    start: { dateTime: `${s.dtstart}:00`, timeZone: s.timezone },
    end: { dateTime: wallString(end, s.timezone), timeZone: s.timezone },
    recurrence: [toGoogleRrule(s.rrule, s.timezone)],
    colorId: nearestColorId(s.color),
    // Watering shouldn't make you look busy or ping your phone.
    transparency: 'transparent',
    reminders: { useDefault: false },
    extendedProperties: {
      private: { hoseidonScheduleId: String(s.id), hoseidonKind: 'schedule' },
    },
  };
}

// ---- skipped occurrences ------------------------------------------------------------------------

/**
 * How one occurrence's instance is annotated when some or all of its runs were skipped. Null when
 * nothing was skipped. Applied to the instance as an exception, so the series is untouched.
 */
export function skipOverlay(
  s: ScheduleRow,
  runs: Pick<PlannedRunRow, 'deviceId' | 'status' | 'skipReason'>[],
  ctx: MapContext,
): Pick<GEvent, 'summary' | 'description' | 'colorId'> | null {
  const skipped = runs.filter((r) => r.status === 'skipped');
  if (!skipped.length) return null;
  const all = skipped.length === runs.length;
  const byReason = new Map<string, Set<string>>();
  for (const r of skipped) {
    const reason = r.skipReason ?? 'Skipped';
    byReason.set(reason, (byReason.get(reason) ?? new Set()).add(ctx.deviceName(r.deviceId)));
  }
  const lines = [...byReason].map(([reason, names]) => `⏭ ${[...names].join(', ')}: ${reason}`);
  return {
    summary: all ? `⏭ ${s.name} (skipped)` : `💧 ${s.name} (partly skipped)`,
    description: [...lines, '', scheduleDescription(s, ctx)].join('\n'),
    colorId: all ? SKIPPED_COLOR_ID : nearestColorId(s.color),
  };
}

// ---- run log ------------------------------------------------------------------------------------

type LogRun = Pick<
  RunRow,
  'id' | 'deviceId' | 'startedAt' | 'endedAt' | 'durationSec' | 'volumeMl'
>;

const ranSec = (r: LogRun) =>
  r.durationSec ??
  Math.round(((r.endedAt?.getTime() ?? r.startedAt.getTime()) - r.startedAt.getTime()) / 1000);

/** One past event for a finished schedule occurrence that actually watered. */
export function occurrenceLogEvent(
  s: Pick<ScheduleRow, 'id' | 'name' | 'color' | 'timezone'>,
  planned: Pick<PlannedRunRow, 'deviceId' | 'status' | 'skipReason' | 'error' | 'runId'>[],
  runs: LogRun[],
  ctx: Pick<MapContext, 'deviceName'>,
): GEvent | null {
  const ran = runs.filter((r) => r.endedAt);
  if (!ran.length) return null;
  const start = new Date(Math.min(...ran.map((r) => r.startedAt.getTime())));
  const end = new Date(Math.max(...ran.map((r) => r.endedAt!.getTime())));
  const total = ran.reduce((sum, r) => sum + ranSec(r), 0);

  const perDevice = new Map<string, { sec: number; ml: number | null }>();
  for (const r of ran) {
    const cur = perDevice.get(r.deviceId) ?? { sec: 0, ml: null };
    cur.sec += ranSec(r);
    if (r.volumeMl !== null) cur.ml = (cur.ml ?? 0) + r.volumeMl;
    perDevice.set(r.deviceId, cur);
  }
  const lines = [...perDevice].map(
    ([id, v]) =>
      `✓ ${ctx.deviceName(id)}: ${minutes(v.sec)}${v.ml !== null ? `, ${liters(v.ml)}` : ''}`,
  );
  const watered = new Set(perDevice.keys());
  for (const p of planned) {
    if (watered.has(p.deviceId)) continue;
    if (p.status === 'skipped')
      lines.push(`⏭ ${ctx.deviceName(p.deviceId)}: ${p.skipReason ?? 'skipped'}`);
    if (p.status === 'failed')
      lines.push(`✗ ${ctx.deviceName(p.deviceId)}: ${p.error ?? 'failed'}`);
  }
  return {
    status: 'confirmed',
    summary: `✓ ${s.name} · ${minutes(total)}`,
    description: [...new Set(lines), '', 'Logged by Hoseidon 🔱.'].join('\n'),
    start: { dateTime: start.toISOString(), timeZone: s.timezone },
    end: {
      dateTime: (end > start ? end : new Date(start.getTime() + 60_000)).toISOString(),
      timeZone: s.timezone,
    },
    colorId: nearestColorId(s.color),
    transparency: 'transparent',
    reminders: { useDefault: false },
    extendedProperties: {
      private: { hoseidonScheduleId: String(s.id), hoseidonKind: 'log' },
    },
  };
}

/** A past event for a run Hoseidon didn't schedule (manual or LinkTap app/plan). */
export function runLogEvent(
  r: LogRun & Pick<RunRow, 'source'>,
  timeZone: string,
  ctx: Pick<MapContext, 'deviceName'>,
): GEvent | null {
  if (!r.endedAt) return null;
  const end = r.endedAt > r.startedAt ? r.endedAt : new Date(r.startedAt.getTime() + 60_000);
  const origin = r.source === 'linktap' ? 'Started by LinkTap (app or plan).' : 'Started by hand.';
  return {
    status: 'confirmed',
    summary: `✓ ${ctx.deviceName(r.deviceId)} · ${minutes(ranSec(r))}`,
    description: [
      origin,
      ...(r.volumeMl !== null ? [`Used ${liters(r.volumeMl)}.`] : []),
      '',
      'Logged by Hoseidon 🔱.',
    ].join('\n'),
    start: { dateTime: r.startedAt.toISOString(), timeZone },
    end: { dateTime: end.toISOString(), timeZone },
    colorId: SKIPPED_COLOR_ID,
    transparency: 'transparent',
    reminders: { useDefault: false },
    extendedProperties: { private: { hoseidonRunId: String(r.id), hoseidonKind: 'log' } },
  };
}

/** Stable short hash of what we'd send. Keys are built in a fixed order, so JSON is stable. */
export const hashOf = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('base64url').slice(0, 22);
