import type {
  Device,
  Gateway,
  HoseidonEvent,
  PlannedRun,
  Run,
  Schedule,
  ScheduleWarning,
  Snapshot,
} from '@hoseidon/shared';
import type {
  DeviceRow,
  EventRow,
  GatewayRow,
  PlannedRunRow,
  RunRow,
  ScheduleRow,
  SnapshotRow,
} from '../db/schema';

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toGateway(row: GatewayRow): Gateway {
  return {
    id: row.id,
    name: row.name ?? row.linktapName,
    linktapName: row.linktapName,
    online: row.online,
    status: row.status,
    lat: row.lat,
    lon: row.lon,
    timezone: row.timezone,
    lastSeenAt: iso(row.lastSeenAt),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toDevice(row: DeviceRow): Device {
  return {
    id: row.id,
    gatewayId: row.gatewayId,
    outlet: row.outlet,
    name: row.name ?? row.linktapName,
    linktapName: row.linktapName,
    zone: row.zone,
    online: row.online,
    status: row.status,
    batteryPct: row.batteryPct,
    signalPct: row.signalPct,
    workMode: row.workMode,
    alarms: row.alarms,
    watering: row.watering ?? null,
    lastSeenAt: iso(row.lastSeenAt),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toSnapshot(row: SnapshotRow): Snapshot {
  return {
    at: row.at.toISOString(),
    online: row.online,
    batteryPct: row.batteryPct,
    signalPct: row.signalPct,
    workMode: row.workMode,
    watering: row.watering,
    alarms: row.alarms,
  };
}

export function toRun(row: RunRow): Run {
  return {
    id: row.id,
    deviceId: row.deviceId,
    startedAt: row.startedAt.toISOString(),
    endedAt: iso(row.endedAt),
    plannedSec: row.plannedSec,
    durationSec: row.durationSec,
    volumeMl: row.volumeMl,
    source: row.source,
    scheduleId: row.scheduleId,
    status: row.status,
    note: row.note,
  };
}

export function toEvent(row: EventRow): HoseidonEvent {
  return {
    id: row.id,
    at: row.at.toISOString(),
    type: row.type,
    source: row.source,
    severity: row.severity,
    gatewayId: row.gatewayId,
    deviceId: row.deviceId,
    title: row.title,
    message: row.message,
  };
}

export function toSchedule(
  row: ScheduleRow,
  extra: { nextAt: Date | null; warnings: ScheduleWarning[] },
): Schedule {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    rrule: row.rrule,
    dtstart: row.dtstart,
    timezone: row.timezone,
    enabled: row.enabled,
    items: row.items,
    cycleSoak: row.cycleSoak ?? null,
    sequential: row.sequential,
    skipRules: row.skipRules,
    gcalEventId: row.gcalEventId,
    nextAt: iso(extra.nextAt),
    warnings: extra.warnings,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toPlannedRun(row: PlannedRunRow): PlannedRun {
  return {
    id: row.id,
    scheduleId: row.scheduleId,
    deviceId: row.deviceId,
    gatewayId: row.gatewayId,
    occurrenceAt: row.occurrenceAt.toISOString(),
    seq: row.seq,
    cycle: row.cycle,
    plannedAt: row.plannedAt.toISOString(),
    seconds: row.seconds,
    baseSeconds: row.baseSeconds,
    scale: row.scale,
    status: row.status,
    skipReason: row.skipReason,
    error: row.error,
    runId: row.runId,
    startedAt: iso(row.startedAt),
    endedAt: iso(row.endedAt),
  };
}
