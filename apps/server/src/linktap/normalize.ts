import {
  alarmFlagSchema,
  parsePercent,
  workModeSchema,
  type AlarmFlag,
  type Watering,
  type WorkMode,
} from '@hoseidon/shared';
import type { RawGateway, RawHistoryEntry, RawTaplinker, RawWatering } from './schemas';

export { parsePercent };

// ---- IDs ----------------------------------------------------------------------------------------

/**
 * LinkTap IDs are 16 hex chars. Multi-outlet ValveLinkers expose one "taplinker" per outlet with
 * an 18-char id: the 16-char device id plus "_<outlet>".
 */
export function baseId(id: string): string {
  return id.trim().slice(0, 16);
}

/** Gateway ids must be exactly the first 16 chars (some UIs show a longer string). */
export const gatewayIdOf = baseId;

/** "ABCD..._2" -> 2; plain 16-char ids -> null. */
export function outletOf(taplinkerId: string): number | null {
  const m = /_(\d+)$/.exec(taplinkerId.trim());
  return m ? Number(m[1]) : null;
}

export function isMultiOutlet(taplinkerId: string): boolean {
  return outletOf(taplinkerId) !== null;
}

// ---- Scalars ------------------------------------------------------------------------------------

export function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Flags arrive as booleans, 0/1, or "true"/"false". */
export function toFlag(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value === 'true' || value === '1';
  return false;
}

export function toWorkMode(value: unknown): WorkMode | null {
  const parsed = workModeSchema.safeParse(typeof value === 'string' ? value.trim() : value);
  return parsed.success ? parsed.data : null;
}

/** Work modes that mean a LinkTap-app plan is in charge (risk of double watering). */
export function isPlanMode(mode: WorkMode | null): boolean {
  return mode !== null && mode !== 'M' && mode !== 'N';
}

export function isConnected(status: string | null | undefined): boolean {
  return typeof status === 'string' && status.trim().toLowerCase() === 'connected';
}

/**
 * Watering durations (`remaining`, `total`, `onDuration`) are reported in minutes as far as the
 * community integrations show. UNVERIFIED: confirm during the live smoke test and change here.
 */
export const WATERING_TIME_UNIT_SEC = 60;

export function normalizeWatering(raw: RawWatering | null | undefined): Watering | null {
  if (!raw) return null;
  const toSec = (v: unknown) => {
    const n = toNumber(v);
    return n === null ? null : Math.round(n * WATERING_TIME_UNIT_SEC);
  };
  return {
    remainingSec: toSec(raw.remaining ?? raw.onDuration),
    totalSec: toSec(raw.total),
    flowMlPerMin: toNumber(raw.vel),
    volumeMl: toNumber(raw.vol),
  };
}

// ---- Devices ------------------------------------------------------------------------------------

export interface NormalizedTaplinker {
  id: string;
  gatewayId: string;
  outlet: number | null;
  name: string;
  status: string | null;
  online: boolean;
  batteryPct: number | null;
  signalPct: number | null;
  workMode: WorkMode | null;
  watering: Watering | null;
  alarms: AlarmFlag[];
  raw: RawTaplinker;
}

export interface NormalizedGateway {
  id: string;
  name: string;
  status: string | null;
  online: boolean;
  taplinkers: NormalizedTaplinker[];
  raw: Omit<RawGateway, 'taplinker'>;
}

const ALARM_FLAGS = alarmFlagSchema.options;

export function normalizeTaplinker(raw: RawTaplinker, gatewayId: string): NormalizedTaplinker {
  const id = raw.taplinkerId.trim();
  return {
    id,
    gatewayId: gatewayIdOf(gatewayId),
    outlet: outletOf(id),
    name: raw.taplinkerName?.trim() || id,
    status: raw.status ?? null,
    online: isConnected(raw.status),
    batteryPct: parsePercent(raw.batteryStatus),
    signalPct: parsePercent(raw.signal),
    workMode: toWorkMode(raw.workMode),
    watering: normalizeWatering(raw.watering),
    alarms: ALARM_FLAGS.filter((flag) => toFlag(raw[flag])),
    raw,
  };
}

export function normalizeGateway(raw: RawGateway): NormalizedGateway {
  const { taplinker, ...rest } = raw;
  const id = gatewayIdOf(raw.gatewayId);
  return {
    id,
    name: raw.name?.trim() || id,
    status: raw.status ?? null,
    online: isConnected(raw.status),
    taplinkers: (taplinker ?? []).map((t) => normalizeTaplinker(t, id)),
    raw: rest,
  };
}

// ---- History ------------------------------------------------------------------------------------

export interface HistoryEntry {
  startedAt: Date;
  durationSec: number;
  volumeMl: number | null;
}

/** Offset (ms) of `timeZone` from UTC at instant `ms`. */
function tzOffsetMs(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Wall-clock time in `timeZone` -> UTC Date. Handles DST by re-checking the offset once. */
export function zonedTimeToDate(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let result = guess - tzOffsetMs(guess, timeZone);
  const second = guess - tzOffsetMs(result, timeZone);
  if (second !== result) result = second;
  return new Date(result);
}

/**
 * History records are { Y: "YYYYMMDD", H, M, ss, D: minutes, S: seconds, vol: ml } in the
 * gateway's local time. Malformed records are dropped.
 */
export function normalizeHistory(entries: RawHistoryEntry[], timeZone: string): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const e of entries) {
    const ymd = String(e.Y);
    if (!/^\d{8}$/.test(ymd)) continue;
    const y = Number(ymd.slice(0, 4));
    const mo = Number(ymd.slice(4, 6));
    const d = Number(ymd.slice(6, 8));
    const startedAt = zonedTimeToDate(
      y,
      mo,
      d,
      toNumber(e.H) ?? 0,
      toNumber(e.M) ?? 0,
      toNumber(e.ss) ?? 0,
      timeZone,
    );
    if (Number.isNaN(startedAt.getTime())) continue;
    const durationSec = (toNumber(e.D) ?? 0) * 60 + (toNumber(e.S) ?? 0);
    out.push({ startedAt, durationSec, volumeMl: toNumber(e.vol) });
  }
  return out.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
}

/** Split a duration in seconds into LinkTap's (minutes, seconds) pair for activateInstantMode. */
export function splitDuration(seconds: number): { duration: number; durationSec: number } {
  const total = Math.max(0, Math.round(seconds));
  return { duration: Math.floor(total / 60), durationSec: total % 60 };
}
