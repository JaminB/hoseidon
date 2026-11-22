import type { Device, Gateway, HoseidonEvent, Run, Snapshot } from '@hoseidon/shared';
import type { DeviceRow, EventRow, GatewayRow, RunRow, SnapshotRow } from '../db/schema';

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
