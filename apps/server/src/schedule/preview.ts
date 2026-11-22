import type { PreviewOccurrence, ScheduleWarning, WorkMode } from '@hoseidon/shared';
import type { DeviceRow, ScheduleRow } from '../db/schema';
import { expandOccurrences } from './occurrences';
import { planOccurrence } from './plan';

type DeviceInfo = Pick<
  DeviceRow,
  'id' | 'gatewayId' | 'name' | 'linktapName' | 'online' | 'workMode'
>;

const PLAN_MODES: Partial<Record<WorkMode, string>> = {
  I: 'interval',
  T: '7-day',
  O: 'odd-even',
  Y: 'monthly',
  D: 'calendar',
};

/** Things that make a schedule misbehave: LinkTap-app plans (double watering), gone or offline devices. */
export function scheduleWarnings(
  s: Pick<ScheduleRow, 'items'>,
  devices: Map<string, DeviceInfo>,
): ScheduleWarning[] {
  const out: ScheduleWarning[] = [];
  for (const { deviceId } of s.items) {
    const d = devices.get(deviceId);
    if (!d) {
      out.push({
        kind: 'unknown_device',
        deviceId,
        message: `Device ${deviceId} no longer exists.`,
      });
      continue;
    }
    const name = d.name ?? d.linktapName;
    const plan = d.workMode ? PLAN_MODES[d.workMode] : undefined;
    if (plan) {
      out.push({
        kind: 'linktap_plan',
        deviceId,
        message: `${name} still has a LinkTap ${plan} plan active, so it may water twice. Switch it to manual in the LinkTap app.`,
      });
    }
    if (!d.online) out.push({ kind: 'offline_device', deviceId, message: `${name} is offline.` });
  }
  return out;
}

/** Occurrences (with per-zone slots) for a calendar view, plus overlaps on shared gateways. */
export function previewOccurrences(
  list: ScheduleRow[],
  devices: Map<string, DeviceInfo>,
  from: Date,
  to: Date,
  quantize: (seconds: number, deviceId: string) => number,
): PreviewOccurrence[] {
  const out: PreviewOccurrence[] = [];
  for (const s of list) {
    let occurrences: Date[];
    try {
      occurrences = expandOccurrences(s, from, to, 500);
    } catch {
      continue;
    }
    for (const occurrenceAt of occurrences) {
      const slots = planOccurrence({
        items: s.items,
        cycleSoak: s.cycleSoak,
        sequential: s.sequential,
        occurrenceAt,
        gatewayOf: (id) => devices.get(id)?.gatewayId ?? null,
        quantize,
      });
      const end = Math.max(occurrenceAt.getTime(), ...slots.map((x) => x.end.getTime()));
      out.push({
        scheduleId: s.id,
        name: s.name,
        color: s.color,
        start: occurrenceAt.toISOString(),
        end: new Date(end).toISOString(),
        slots: slots.map((x) => ({
          deviceId: x.deviceId,
          gatewayId: x.gatewayId,
          seq: x.seq,
          cycle: x.cycle,
          start: x.start.toISOString(),
          end: x.end.toISOString(),
          seconds: x.seconds,
        })),
        overlapsWith: [],
      });
    }
  }
  out.sort((a, b) => a.start.localeCompare(b.start));
  const gatewaysOf = (o: PreviewOccurrence) =>
    new Set(o.slots.flatMap((x) => (x.gatewayId ? [x.gatewayId] : [])));
  // Sorted by start, so only later items that start before this one ends can overlap.
  for (let i = 0; i < out.length; i++) {
    const a = out[i]!;
    const aGateways = gatewaysOf(a);
    for (let j = i + 1; j < out.length && out[j]!.start < a.end; j++) {
      const b = out[j]!;
      if (a.scheduleId === b.scheduleId) continue;
      if (![...gatewaysOf(b)].some((g) => aGateways.has(g))) continue;
      if (!a.overlapsWith.includes(b.scheduleId)) a.overlapsWith.push(b.scheduleId);
      if (!b.overlapsWith.includes(a.scheduleId)) b.overlapsWith.push(a.scheduleId);
    }
  }
  return out;
}
