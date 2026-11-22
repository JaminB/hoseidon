import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type {
  AlarmFlag,
  EventSeverity,
  EventSource,
  RunSource,
  RunStatus,
  Watering,
  WorkMode,
} from '@hoseidon/shared';

/**
 * Timestamps are integer milliseconds (drizzle `timestamp_ms`) so they sort and compare cheaply.
 * After editing this file run `pnpm --filter @hoseidon/server db:generate` to add a migration.
 */
const ts = (name: string) => integer(name, { mode: 'timestamp_ms' });
const createdAt = () =>
  ts('created_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`);

/** Small key/value store for app settings. */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const gateways = sqliteTable('gateways', {
  /** 16-char LinkTap gateway id. */
  id: text('id').primaryKey(),
  linktapName: text('linktap_name').notNull(),
  /** User override for the display name. */
  name: text('name'),
  status: text('status'),
  online: integer('online', { mode: 'boolean' }).notNull().default(false),
  /** Location is not available from LinkTap; set once by the user. */
  lat: real('lat'),
  lon: real('lon'),
  timezone: text('timezone'),
  lastSeenAt: ts('last_seen_at'),
  raw: text('raw', { mode: 'json' }),
  createdAt: createdAt(),
  updatedAt: ts('updated_at').notNull(),
});

/** Taplinkers / ValveLinker outlets. One row per controllable outlet. */
export const devices = sqliteTable(
  'devices',
  {
    /** 16-char taplinker id, or 18 chars ("..._1") for a multi-outlet outlet. */
    id: text('id').primaryKey(),
    gatewayId: text('gateway_id')
      .notNull()
      .references(() => gateways.id, { onDelete: 'cascade' }),
    outlet: integer('outlet'),
    linktapName: text('linktap_name').notNull(),
    name: text('name'),
    zone: text('zone'),
    status: text('status'),
    online: integer('online', { mode: 'boolean' }).notNull().default(false),
    batteryPct: real('battery_pct'),
    signalPct: real('signal_pct'),
    workMode: text('work_mode').$type<WorkMode>(),
    alarms: text('alarms', { mode: 'json' })
      .$type<AlarmFlag[]>()
      .notNull()
      .default(sql`'[]'`),
    watering: text('watering', { mode: 'json' }).$type<Watering | null>(),
    lastSeenAt: ts('last_seen_at'),
    /** Last successful getWateringHistory fetch. */
    historyFetchedAt: ts('history_fetched_at'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [index('devices_gateway_idx').on(t.gatewayId)],
);

/** Time series of each device's state, one row per getAllDevices poll. */
export const deviceSnapshots = sqliteTable(
  'device_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    at: ts('at').notNull(),
    status: text('status'),
    online: integer('online', { mode: 'boolean' }).notNull(),
    batteryPct: real('battery_pct'),
    signalPct: real('signal_pct'),
    workMode: text('work_mode').$type<WorkMode>(),
    watering: integer('watering', { mode: 'boolean' }).notNull().default(false),
    alarms: text('alarms', { mode: 'json' })
      .$type<AlarmFlag[]>()
      .notNull()
      .default(sql`'[]'`),
    raw: text('raw', { mode: 'json' }),
  },
  (t) => [index('device_snapshots_device_at_idx').on(t.deviceId, t.at)],
);

/** Watering runs: ones Hoseidon started, ones LinkTap reports (plans/app), and manual presses. */
export const runs = sqliteTable(
  'runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    startedAt: ts('started_at').notNull(),
    endedAt: ts('ended_at'),
    plannedSec: integer('planned_sec'),
    durationSec: integer('duration_sec'),
    volumeMl: real('volume_ml'),
    source: text('source').$type<RunSource>().notNull(),
    /** Set by the scheduler (phase 2). No FK yet: the schedules table doesn't exist. */
    scheduleId: integer('schedule_id'),
    status: text('status').$type<RunStatus>().notNull(),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [
    index('runs_device_started_idx').on(t.deviceId, t.startedAt),
    index('runs_status_idx').on(t.status),
  ],
);

/** Webhook deliveries and events we derive ourselves (offline, signal drop, alarms...). */
export const events = sqliteTable(
  'events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    at: ts('at').notNull(),
    type: text('type').notNull(),
    source: text('source').$type<EventSource>().notNull(),
    severity: text('severity').$type<EventSeverity>().notNull(),
    gatewayId: text('gateway_id'),
    deviceId: text('device_id'),
    title: text('title').notNull(),
    message: text('message'),
    data: text('data', { mode: 'json' }),
  },
  (t) => [index('events_at_idx').on(t.at), index('events_device_at_idx').on(t.deviceId, t.at)],
);

export type GatewayRow = typeof gateways.$inferSelect;
export type DeviceRow = typeof devices.$inferSelect;
export type SnapshotRow = typeof deviceSnapshots.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
