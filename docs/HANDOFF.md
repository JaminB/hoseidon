# Handoff notes

## Phase 0: scaffold

**What exists**

- pnpm monorepo: `apps/web`, `apps/server`, `packages/shared` (all `@hoseidon/*`).
- `apps/server`: Hono on `@hono/node-server`. `src/app.ts` exports `createApp(config)` (testable via
  `app.request`), `src/config.ts` zod-validates env (blank values treated as unset), `src/db/`
  has Drizzle schema + `openDb(path)` (bootstraps a `settings` table with raw SQL; switch to
  drizzle-kit migrations when real tables arrive). Serves `WEB_DIST` with SPA fallback if present.
  Unknown `/api/*` returns JSON 404. Built with tsup (bundles `@hoseidon/shared`, externalizes
  `better-sqlite3`).
- `apps/web`: Vite 8 + React 19 + Tailwind v4 (CSS-first, `@theme` in `src/index.css`) +
  TanStack Query + react-router + vite-plugin-pwa (stub manifest, svg icon only). Dev proxy for
  `/api` and `/hooks` to :8787.
- `packages/shared`: consumed as TypeScript source (`main: src/index.ts`), no build step. zod
  schemas live here (`healthSchema`, `workModeSchema`, `parsePercent`).
- Docker (multi-stage, `pnpm deploy --prod`), compose (`cloudflared` under `tunnel` profile), CI
  (lint, typecheck, test, build, docker build).

**Conventions**

- Strict TS, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`. Extensionless relative imports.
- Tests are colocated `*.test.ts`, run by vitest per package. Prettier is enforced by `pnpm lint`.
- Env var additions go in `.env.example`, `config.ts` and the README table.
- TypeScript is pinned to 6.x because typescript-eslint does not support TS 7 yet.
- pnpm 12 build-script allowlist lives in `pnpm-workspace.yaml` (`allowBuilds`).
- pnpm is not on PATH on the dev machine; use `corepack pnpm`.

**Known gaps**

- Docker image was never run locally (no Docker); only CI builds it.
- PWA icons are SVG only (no PNG maskable icons); no push yet.
- No auth, no LinkTap client, no real DB schema yet.

## Phase 1: LinkTap core (server)

**What exists**

- `apps/server/src/linktap/`:
  - `schemas.ts`: loose zod schemas for the raw responses.
  - `normalize.ts`: normalizers and ID helpers. It covers percentages, flags, work modes,
    watering (minutes to seconds), history from gateway-local time to UTC, and `baseId`/`outletOf`.
  - `rate-limit.ts`: the `RateLimiter`. It serializes calls per bucket and scope, coalesces reads
    and exposes `nextAvailableAt`.
  - `client.ts`: `createLinkTapClient({username, apiKey, transport, limits?})`. Limits are in
    `LINKTAP_LIMITS`.
  - `mock.ts`: `LinkTapMock`, which provides a Transport. It has 2 gateways and 6 taplinkers,
    including a multi-outlet `_1`/`_2`, and enforces the rate limits by default.
  - `index.ts`: `linktapFromConfig`.
- DB (`src/db/schema.ts`) has the tables `gateways`, `devices`, `device_snapshots`, `runs`,
  `events` and `settings`.
  - Timestamps are `timestamp_ms` (Date).
  - Migrations are in `apps/server/drizzle`. `openDb` applies them on boot.
  - After a schema change, run `pnpm --filter @hoseidon/server exec drizzle-kit generate --name <slug>`.
  - Docker copies `drizzle/` next to `dist/`.
- `src/poller/index.ts`: `Poller` with `pollDevices` (5 min), `pollRunning` (30 s, only devices
  that are watering or have an open run) and `pollHistoryNext` (10 min, one device per tick;
  devices that just finished a run go first). `start()`/`stop()`, plus `status()`.
- `src/poller/ingest.ts` holds all DB writes:
  - It upserts devices, writes snapshots and syncs runs with the watering state.
  - It derives the events `gateway.offline`/`gateway.online`, `device.offline`/`device.online`,
    `device.signal_low`/`device.signal_ok` (below 30%), `device.battery_low` (below 20%) and
    `device.alarm`/`device.alarm_cleared`.
  - It merges history (within ±2 min of a known run) and ingests webhooks.
- REST (`src/api/routes.ts`): `GET /api/gateways` (with devices nested), `PATCH /api/gateways/:id`
  (name, lat, lon, timezone), `GET /api/devices`, `GET /api/devices/:id?from&to` (device plus
  snapshots and runs, default the last 24 h), `PATCH /api/devices/:id` (name, zone),
  `POST /api/devices/:id/{run,stop,pause,dismiss-alarm}`, `GET /api/events?limit&before&deviceId&gatewayId&severity`,
  and `GET /api/linktap/status`.
  - Commands return `{ok, nextCommandAt, run}`.
  - LinkTap errors map to 502 (400 for invalid input). An offline device gives 409.
- Webhook: `POST /hooks/linktap/:secret`. It returns 404 when the secret is wrong or
  `WEBHOOK_SECRET` is blank, and 403 for another account's username.
- `packages/shared/src/api.ts` has the API DTO zod schemas and request schemas. The web app should
  import these.
- `docs/linktap-api.md` is the full capability scope. Unverified assumptions are marked there.

**Conventions**

- `createApp({config, db, linktap, poller?})`. Tests use `harness()` from `src/test-utils.ts`
  (in-memory DB, mock, zero rate limits) and `app.request`.
- Device and gateway `name` columns are user overrides. The DTO `name` is the override, falling
  back to `linktapName`.
- Run sources are `hoseidon`, `linktap` and `manual`. Statuses are `running`, `completed`,
  `stopped`, `failed` and `skipped`. `runs.schedule_id` has no FK yet; phase 2 adds `schedules`.
- Use `startRun`, `closeRun` and `openRun` from `ingest.ts` for run bookkeeping. The phase 2
  executor should create its run with `source: 'hoseidon'` and `scheduleId`.

**Known gaps**

- These are unverified until the live smoke test:
  - watering time units (`WATERING_TIME_UNIT_SEC`)
  - the history response key
  - the webhook event strings
  - which endpoints want 16-char ids
  - whether the rate limits are per account or per device
- Commands await the rate-limit queue, and the queue has no depth limit. Each queued command
  waits for every earlier one, at 15 s apiece, so N queued commands mean a wait of about N×15 s.
  The scheduler should send runs one at a time rather than flooding the queue.
- There is no auth yet, so every `/api` route (including the device commands) is open. Keep the
  server on the LAN until phase 7 adds auth. The CodeRabbit review flagged this too.
- The webhook secret is in the URL path, so the request logger redacts `/hooks/linktap/*`.
- `openDb` drops phase 0's empty, unmigrated `settings` table before migrating.
- There is no retention or pruning for snapshots yet: about 288 rows per device per day.

## Phase 2: Scheduler engine (server + shared)

**What exists**

- `packages/shared/src/schedule.ts` holds the zod schemas for schedules (`scheduleInputSchema`,
  `schedulePatchSchema`, `scheduleSchema`), skip rules (`DEFAULT_SKIP_RULES`), planned runs and
  preview occurrences. `MAX_RUN_SEC` is there too.
  - The patch schema has no defaults on purpose. Zod's `.partial()` still applies defaults, so it
    is built from the raw fields.
- `packages/shared/src/quick-add.ts`: `parseQuickAdd(text, {devices, timeZone, now})` returns a
  `{ok, draft, summary, zones, warnings, errors}` result, and `draft` posts straight to
  `/api/schedules`. `matchDevice` does fuzzy name matching.
- `apps/server/src/schedule/` holds the engine:
  - `time.ts`: `toWall`/`fromWall` with an explicit DST policy (a skipped time moves forward, a
    repeated time takes the first).
  - `occurrences.ts`: `expandOccurrences`, `nextOccurrence` and `validateRecurrence`. rrule.js runs
    in floating time, and FREQ faster than DAILY is rejected.
  - `plan.ts`: `planOccurrence` (cycles, soak and lane layout), `laneOf` and `slotOrder`.
  - `weather.ts`: the `WeatherProvider` interface, `NullWeatherProvider` and `evaluateSkipRules`.
  - `executor.ts`: the `Executor` interface, `CloudExecutor`, a `LocalGatewayExecutor` stub and
    `startVerified` (start, verify, retry once).
  - `engine.ts`: `SchedulerEngine`, with `tick()` every 30 s, `rematerialize(id)` and `status()`.
    Each tick settles runs, materializes 48 h ahead, catches up missed runs (a 10 min window),
    applies skip rules, then starts ready runs one at a time.
  - `preview.ts`: `previewOccurrences` (calendar slots and `overlapsWith`) and `scheduleWarnings`.
- DB: the `schedules` and `planned_runs` tables are added in migration `0001_scheduler`.
  - `planned_runs` is unique on (scheduleId, occurrenceAt, seq, cycle), so materializing is
    idempotent.
  - `schedules.effectiveFrom` is bumped on any timing edit, so edits never replay past occurrences.
- API (`src/api/schedules.ts`):
  - schedule CRUD
  - `GET /api/schedules/preview`
  - `POST /api/schedules/quick-add`
  - `GET /api/planned-runs`
  - `POST /api/planned-runs/:id/skip`
  - `GET /api/scheduler/status`

  Shared HTTP helpers now live in `src/api/http.ts`. Full write-up: `docs/scheduler.md`.

- `recordStart(tx, …)` in `ingest.ts` is the shared start bookkeeping for manual runs and
  scheduled runs.
- Mock: `mock.failStartsSilently(id, n)` makes the next n starts answer ok without watering.
- `harness()` now also returns `executor` (a CloudExecutor with no verify delay) and `scheduler`,
  and takes `engine` options (e.g. a fake `weather`).
- `.gitattributes` forces LF. The working tree was normalized: Windows checkouts had CRLF, which
  broke scripted edits.

**Conventions**

- `createApp` takes optional `scheduler`, `executor` and `timeZone`. `index.ts` wires a
  CloudExecutor and a SchedulerEngine and starts the engine with the poller.
- Phase 4: implement `WeatherProvider.outlook({lat, lon, timezone}, at)` with Open-Meteo and pass
  it as `weather` to `SchedulerEngine`.
  - `rainMm`, `minTempC` and `maxWindKph` cover the next 24 h. `et0Mm` is today's value and
    `et0BaselineMm` is the "normal" value durations were tuned for.
  - A gateway with no lat/lon means no skips.
- Phase 3 UI:
  - The week view uses `/api/schedules/preview`, and Today uses `/api/planned-runs`, where
    `skipReason` holds the "Skipped — 8 mm rain forecast" text.
  - Quick add uses `POST /api/schedules/quick-add`.
  - Show `schedule.warnings`, including LinkTap-app plan conflicts.
- Phase 6 gcal: `schedules.gcalEventId` exists. Use the RRULE plus `dtstart`/`timezone` directly
  for recurring events.
- Event types added: `schedule.skipped` (info), `schedule.missed` (warn) and
  `schedule.run_failed` (alert).
- tsup bundles `rrule` (`noExternal`) because its CJS build has no named ESM exports.

**Known gaps**

- The engine only skips or scales at the moment an occurrence starts. Upcoming planned runs don't
  show a predicted skip yet; the UI could call the provider for a forecast badge.
- After a final verify failure the engine doesn't send a stop. If a start "took" but the status
  never showed it, the timer runs its programmed time untracked; the poller's `getAllDevices`
  would then pick it up as a `linktap` run.
- LinkTap's own `eco` cycle/soak isn't used. Hoseidon runs each cycle as a separate instant run,
  which costs a 15 s command slot each.
- S-model seconds support is opt-in (`CloudExecutor({supportsSeconds})`), and nothing detects S
  models yet.
- `runs.schedule_id` still has no FK, so a deleted schedule leaves its id on past runs.
- When a schedule is deleted, its planned runs cascade away, including any that are running.
