import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type {
  AlarmFlag,
  CycleSoak,
  EventSeverity,
  EventSource,
  PlannedRunStatus,
  RunSource,
  RunStatus,
  ScheduleItem,
  SkipRules,
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

/** Hoseidon-owned watering schedules (LinkTap's cloud API can't store plans). */
export const schedules = sqliteTable('schedules', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  color: text('color').notNull(),
  /** RRULE body without DTSTART, e.g. "FREQ=DAILY;INTERVAL=2". */
  rrule: text('rrule').notNull(),
  /** Local wall-clock start "YYYY-MM-DDTHH:mm" in `timezone`. */
  dtstart: text('dtstart').notNull(),
  timezone: text('timezone').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  items: text('items', { mode: 'json' }).$type<ScheduleItem[]>().notNull(),
  cycleSoak: text('cycle_soak', { mode: 'json' }).$type<CycleSoak | null>(),
  sequential: integer('sequential', { mode: 'boolean' }).notNull().default(true),
  skipRules: text('skip_rules', { mode: 'json' }).$type<SkipRules>().notNull(),
  /** Google Calendar event for this schedule (phase 6). */
  gcalEventId: text('gcal_event_id'),
  /**
   * Occurrences before this are never materialized. Bumped whenever the timing changes, so an
   * edit at 6:05 doesn't replay the 6:00 run.
   */
  effectiveFrom: ts('effective_from').notNull(),
  createdAt: createdAt(),
  updatedAt: ts('updated_at').notNull(),
});

/** One device-cycle of one schedule occurrence: what the engine will start, or did. */
export const plannedRuns = sqliteTable(
  'planned_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    scheduleId: integer('schedule_id')
      .notNull()
      .references(() => schedules.id, { onDelete: 'cascade' }),
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    gatewayId: text('gateway_id').notNull(),
    occurrenceAt: ts('occurrence_at').notNull(),
    /** Zone position in the schedule (0-based) and cycle number (1-based). */
    seq: integer('seq').notNull(),
    cycle: integer('cycle').notNull(),
    /** Estimated start from the plan; the engine goes by readiness, not this. */
    plannedAt: ts('planned_at').notNull(),
    /** Per-cycle seconds before weather scaling. */
    baseSeconds: integer('base_seconds').notNull(),
    /** Per-cycle seconds that will be (or were) sent, after scaling and quantizing. */
    seconds: integer('seconds').notNull(),
    scale: real('scale').notNull().default(1),
    status: text('status').$type<PlannedRunStatus>().notNull(),
    skipReason: text('skip_reason'),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    /** When skip rules were applied to this occurrence; null = the occurrence hasn't begun. */
    weatherCheckedAt: ts('weather_checked_at'),
    runId: integer('run_id').references(() => runs.id, { onDelete: 'set null' }),
    startedAt: ts('started_at'),
    endedAt: ts('ended_at'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('planned_runs_slot_idx').on(t.scheduleId, t.occurrenceAt, t.seq, t.cycle),
    index('planned_runs_status_idx').on(t.status),
    index('planned_runs_planned_at_idx').on(t.plannedAt),
  ],
);

export type GatewayRow = typeof gateways.$inferSelect;
export type DeviceRow = typeof devices.$inferSelect;
export type SnapshotRow = typeof deviceSnapshots.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type ScheduleRow = typeof schedules.$inferSelect;
export type PlannedRunRow = typeof plannedRuns.$inferSelect;
export type NewPlannedRun = typeof plannedRuns.$inferInsert;

/**
 * Daily weather per location (lat/lon rounded to 2 decimals, so gateways in the same yard share
 * rows). Forecast rows are refreshed; archive rows are final.
 */
export const weatherDaily = sqliteTable(
  'weather_daily',
  {
    /** "lat,lon" rounded to 2 decimals, e.g. "40.71,-74.01". */
    locationKey: text('location_key').notNull(),
    /** Local date at the location, "YYYY-MM-DD". */
    date: text('date').notNull(),
    rainMm: real('rain_mm'),
    rainProbPct: real('rain_prob_pct'),
    et0Mm: real('et0_mm'),
    tMaxC: real('t_max_c'),
    tMinC: real('t_min_c'),
    windMaxKph: real('wind_max_kph'),
    soilMoisture: real('soil_moisture'),
    /** 'forecast' rows are provisional; 'archive' rows are observed values and never refetched. */
    source: text('source').$type<'forecast' | 'archive'>().notNull(),
    fetchedAt: ts('fetched_at').notNull(),
  },
  (t) => [uniqueIndex('weather_daily_loc_date_idx').on(t.locationKey, t.date)],
);

export type WeatherDailyRow = typeof weatherDaily.$inferSelect;

/**
 * Google Calendar connection (phase 6). A single row (id = 1). The calendar id outlives a
 * disconnect, so reconnecting the same Google account picks up the same calendar and events.
 */
export const gcalAccount = sqliteTable('gcal_account', {
  id: integer('id').primaryKey(),
  /** AES-256-GCM ciphertext (see gcal/crypto.ts). Null when disconnected. */
  refreshTokenEnc: text('refresh_token_enc'),
  scope: text('scope'),
  calendarId: text('calendar_id'),
  connectedAt: ts('connected_at'),
  /** Google rejected the refresh token (revoked, or Testing-mode 7-day expiry). */
  needsReconnect: integer('needs_reconnect', { mode: 'boolean' }).notNull().default(false),
  lastSyncAt: ts('last_sync_at'),
  lastError: text('last_error'),
  updatedAt: ts('updated_at').notNull(),
});

/** What we last pushed to Google, per synced item, so a sync only sends what changed. */
export const gcalEvents = sqliteTable('gcal_events', {
  /** "schedule:<id>", "skip:<scheduleId>:<iso>", "occ:<scheduleId>:<iso>" or "run:<id>". */
  key: text('key').primaryKey(),
  kind: text('kind').$type<'schedule' | 'skip' | 'log'>().notNull(),
  /** Google event id (an instance id for skips). Null when a skip found no instance. */
  eventId: text('event_id'),
  hash: text('hash').notNull(),
  /** When the item happens; old skip/log items fall out of the sync window and are left alone. */
  at: ts('at'),
  syncedAt: ts('synced_at').notNull(),
});

export type GcalAccountRow = typeof gcalAccount.$inferSelect;
export type GcalEventRow = typeof gcalEvents.$inferSelect;

/** Browser sessions. Only a hash of the cookie token is stored, so a DB leak can't be replayed. */
export const sessions = sqliteTable('sessions', {
  /** sha256 hex of the cookie token. */
  id: text('id').primaryKey(),
  createdAt: createdAt(),
  expiresAt: ts('expires_at').notNull(),
});

/** WebAuthn credentials for the single admin. */
export const passkeys = sqliteTable('passkeys', {
  /** Base64url credential id. */
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** Base64url COSE public key. */
  publicKey: text('public_key').notNull(),
  counter: integer('counter').notNull().default(0),
  transports: text('transports', { mode: 'json' }).$type<string[]>(),
  createdAt: createdAt(),
  lastUsedAt: ts('last_used_at'),
});

/** Web Push subscriptions, one per browser or installed PWA. */
export const pushSubscriptions = sqliteTable('push_subscriptions', {
  endpoint: text('endpoint').primaryKey(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  createdAt: createdAt(),
});

export type PasskeyRow = typeof passkeys.$inferSelect;
export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;
