import type { CycleSoak, ScheduleItem } from '@hoseidon/shared';

export interface PlanSlot {
  deviceId: string;
  gatewayId: string | null;
  /** Index of the item in the schedule. */
  seq: number;
  /** 1-based cycle number. */
  cycle: number;
  /** Per-cycle seconds before scaling. */
  baseSeconds: number;
  /** Per-cycle seconds after scaling and quantizing. */
  seconds: number;
  start: Date;
  end: Date;
}

export interface PlanInput {
  items: ScheduleItem[];
  cycleSoak: CycleSoak | null;
  sequential: boolean;
  occurrenceAt: Date;
  gatewayOf: (deviceId: string) => string | null;
  /** Executor rounding (LinkTap minutes). Default: identity. */
  quantize?: (seconds: number, deviceId: string) => number;
  scale?: number;
}

/** Runs that must not overlap share a lane: the gateway when sequential, else the device. */
export function laneOf(s: { sequential: boolean; gatewayId: string | null; deviceId: string }) {
  return s.sequential && s.gatewayId ? `gw:${s.gatewayId}` : `dev:${s.deviceId}`;
}

/** Order the engine works through slots in a lane: cycle by cycle, zones in schedule order. */
export const slotOrder = (a: { cycle: number; seq: number }, b: { cycle: number; seq: number }) =>
  a.cycle - b.cycle || a.seq - b.seq;

/**
 * Lay out one occurrence: each zone's time is split into cycles; zones in a lane go one after
 * another, and a zone's next cycle waits for its soak. Times are estimates the engine refines as
 * real runs finish.
 */
export function planOccurrence(input: PlanInput): PlanSlot[] {
  const cycles = input.cycleSoak?.cycles ?? 1;
  const soakMs = (input.cycleSoak?.soakMinutes ?? 0) * 60_000;
  const quantize = input.quantize ?? ((s: number) => s);
  const scale = input.scale ?? 1;

  const slots: Omit<PlanSlot, 'start' | 'end'>[] = [];
  for (let cycle = 1; cycle <= cycles; cycle++) {
    input.items.forEach((item, seq) => {
      const baseSeconds = Math.round(item.seconds / cycles);
      slots.push({
        deviceId: item.deviceId,
        gatewayId: input.gatewayOf(item.deviceId),
        seq,
        cycle,
        baseSeconds,
        seconds: quantize(baseSeconds * scale, item.deviceId),
      });
    });
  }
  slots.sort(slotOrder);

  const laneFree = new Map<string, number>();
  const itemEnd = new Map<number, number>();
  const t0 = input.occurrenceAt.getTime();
  return slots.map((slot) => {
    const lane = laneOf({ ...slot, sequential: input.sequential });
    const prevEnd = itemEnd.get(slot.seq);
    const start = Math.max(laneFree.get(lane) ?? t0, prevEnd === undefined ? t0 : prevEnd + soakMs);
    const end = start + slot.seconds * 1000;
    laneFree.set(lane, end);
    itemEnd.set(slot.seq, end);
    return { ...slot, start: new Date(start), end: new Date(end) };
  });
}
