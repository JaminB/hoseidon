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

## Phase 3: Design system, app shell, Home, Devices, Schedule (web)

**What exists** (`apps/web/src`)

- Design tokens in `index.css`. Semantic colors are CSS variables (`--app-*`) redefined under
  `[data-theme='dark']` and exposed through `@theme inline` as Tailwind colors: `bg`, `surface`,
  `surface-2/3`, `line`, `line-strong`, `fg`, `muted`, `subtle`, `accent`, `accent-strong`,
  `accent-soft`, `accent-fg`, `ok`, `warn`, `warn-strong`, `danger` (+ `-soft`). Radii, shadows
  (`shadow-xs..lg`), easing and keyframe animations (`animate-fade-in`, `sheet-*`, `pop-in`,
  `toast-in`, `shimmer`, `ripple`) live there too. Geist / Geist Mono are self-hosted via
  `@fontsource-variable`. `prefers-reduced-motion` turns animation off globally. `tnum` is a
  utility for tabular numbers.
- Theme: `lib/theme.ts` (`system | light | dark`, stored in localStorage, applied as
  `html[data-theme]`; an inline script in `index.html` sets it before first paint). Dark mode in
  Tailwind is `dark:` via a custom variant on `data-theme`, not the media query.
- Components (`components/ui/`): Button (variants primary/secondary/ghost/soft/danger,
  `asChild`, `loading`), Card/CardHeader/SectionLabel, Badge/Dot, Sheet (Radix Dialog: bottom
  sheet on phones, right panel on desktop), ConfirmDialog (Radix AlertDialog), Tabs/Segmented,
  Switch, Toast (`toast()`, `toast.success/error`, Radix Toast), Skeleton, Stat, EmptyState,
  Field/Input/inputClass, Kbd, and `indicators.tsx` with BatteryIcon, SignalBars, CountdownRing.
  Icons are lucide-react. `components/logo.tsx` has the trident mark (also the new favicon).
- Layout: `components/layout/app-shell.tsx` (sidebar ≥ md, bottom tab bar on phones; `NAV`,
  `Page`, `PageHeader`, `ThemeToggle`). Routes in `App.tsx`; pages other than Home are lazy.
- Data: `lib/api.ts` is the typed client (zod-parsed with the shared DTO schemas; throws
  `ApiError` with the server's `error` text) plus `geocode()` for Open-Meteo. `lib/queries.ts`
  has the TanStack Query keys and hooks. Device commands, renames, alarm dismissals and
  schedule edits/deletes are optimistic with rollback + toast. Gateways poll every 60 s (10 s
  while anything waters), planned runs every 30 s.
- Pages: `pages/home.tsx` (stats, running-now countdown rings with Stop, Today timeline from
  `/api/planned-runs` with skip reasons, Skip button, quick run, needs-attention list),
  `pages/devices.tsx` (gateway cards, nested timers, alarms with one-tap dismiss, LinkTap-plan
  conflict banner, quick run 5/10/15, device sheet for name/zone, gateway sheet for name and
  location via geolocation or ZIP/city search), `pages/schedule.tsx` (quick-add bar with live
  client-side parse, templates, Week/List tabs, rolling 7-day week (3 days on phones) with
  drag-to-create, lane layout for overlaps and red outline for `overlapsWith`, schedule sheet
  for create/edit/delete), `pages/settings.tsx` (theme, LinkTap rate-limit status, about),
  `pages/placeholders.tsx` (Analytics, Network).
- Pure logic with tests: `lib/calendar.ts` (day math, drag snapping, `layoutDay` lanes,
  `describeRrule`), `lib/repeat.ts` (repeat picker <-> RRULE), `lib/format.ts`, `lib/linktap.ts`.
  `lib/schedule-draft.ts` holds the sheet's draft model, colors and TEMPLATES.
- Playwright smoke test: `apps/web/e2e/smoke.spec.ts` + `playwright.config.ts`. It starts the
  server with tsx (mock LinkTap, temp SQLite, port 8797) and Vite (port 5179, `HOSEIDON_API`
  points the proxy at it), seeds 5 schedules, and screenshots 6 pages × 390/1440 × light/dark plus
  a few interactions into `e2e/__screenshots__` (gitignored). CI job `e2e` runs it and uploads the
  screenshots as an artifact. The e2e folder has its own tsconfig (node types).
- Server fix: `schedule/occurrences.ts` imports rrule as a namespace with a `default` fallback, so
  `pnpm dev` (tsx, plain Node) works. Before this the dev server crashed on boot.

**Conventions**

- Use the semantic color utilities, never raw palette colors, so both themes keep working.
  Schedule colors are user data (hex) and are mixed with `color-mix()` against surface/fg.
- New pages: wrap in `<Page>` + `<PageHeader>`; add to `NAV` and `App.tsx` (lazy).
- New server calls go in `lib/api.ts` (parse with a shared schema) and get a hook in
  `lib/queries.ts`. Mutations toast their errors.
- Week view/time math is in the browser's local zone. New schedules get the browser zone.

**Known gaps**

- No weather strip on Home yet (phase 4); skip-rule fields exist in the sheet and note they need
  a gateway location. Analytics and Network are placeholders.
- The week view only shows occurrences from the preview API (from each schedule's
  `effectiveFrom`), so past days don't show what actually ran. A runs overlay would fix it.
- Touch: tapping an empty slot creates a 30 min block; there's no touch drag (it would fight
  scrolling). Blocks can't be dragged to move/resize yet.
- Quick-add creates directly when the parse is clean; ambiguous zone names need the sheet.
- PWA icons are still SVG only; no offline data cache beyond the app shell.

## Phase 4: Weather + analytics

**What exists**

- `server/src/weather/`: `open-meteo.ts` (`OpenMeteoProvider`, implements `WeatherProvider`),
  `mock.ts` (offline Open-Meteo-shaped fetch, used when `LINKTAP_MOCK=true`), `dates.ts`
  (local-date string helpers). Cache table `weather_daily` (migration 0002), keyed by lat/lon
  rounded to 2 decimals so gateways in one yard share rows. Forecast rows refresh after 3 h;
  days older than 7 come from the archive API and are final. A failed fetch is logged and the
  cache is served. `outlook()` uses today's daily values; the ET₀ baseline is the mean of the
  previous 14 days (needs 7). The scheduler engine gets this provider in `index.ts`.
- API (`api/analytics.ts`): `GET /api/weather/:gatewayId?from&to` (local dates; `available:false`
  until the gateway has a location), `GET /api/analytics/devices/:id?from&to`,
  `GET /api/analytics/summary`. Aggregation is in `analytics/aggregate.ts`: days are bucketed in
  the gateway's time zone, running runs are excluded, "saved" = weather-skipped cycles
  (rain/freeze/wind) plus ET₀ scale-downs, converted to volume at the device's average flow.
  Shared DTOs and `classifySkipReason` are in `packages/shared/src/analytics.ts`.
- Web: `pages/analytics.tsx` (device picker incl. "All timers", 7d/30d/90d/1y), Recharts charts in
  `components/analytics/charts.tsx`, custom heatmap, `components/weather-strip.tsx` on Home,
  pure helpers in `lib/analytics.ts` (tested). Chart colors use tokens (`--app-rain`, `--app-et0`
  added). Ranges over 120 days fold into weekly buckets. Flow chart hides without volume data.
- `harness({ weatherFetch })` in test-utils; `createMockOpenMeteo(now)` for fixed clocks.

**Known gaps**

- Skip rules still only evaluate when an occurrence starts, so upcoming runs show no predicted skip.
- Mock history is fetched one device per 10 min, so a fresh mock DB has little analytics data.
- Weather uses today's daily values, not a rolling next-24h window. Units: liters, mm, and
  Fahrenheit only for en-US locales.
- Soil moisture is stored and returned by the API but not charted yet.
- A manual skip with free text that mentions "rain" is classified as rain.

## Phase 5: Network monitoring + troubleshooting

**What exists**

- `server/src/network/`: `metrics.ts` (pure: `buildTimeline`, `signalStats`, `batteryStats`, `downsample`,
  `freshness`), `overview.ts` (`buildNetwork(db, {now, days, weakSignalPct})` reads `device_snapshots`
  and `events`; `classifyTransition` reads our events and LinkTap webhook names loosely),
  `diagnose.ts` (pure 10-item checklist with plain-English fixes), `settings.ts` (weak-signal
  threshold in the `settings` table, key `network.weakSignalPct`, default 40).
- Gateway uptime comes from `gateway.*`/webhook events (gateways have no snapshots); timer uptime from
  `device.*` events. Start state is inferred from the first transition. Stretches with no poll for
  more than 20 min, and time before the first snapshot, are "unknown" and excluded from uptime.
  Incident source is `webhook` or `poll`; timer incidents inside a gateway outage get `viaGateway`.
- Battery drain is a least-squares slope since the last recharge (a rise of 10+ points); it needs 5
  samples and 12 h. Signal "drops" are falls of 25+ points between consecutive polls.
- `linktap/stats.ts` + `client.stats()`: per-endpoint calls, errors, last OK/error, recent error rate
  (last 50) and rate-limit queue wait. In memory only; resets on restart.
- The poller's `device.signal_low`/`signal_ok` events now use the configurable threshold (was a
  fixed 30). `THRESHOLDS.signalLowPct` is gone.
- API (`api/network.ts`): `GET /api/network/overview?days=1..30`, `/network/gateways/:id`,
  `/network/devices/:id`, `GET|PATCH /api/network/settings`, `POST /api/diagnose/:deviceId`.
  DTOs in `packages/shared/src/network.ts`.
- Web: `pages/network.tsx` (summary, per-gateway topology with signal as line weight/colour, uptime
  bars, signal/battery sparklines, incident log, API health, threshold slider, mesh disclaimer),
  `components/network/` (`gateway-card`, `charts`, `diagnose-sheet`), `lib/network.ts` (tested
  geometry/labels). Diagnose buttons are on Network rows and on Devices rows.

**Known gaps**

- API health counters are not persisted. Gateways have no snapshots, so a gateway with no events and
  no devices shows all "no data".
- Webhook-reported device events attach to every outlet sharing the 16-char base id.
- No retention/pruning of `device_snapshots` (~288 rows/device/day); 30-day windows read ~9k rows each.
- A timer offline for the whole window shows an incident starting at the window edge.
- LinkTap exposes no extender/mesh data, so the topology is always gateway-to-timer.

## Phase 6: Google Calendar one-way sync

**What exists**

- `server/src/gcal/` (details in `docs/gcal.md`):
  - `oauth.ts`: auth URL (PKCE S256, `state`, `access_type=offline`, `prompt=consent`, scope
    `calendar.app.created`), code exchange, refresh, revoke, and `TokenSource`, which caches the
    access token and refreshes it 60 s before expiry. `GoogleAuthError.invalidGrant`.
  - `crypto.ts`: `SecretBox`, AES-256-GCM with an HKDF key from `SESSION_SECRET`. The format is
    `v1.<iv>.<tag>.<ct>`.
  - `calendar.ts`: a minimal Calendar v3 client (calendars, events CRUD, instances). It retries
    once on a 401 with a forced refresh. `GoogleApiError.gone` covers 404 and 410.
  - `mapping.ts`: pure mapping. `toGoogleRrule` (wall-clock UNTIL to UTC), `scheduleEvent`
    (length from `planOccurrence` incl. soak), `skipOverlay`, `occurrenceLogEvent`, `runLogEvent`,
    `nearestColorId`, `hashOf`.
  - `sync.ts`: `buildDesired`, pure `diffSync`, and `applyOps`, which also recovers from events
    and calendars deleted in Google.
  - `service.ts`: `GcalService` handles the OAuth round trip, status, disconnect, the
    `logRuns` setting (`settings.gcal.logRuns`), and the debounced queue (3 s) with a 5 min
    periodic pass, exponential backoff (30 s up to 30 min) and `needsReconnect` handling.
  - `fake-google.ts`: an in-memory Google (token, revoke, calendars, events, instances) for tests,
    with PKCE checking, failure injection, `expireGrants()`, `expireAccessTokens()`,
    `loseNextResponse()` (do the call, answer with an error) and `rejectClient` (invalid_client).
  - Review fixes (CodeRabbit): client-chosen event ids recorded before insert (no duplicates on a
    lost response), callback serialized with sync, 403 rate limits never replace the calendar,
    only `invalid_grant` flags reconnect, a skip on a series deleted in Google recreates it, run
    logs use UTC instants. `GoogleApiError.rateLimited`, `newEventId()`.
- DB: migration `0003_gcal` adds `gcal_account` (single row, encrypted refresh token, calendar id,
  needs_reconnect, last sync and last error) and `gcal_events` (key, kind, event id, hash, at).
  `schedules.gcal_event_id` is filled in as well.
- API (`api/gcal.ts`): `GET /api/gcal/status`, `GET /api/gcal/connect` (302 to Google),
  `GET /api/gcal/callback` (302 to `${PUBLIC_URL}/settings?gcal=…`), `POST /api/gcal/disconnect`,
  `POST /api/gcal/resync`, `PATCH /api/gcal/settings {logRuns}`. DTOs are in
  `packages/shared/src/gcal.ts`.
- `scheduleRoutes` takes `onChange` (called on create, patch, delete and skip). `createApp` takes
  `gcal?` and builds an idle one from config when it isn't passed. `index.ts` starts and stops it.
  `harness({ gcal })` accepts `GcalOptions` overrides (e.g. `fetch: new FakeGoogle().fetch`) and
  returns `gcal`.
- Config: `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are now in `config.ts`. Sync counts as
  configured only when `SESSION_SECRET` has at least 16 characters.
- Web:
  - `components/gcal-card.tsx` is the Settings card. It has four states (not set up with a
    copyable redirect URI, connect, connected, reconnect). The connected state has a status row,
    event counts, a "Log finished runs" switch, Resync, and Disconnect with a confirm, plus a nudge
    near the 7-day Testing-mode expiry.
  - `GcalReconnectBanner` sits in `AppShell` and is hidden on /settings.
  - `lib/gcal.ts` holds tested helpers.
  - Settings shows a toast for `?gcal=` redirects and then cleans the URL.
  - e2e uses `page.route` to mock the status for the connected, reconnect and phone screenshots.
- README has a step-by-step Google Cloud setup (section `#google-calendar-sync`, which the card
  links to). `.env.example` notes are updated. `docs/gcal.md` covers the design and the two-way
  sync TODO.

**Conventions**

- Anything that changes what the calendar shows should call `gcal.request()` (or rely on the
  5 min pass). Never call Google directly from a route.
- A new synced item kind needs a key prefix, a `kind`, an `at` (so the window logic applies) and a
  deterministic body for hashing.

**Known gaps**

- Never exercised against real Google (fake only). Unverified: instance lookup via
  `timeMin/timeMax`, whether PUTting a changed RRULE leaves orphaned exceptions, and `PUT` on an
  event deleted in Google (handled for 404/410 only).
- The series `DTSTART` is the schedule's original `dtstart`, so after an edit Google shows the new
  timing on past dates too. Turn on "Log finished runs" to see what really ran.
- Skips are annotated only after the engine has marked them (at occurrence start, or on a manual
  skip), so there's no predicted skip ahead of time.
- OAuth `state` is in memory: a server restart during consent means clicking Connect again.
- No auth on `/api/gcal/*` yet (phase 7). Connect and disconnect are open on the LAN like the rest.
- Two-way sync (watch channels plus syncToken) is designed in `docs/gcal.md` but not built.
- If the series PUT itself is lost after Google applied it, the next pass just PUTs again (fine).
  An insert that Google rejects with 400 is retried every sync (each time with a new id).

## Phase 7: auth, PWA, push

**What exists**

- Auth (`apps/server/src/auth/`, `api/auth.ts`): one admin. `ADMIN_PASSWORD` is hashed (scrypt) into `settings` on boot and re-synced if the env value changes (which signs all sessions out). Sessions are random cookie tokens (`hoseidon_session`, httpOnly, SameSite=Lax, Secure when `PUBLIC_URL` is https); only the sha256 is stored (`sessions` table, 30 days). Failed logins throttle globally (8 per 15 min). Passkeys via SimpleWebAuthn (`passkeys` table; rpID/origin from `PUBLIC_URL`, plus `localhost:5173` in dev).
- `apiGuard` protects all of `/api` except `/health`, `/auth/session|login|logout|passkey/login/*` and `/gcal/callback`. `/hooks/*` keeps its secret path. CSRF: every mutating `/api` request needs header `x-hoseidon-csrf: 1` and a same-origin `Origin` (matched against Host, X-Forwarded-Host or `PUBLIC_URL`). The web client adds the header; e2e API calls must too.
- Tests: `harness()` leaves auth OFF by default; pass `{ auth: true }` to test real sessions.
- Push (`push/`): VAPID keys generated on first use (`settings` key `push.vapid`), subscriptions in `push_subscriptions`, prefs per type (alarm, offline, failed, skipped; skipped off by default). `PushService.flush()` runs every 10 s and on webhook receipt; it reads new `events` rows past a cursor (`push.cursor`), so every event source is covered. Repeats within 10 min are deduped by tag; bursts collapse to a summary. Dead subscriptions (404/410) are removed. New notifiable event types go in `push/classify.ts`.
- Settings API (`api/settings.ts`): time zone (`app.timeZone`; takes effect after a restart), push status/prefs/subscribe/test, `POST /linktap/test` (reuses the poller's last result when the 5-minute devices limit is active), `GET /linktap/webhook`, `POST /linktap/webhook/register` (needs `{confirm:true}`, refused in mock mode, without `WEBHOOK_SECRET`, or without a public https `PUBLIC_URL`). `LinkTapClient.setWebHookUrl` sends `webHookUrl`.
- Web: login gate in `App.tsx`; Settings cards in `components/settings/`; units (metric/imperial) are per browser in localStorage (`lib/units.ts`, the app shell remounts on change); weak-signal threshold card is shared with Network.
- PWA: icons in `apps/web/public` generated by `scripts/gen-icons.mjs`; workbox generateSW precaches the shell and imports `public/push-sw.js` for push handlers. Query cache persists to IndexedDB (`lib/persist.ts`, 7 days) and is dropped on sign-out; mutations use `networkMode: 'always'` so offline commands fail instead of queueing. `OfflineBanner` shows "last updated X ago".
- Dev proxy uses `changeOrigin: false` so Host matches Origin for the CSRF check.

**Known gaps**

- Push, passkeys and the service worker were only unit/e2e tested without a real push service or authenticator; the WebAuthn verify path is exercised only up to option generation and rejection of bad payloads.
- The time zone setting needs a restart. Unit choice is not synced between devices.
- Login throttling and passkey challenges are in memory (single process).
- Offline mutations are refused, not queued. The SW does not cache API responses.
- `register webhook` was never run against the real LinkTap API.

## Phase 9: review fixes

Fixed (all with regression tests):

- Scheduler: `pickNext` skips runs of disabled schedules ("Schedule turned off"); `rematerialize` also skips weather-checked planned rows when a schedule is disabled, or moved (`cancelStarted`, rrule/dtstart/timezone edits) so the rest of an occurrence can't water on top of a new plan.
- Stop vs. verify: `SchedulerEngine.noteStop(deviceId)` (called by `POST /devices/:id/stop`) aborts a launch still in `startVerified` (`StartAbortedError`, planned run becomes `cancelled` "Stopped by you", no retry start, no run row).
- `recordStart` adopts an open non-Hoseidon run (webhook/poll) started within 60 s instead of closing it, so there is one run, not a phantom plus a real one.
- Login throttling is per client (8 failures / 15 min), global cap 100. Client = `CF-Connecting-IP` / `X-Forwarded-For` only when `TRUST_PROXY=true`, else the socket address. Set `TRUST_PROXY=true` behind a tunnel.
- With `LINKTAP_MOCK=false`, `index.ts` refuses to start if ADMIN_PASSWORD (<12), WEBHOOK_SECRET or SESSION_SECRET (<16) is a `.env.example` placeholder or too short (`insecureConfig` in `config.ts`). Removing ADMIN_PASSWORD now deletes the stored hash and sessions.
- LinkTap rate-limit memory persists in the `settings` table (`linktap.lastCall`, real API only; `RateLimiter` takes a `LastCallStore`), so restarts don't re-hit getAllDevices.
- `POST /linktap/test` ingests the devices it fetched.
- Web: week view fits its hour range to the scheduled blocks ("Show full day" toggle) and shows compact dot + time chips in narrow lanes; Home tile is "Finished today", Skip is always visible; ET0 has its own hidden scale; flow axis shows the unit once; Network collapses timers with fewer than 2 samples into one row.

Known gaps: webhook `wateringOn` adoption is a 60 s heuristic; Devices-page plan-conflict banner does not yet link to the zone; analytics heatmap sizing not changed.

## Live API shapes (2026-11-22)

First real captures changed several assumptions; see "Verified against live API" in
`docs/linktap-api.md` and the sanitized fixtures in `apps/server/src/linktap/fixtures/`.

- Fall alarm is `fall` (mapped to `fallFlag`); `signal` is numeric; `getWateringHistory` returns
  its records under `status`, timestamped at the run END with an optional trustworthy `createdAt`
  (used only within 2 minutes of the local conversion). Zero-length entries are dropped.
- Gateway `location` (Plus Code + locality) is resolved to lat/lon/timezone by
  `linktap/location.ts` (Open-Meteo geocoding + `open-location-code`) after each device poll, only
  when the string changes and `gateways.location_source` is not `manual`. Saving a location in the
  UI sets `manual`; `PATCH /api/gateways/:id {useLinktapLocation:true}` reverts. Migration 0005
  marks pre-existing locations manual.
- New stored fields: gateway `version`, device `dType`/`flowMeter`/`flowMlPerMin`/`plan`, snapshot
  `flowMlPerMin`, run `mode`. Flow analytics are hidden when `flowMeter === false`.
- `WATERING_TIME_UNIT_SEC` (minutes) is now verified; see the next section.

## First live watering test (2026-11-22)

Real 1-minute instant runs on a 4-outlet ValveLinker. Details in `docs/linktap-api.md`
("Verified against live API" and "How Hoseidon uses it"); sanitized fixtures
`getWateringStatus.{running,finished,rate-limited}.json`.

- `getWateringStatus` is limited to one call per 30 s ("The minimum interval of calling this API
  is 30 seconds."). The limit is per taplinker (two outlets succeeded in the same second), so
  `status` is in `PER_TAPLINKER_BUCKETS`, spaced 31 s per outlet. History is now
  limited per taplinker (`PER_TAPLINKER_BUCKETS`); `nextAvailableAt('history')` without an id
  reports the earliest lane.
- `RateLimiter` was rewritten around an explicit queue: `priority` calls jump queued ones (and a
  priority caller promotes a queued call it coalesces with); bookkeeping happens before the caller
  sees the result. `earliestAvailableAt(bucket)` added.
- Rate-limit errors are `LinkTapError` kind `rate_limit` (`isRateLimitError`). The poller treats
  them as "try next tick", not a failure.
- Running status: all strings; remaining = `onStamp` + `dur` - now (`onDuration` does not count
  down); `vol` "0" while running = unknown. Post-run status is `{dur}` and counts as idle
  (`isWateringStatus`).
- Poller: status polls take running outlets in turn (one per tick); a run closed by a status poll
  triggers `reconcileHistory(deviceId)` 5 s later (only while `start()`ed). `START_GRACE_MS` is
  now 60 s. `ingestWateringStatus` returns `{ closed }`.
- Executor: `Executor.confirmStart(device, sentAt)` returns `watering | idle | unknown` (first
  check after 20 s, second about 30 s later, then DB evidence via `hasStartEvidence` and a free
  history slot). `startVerified(executor, device, seconds, opts)` now takes an options object and
  returns `{ attempts, verified, startedAt, note }`; it re-sends only on `idle` twice within the
  first half of the planned run, and re-sends rate-limited starts. The engine records an
  unverified start as running with a `schedule.run_unverified` event (push "failed"), and uses
  the start's send time as the run's `startedAt`.
- Client bodies match the live ones: start sends `durationSec` only when non-zero and `eco*` only
  for cycle-and-soak; stop is exactly `{gatewayId, taplinkerId, action:false, duration:0}`.
- Mock: `MOCK_API_LIMITS` (status 30 s per taplinker with the live message, history per
  taplinker), live string-valued status, `{dur}` after a run, `startLatencyMs`, and commands answer
  `{"result":"ok","message":"success"}`.

**Known gaps**

- A scheduled start now holds the engine for 20 s (happy path) to about 50 s (unhappy path), and
  starts are sequential, so parallel zones start further apart than before.
- The status limit scope (account vs taplinker) and whether a rejected call resets LinkTap's
  window are not settled. `autoBack: true` (Hoseidon's default) was not exercised live.
- The running `watering` shape inside `getAllDevices` is still unseen.
- Manual "Run now" (`POST /devices/:id/run`) still does not verify the start.

## Cloudflare phase A: research + design (docs only)

**What exists**

- `docs/cloudflare.md`: the plan to run all of Hoseidon on the Workers Free plan. Free-plan
  facts checked against developers.cloudflare.com on 2026-11-22, the architecture (one Worker
  for static assets + edge checks, routing `/api` and `/hooks` to one SQLite-backed `Brain`
  Durable Object that runs the existing Hono app, a single alarm as the timer wheel, one cron
  watchdog), dependency replacements, a daily budget table, CPU hot spots with measured numbers,
  secrets, the Node → Workers migration plan and phases B–F.
- Key findings: `drizzle-orm@0.45.4` already ships `durable-sqlite` with a **sync** session and
  `transactionSync` transactions, so the query code can be shared with better-sqlite3 and the
  Node/Docker target stays. One always-on DO is 10,800 GB-s/day, under the 13,000 free, so
  duration can't run out with a single object. The binding limits are 100 k rows written/day
  (index entries and `setAlarm` count) and the 10 ms CPU budget (the DO limits page says 30 s,
  its FAQ says Worker limits apply; we design for 10 ms).
- Measured on the dev box (Node 24, mock LinkTap): device poll ~3 ms, engine tick ~1 ms, UI
  reads 0.2–1.4 ms, **network overview 17–41 ms (over budget, must be fixed before go-live)**,
  PBKDF2-SHA256 25 k iterations ~3.6 ms, scrypt N=2^15 64 ms, a push message ~0.5 ms.

**Known gaps**

- DO CPU limit on Free (10 ms vs 30 s), per-object storage on Free (1 GB vs 10 GB), whether cron
  runs count as requests, and FK enforcement on DO SQLite are unresolved in the docs; phase C
  measures them.
- `@simplewebauthn/server` and the planned WebCrypto push sender are untested in workerd.

## Cloudflare phase B: Worker + Brain (built, not deployed)

**What exists**

- `apps/worker`: the Cloudflare host. `wrangler.jsonc` (static assets from `apps/web/dist` with
  SPA fallback, `run_worker_first` for `/api/*` and `/hooks/*`, one SQLite-backed `Brain`
  Durable Object, cron `*/10 * * * *` watchdog, `nodejs_compat`, compat date 2026-11-01,
  `LINKTAP_MOCK=true`), `src/index.ts` (Worker + `Brain`), `src/edge.ts` (CSRF/Origin/body-size
  checks before a DO request is spent), `scripts/gen-migrations.mjs` → `src/migrations.gen.ts`,
  `src/worker-configuration.d.ts` (`wrangler types`), `.dev.vars.example`. Scripts: `dev`
  (workerd on :8799), `build` (= `wrangler deploy --dry-run --outdir dist`), `deploy`, `types`,
  `gen`, `test`.
- `apps/server/src/runtime/`: `wheel.ts` (the alarm's timer wheel: due times from persisted
  state, priority order, work budget per wake, `timers` table for one-offs) and `brain.ts`
  (`BrainCore`: the whole DO minus Cloudflare glue, tested on better-sqlite3).
- `apps/server/src/services.ts` builds the object graph for both hosts; `index.ts` (Node) uses
  it with `timers: 'node'` and now owns static serving and `getConnInfo`.
- `db/types.ts` (`Db` for any sync Drizzle SQLite), `db/ephemeral.ts` + migration
  `0006_durable_state` (`ephemeral`, `timers`): passkey challenges, OAuth state and the login
  throttle are persisted on both targets.
- `push/webpush.ts`: WebCrypto Web Push (RFC 8291 + 8292) replaces the `web-push` package (now a
  dev dependency). `auth/password.ts`: `pbkdf2$25000$…` alongside `scrypt$…`.
- `RateLimiter` persists `now + 20 s` before each call (store set) and the finish time after.
- Engine: in-process launch set; an interrupted launch (claimed, no run, not ours) is never
  re-sent: after 5 min it adopts the run LinkTap reported or fails.
- Config: `ENGINE_ENABLED` (Workers; default on with mock, off with real taps), `TZ`;
  `insecureConfig(config, { minAdminPassword })` (20 on Workers).
- Bundle (`wrangler deploy --dry-run`): 2,172 KiB, 409 KiB gzipped (Free limit 3 MB compressed).

**Conventions**

- Core files import `type { Db }` from `db/types`, never from `db` (that is Node-only:
  better-sqlite3). Anything Node-only (fs, `@hono/node-server`) stays in `index.ts`/`db/index.ts`.
- Core code is type-checked twice: by `apps/server` (@types/node) and by `apps/worker` (workerd
  runtime types + @types/node). Where the two disagree (WebCrypto details), type locally and
  loosely (see `push/webpush.ts`).
- Don't pass `globalThis.fetch` as an object property and call it as a method: workerd throws
  "Illegal invocation". Wrap it: `(input, init) => fetch(input, init)`.
- After `db:generate`, run `pnpm --filter @hoseidon/worker gen` (its build and tests fail on a
  stale `migrations.gen.ts`). After editing `wrangler.jsonc`, `pnpm --filter @hoseidon/worker types`.
- pnpm allowlist gained `workerd`. Docker builds only `@hoseidon/web` and `@hoseidon/server`.

**Known gaps**

- No real deploy yet and no CI deploy job (phase E). CI already runs the dry-run bundle in
  `pnpm build` and the workerd smoke test in `pnpm test`.
- Phase D is not done: no SQL meter / `/api/budget`, no snapshot retention or hourly rollups,
  materialize still runs every engine tick, and the network overview (17–41 ms) is still over the
  10 ms budget. Don't switch real taps on Workers before D.
- CPU per invocation on Cloudflare is unmeasured (local workerd doesn't enforce it).
- A start verification still waits inside the alarm (20–50 s, up to ~2 min with rate-limit
  retries); other due tasks wait behind it in that wake.
- Push dedupe (`recent`), the gcal debounce/backoff timer and LinkTap API stats are in memory on
  Workers: an eviction resets them (the periodic gcal pass catches up within 5 min).
- `PUBLIC_URL` adoption is first-origin-wins; moving to a custom domain needs the var set.
- WebAuthn is exercised in workerd only up to option generation (no authenticator in tests);
  the Google OAuth/Calendar path and `SecretBox` were not run in workerd.
- `@cloudflare/vitest-pool-workers` was not used (needs vitest 4, pins wrangler 4.124); the
  workerd tests use wrangler's `createTestHarness` instead.
