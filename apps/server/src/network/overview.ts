import { and, gte, like, or } from 'drizzle-orm';
import type {
  DeviceNetwork,
  EventSource,
  GatewayNetwork,
  Incident,
  IncidentSource,
} from '@hoseidon/shared';
import type { Db } from '../db/types';
import { deviceSnapshots, devices, events, gateways } from '../db/schema';
import { baseId } from '../linktap/normalize';
import {
  batteryStats,
  buildTimeline,
  signalStats,
  toSegments,
  type Timeline,
  type Transition,
} from './metrics';

const DAY = 86_400_000;
/** Battery drain needs a longer view than the timeline does. */
const BATTERY_DAYS = 14;
/** Events this far before the window still tell us the state when it opened. */
const LOOKBACK_DAYS = 30;

const sourceOf = (s: EventSource): IncidentSource => (s === 'webhook' ? 'webhook' : 'poll');

interface Classified {
  scope: 'gateway' | 'device';
  online: boolean;
}

/** Reads an event as an online/offline transition, or null. Webhook names are matched loosely. */
export function classifyTransition(type: string): Classified | null {
  const t = type.toLowerCase();
  if (t === 'gateway.offline' || t === 'gateway.online') {
    return { scope: 'gateway', online: t.endsWith('online') && !t.endsWith('offline') };
  }
  if (t === 'device.offline' || t === 'device.online') {
    return { scope: 'device', online: !t.endsWith('offline') };
  }
  if (t.startsWith('linktap.') && /offline|online/.test(t)) {
    return { scope: t.includes('gateway') ? 'gateway' : 'device', online: !/offline/.test(t) };
  }
  return null;
}

export interface NetworkSnapshot {
  gateways: GatewayNetwork[];
  incidents: Incident[];
  lastPollAt: number | null;
}

/**
 * Derives uptime timelines, signal and battery stats and offline incidents for every gateway and
 * timer from device_snapshots and the event log.
 */
export function buildNetwork(
  db: Db,
  { now, days, weakSignalPct }: { now: number; days: number; weakSignalPct: number },
): NetworkSnapshot {
  const from = now - days * DAY;
  const gws = db.select().from(gateways).all();
  const devs = db.select().from(devices).all();

  const snaps = db
    .select({
      deviceId: deviceSnapshots.deviceId,
      at: deviceSnapshots.at,
      online: deviceSnapshots.online,
      batteryPct: deviceSnapshots.batteryPct,
      signalPct: deviceSnapshots.signalPct,
    })
    .from(deviceSnapshots)
    .where(gte(deviceSnapshots.at, new Date(now - Math.max(days, BATTERY_DAYS) * DAY)))
    .all();
  const snapsBy = new Map<string, typeof snaps>();
  let lastPollAt: number | null = null;
  for (const s of snaps) {
    const list = snapsBy.get(s.deviceId) ?? [];
    list.push(s);
    snapsBy.set(s.deviceId, list);
    const at = s.at.getTime();
    if (lastPollAt === null || at > lastPollAt) lastPollAt = at;
  }

  const evs = db
    .select()
    .from(events)
    .where(
      and(
        gte(events.at, new Date(from - LOOKBACK_DAYS * DAY)),
        or(
          like(events.type, 'gateway.%'),
          like(events.type, 'device.%'),
          like(events.type, 'linktap.%'),
        ),
      ),
    )
    .all();
  const gwTransitions = new Map<string, Transition[]>();
  const devTransitions = new Map<string, Transition[]>();
  const push = (m: Map<string, Transition[]>, id: string, t: Transition) =>
    m.set(id, [...(m.get(id) ?? []), t]);
  for (const e of evs) {
    const c = classifyTransition(e.type);
    if (!c) continue;
    const t: Transition = { at: e.at.getTime(), online: c.online, source: sourceOf(e.source) };
    if (c.scope === 'gateway') {
      const id = e.gatewayId && baseId(e.gatewayId);
      if (id) push(gwTransitions, id, t);
    } else if (e.deviceId) {
      for (const d of devs) {
        if (d.id === e.deviceId || baseId(d.id) === e.deviceId) push(devTransitions, d.id, t);
      }
    }
  }

  const incidents: Incident[] = [];
  const result: GatewayNetwork[] = gws
    .sort((a, b) => (a.name ?? a.linktapName).localeCompare(b.name ?? b.linktapName))
    .map((g) => {
      const gDevs = devs.filter((d) => d.gatewayId === g.id);
      const gName = g.name ?? g.linktapName;
      const polls = gDevs.flatMap((d) => (snapsBy.get(d.id) ?? []).map((s) => s.at.getTime()));
      const gTimeline = buildTimeline({
        from,
        to: now,
        onlineNow: g.online,
        transitions: gwTransitions.get(g.id) ?? [],
        polls: [...new Set(polls)],
        firstDataAt: polls.length ? Math.min(...polls) : null,
      });
      const gIncidents = withinWindow(gTimeline, from);

      const devicesOut = gDevs
        .sort((a, b) => (a.name ?? a.linktapName).localeCompare(b.name ?? b.linktapName))
        .map((d): DeviceNetwork => {
          const own = snapsBy.get(d.id) ?? [];
          const ats = own.map((s) => s.at.getTime());
          const timeline = buildTimeline({
            from,
            to: now,
            onlineNow: d.online,
            transitions: devTransitions.get(d.id) ?? [],
            polls: ats,
            firstDataAt: ats.length ? Math.min(...ats) : null,
          });
          const inWindow = own.filter((s) => s.at.getTime() >= from);
          const signal = signalStats(
            inWindow.map((s) => ({ at: s.at.getTime(), online: s.online, value: s.signalPct })),
            weakSignalPct,
          );
          const battery = batteryStats(
            own.map((s) => ({ at: s.at.getTime(), value: s.batteryPct })),
          );
          const dName = d.name ?? d.linktapName;
          for (const inc of withinWindow(timeline, from)) {
            const via = gIncidents.some(
              (gi) =>
                inc.start >= gi.start - 5 * 60_000 && inc.start <= (gi.end ?? now) + 5 * 60_000,
            );
            incidents.push(toIncident('device', g.id, d.id, dName, inc, now, via));
          }
          return {
            id: d.id,
            gatewayId: g.id,
            name: dName,
            online: d.online,
            lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
            uptimePct: round1(timeline.uptimePct),
            segments: toSegments(timeline.segments),
            signal,
            battery,
            alarms: d.alarms,
          };
        });

      for (const inc of gIncidents) {
        incidents.push(toIncident('gateway', g.id, null, gName, inc, now, false));
      }
      return {
        id: g.id,
        name: gName,
        online: g.online,
        lastSeenAt: g.lastSeenAt?.toISOString() ?? null,
        version: g.version ?? null,
        uptimePct: round1(gTimeline.uptimePct),
        segments: toSegments(gTimeline.segments),
        devices: devicesOut,
      };
    });

  incidents.sort((a, b) => b.start.localeCompare(a.start));
  return { gateways: result, incidents, lastPollAt };
}

const round1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);

/** Incidents that overlap the window, i.e. still open or ended inside it. */
function withinWindow(t: Timeline, from: number) {
  return t.incidents.filter((i) => i.end === null || i.end >= from);
}

function toIncident(
  scope: 'gateway' | 'device',
  gatewayId: string,
  deviceId: string | null,
  name: string,
  inc: { start: number; end: number | null; source: IncidentSource },
  now: number,
  viaGateway: boolean,
): Incident {
  return {
    id: `${scope}:${deviceId ?? gatewayId}:${inc.start}`,
    scope,
    gatewayId,
    deviceId,
    name,
    start: new Date(inc.start).toISOString(),
    end: inc.end === null ? null : new Date(inc.end).toISOString(),
    durationSec: Math.max(0, Math.round(((inc.end ?? now) - inc.start) / 1000)),
    ongoing: inc.end === null,
    source: inc.source,
    viaGateway,
  };
}
