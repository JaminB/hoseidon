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

export function isOn(status: string | null | undefined): boolean {
  return typeof status === 'string' && status.trim().toLowerCase() === 'on';
}

function cleanLocation(value: string | null | undefined): string | null {
  const s = value?.trim();
  return s && s.toLowerCase() !== 'not specified' ? s : null;
}

export function isConnected(status: string | null | undefined): boolean {
  return typeof status === 'string' && status.trim().toLowerCase() === 'connected';
}

/**
 * `remaining`, `total` and `onDuration` are whole MINUTES, with `onDurSec`/`totalSec` as the
 * seconds part. Verified live (2026-11-22): a 1-minute run reported onDuration "1", onDurSec "0",
 * total "1", totalSec "0" and dur "60" (seconds). `onDuration` did not count down during the run,
 * so the remaining time is worked out from `onStamp` + `dur` instead.
 */
export const WATERING_TIME_UNIT_SEC = 60;

/**
 * Whether a status object describes a live run. After a run ends getWateringStatus keeps
 * answering `{ dur: "60" }`, which is idle: only run fields (onStamp, onDuration, remaining,
 * total) mean watering.
 */
export function isWateringStatus(raw: RawWatering | null | undefined): raw is RawWatering {
  if (!raw) return false;
  return [raw.onStamp, raw.onDuration, raw.remaining, raw.total].some((v) => toNumber(v) !== null);
}

function minutesAndSeconds(min: unknown, sec: unknown): number | null {
  const m = toNumber(min);
  if (m === null) return null;
  return Math.round(m * WATERING_TIME_UNIT_SEC + (toNumber(sec) ?? 0));
}

/**
 * A watering report (getWateringStatus `status`, or getAllDevices `watering`) in seconds.
 * - total = `dur` (seconds), else total min + totalSec.
 * - remaining = onStamp + total - now, clamped to [0, total]; without onStamp, the old
 *   `remaining`/`onDuration` minutes.
 * - The live status sends `vol: "0"` throughout a run, so a zero volume alongside onStamp is
 *   unknown (history has the real figure).
 */
export function normalizeWatering(
  raw: RawWatering | null | undefined,
  now: number = Date.now(),
): Watering | null {
  if (!isWateringStatus(raw)) return null;
  const dur = toNumber(raw.dur);
  const totalSec =
    dur !== null && dur > 0 ? Math.round(dur) : minutesAndSeconds(raw.total, raw.totalSec);
  const onStamp = toNumber(raw.onStamp);
  let remainingSec: number | null;
  if (onStamp !== null && onStamp > 0 && totalSec !== null) {
    const left = Math.round((onStamp + totalSec * 1000 - now) / 1000);
    remainingSec = Math.min(totalSec, Math.max(0, left));
  } else if (raw.remaining != null) {
    remainingSec = minutesAndSeconds(raw.remaining, null);
  } else {
    remainingSec = minutesAndSeconds(raw.onDuration, raw.onDurSec);
  }
  const vol = toNumber(raw.vol);
  return {
    remainingSec,
    totalSec,
    flowMlPerMin: toNumber(raw.vel),
    volumeMl: onStamp !== null && vol === 0 ? null : vol,
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
  /** Raw LinkTap device type (16 = 4-outlet ValveLinker). */
  dType: number | null;
  /** flowMeterStatus === "on"; null when the field is absent. */
  flowMeter: boolean | null;
  /** Top-level `vel` (ml/min): last/current flow, reported even when idle. */
  flowMlPerMin: number | null;
  /** Last instant-mode plan LinkTap reports. */
  plan: Record<string, unknown> | null;
  alarms: AlarmFlag[];
  raw: RawTaplinker;
}

export interface NormalizedGateway {
  id: string;
  name: string;
  status: string | null;
  online: boolean;
  /** Firmware version string. */
  version: string | null;
  /** Raw location string (Google Plus Code + locality), null when blank/"Not specified". */
  location: string | null;
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
    dType: toNumber(raw.dType),
    flowMeter: typeof raw.flowMeterStatus === 'string' ? isOn(raw.flowMeterStatus) : null,
    flowMlPerMin: toNumber(raw.vel) ?? toNumber(raw.watering?.vel),
    plan: raw.plan ?? null,
    // The live API calls the fall alarm `fall`; older docs say `fallFlag`. pcFlag/pbFlag are
    // only sent by some firmware, so absent means not raised.
    alarms: ALARM_FLAGS.filter(
      (flag) => toFlag(raw[flag]) || (flag === 'fallFlag' && toFlag(raw.fall)),
    ),
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
    version: raw.version?.trim() || null,
    location: cleanLocation(raw.location),
    taplinkers: (taplinker ?? []).map((t) => normalizeTaplinker(t, id)),
    raw: rest,
  };
}

// ---- History ------------------------------------------------------------------------------------

export interface HistoryEntry {
  /** End time minus duration. */
  startedAt: Date;
  /** The record's timestamp is when the run ENDED. */
  endedAt: Date;
  durationSec: number;
  volumeMl: number | null;
  /** LinkTap work mode (`cm`), e.g. "M"; null when absent. */
  mode: string | null;
}

/** createdAt is trusted for the end time only when it agrees with the local time this closely. */
export const CREATED_AT_TOLERANCE_MS = 120_000;

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
 * History records are { Y: "YYYYMMDD", H, M, ss, D: minutes, S: seconds, vol: ml, cm?, createdAt }.
 * The date/time is when the run ENDED, in the gateway's local time. `createdAt` (ISO UTC) is
 * more precise but is sometimes batched in days after the event, so it is used only when it is
 * within two minutes of the local time. Runs with no duration are dropped. Malformed records
 * are dropped too.
 */
export function normalizeHistory(entries: RawHistoryEntry[], timeZone: string): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const e of entries) {
    const ymd = String(e.Y);
    if (!/^\d{8}$/.test(ymd)) continue;
    const y = Number(ymd.slice(0, 4));
    const mo = Number(ymd.slice(4, 6));
    const d = Number(ymd.slice(6, 8));
    // Date.UTC silently rolls Feb 30 into March; reject dates that don't round-trip.
    const check = new Date(Date.UTC(y, mo - 1, d));
    if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) continue;
    const localEnd = zonedTimeToDate(
      y,
      mo,
      d,
      toNumber(e.H) ?? 0,
      toNumber(e.M) ?? 0,
      toNumber(e.ss) ?? 0,
      timeZone,
    );
    if (Number.isNaN(localEnd.getTime())) continue;
    const durationSec = (toNumber(e.D) ?? 0) * 60 + (toNumber(e.S) ?? 0);
    if (durationSec <= 0) continue;
    let endedAt = localEnd;
    if (e.createdAt) {
      const created = new Date(e.createdAt);
      if (
        !Number.isNaN(created.getTime()) &&
        Math.abs(created.getTime() - localEnd.getTime()) <= CREATED_AT_TOLERANCE_MS
      ) {
        endedAt = created;
      }
    }
    out.push({
      startedAt: new Date(endedAt.getTime() - durationSec * 1000),
      endedAt,
      durationSec,
      volumeMl: toNumber(e.vol),
      mode: e.cm?.trim() || null,
    });
  }
  return out.sort((a, b) => a.endedAt.getTime() - b.endedAt.getTime());
}

/** Split a duration in seconds into LinkTap's (minutes, seconds) pair for activateInstantMode. */
export function splitDuration(seconds: number): { duration: number; durationSec: number } {
  const total = Math.max(0, Math.round(seconds));
  return { duration: Math.floor(total / 60), durationSec: total % 60 };
}
