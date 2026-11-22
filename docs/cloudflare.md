# Hoseidon on Cloudflare Workers (free plan)

Status: **design** (phase A). Nothing here is built yet. The goal is to run the whole app on
Cloudflare Workers within the **Workers Free plan**: no Workers Paid, no paid add-ons, and no
key-value-backed Durable Objects. CI deploys on every merge to `main`.

The Node/Docker target stays. Both targets share one core (see [Keeping Node](#keeping-the-nodedocker-target)).

## Free-plan facts (checked 2026-11-22)

Sources: developers.cloudflare.com `workers/platform/limits`, `workers/platform/pricing`,
`durable-objects/platform/limits`, `durable-objects/platform/pricing`, `durable-objects/api/alarms`,
`durable-objects/api/sqlite-storage-api`, `workers/static-assets` (+ billing page),
`workers/configuration/cron-triggers`, `workers/runtime-apis/nodejs` (+ `crypto`), and
orm.drizzle.team `connect-cloudflare-do`. Re-check them before relying on an edge case.

| Limit                   | Free plan                                                                                                                                                                                                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Worker requests         | 100,000/day, reset 00:00 UTC. Over the limit: error 1027, and `run_worker_first` routes get 429 while static assets keep serving                                                                                                                                                                                                                 |
| Worker CPU              | 10 ms per HTTP request and per Cron Trigger invocation                                                                                                                                                                                                                                                                                           |
| Subrequests             | 50 per invocation (1,000 to Cloudflare services); 6 simultaneous outgoing connections                                                                                                                                                                                                                                                            |
| Memory / startup / size | 128 MB per isolate, 1 s startup, 64 MiB Worker (uncompressed)                                                                                                                                                                                                                                                                                    |
| Cron Triggers           | 5 per account, UTC, 10 ms CPU, 15 min wall. Trigger changes take up to 15 min to propagate                                                                                                                                                                                                                                                       |
| Env vars + secrets      | 64 per Worker, 5 KB each                                                                                                                                                                                                                                                                                                                         |
| Static assets           | Free and unlimited requests; 20,000 files per version, 25 MiB per file. Asset hits don't run the Worker                                                                                                                                                                                                                                          |
| Durable Objects         | **SQLite-backed only** (`new_sqlite_classes`); 100 classes                                                                                                                                                                                                                                                                                       |
| DO requests             | 100,000/day. Counts HTTP requests, RPC sessions, WebSocket messages (20:1) **and alarm invocations**                                                                                                                                                                                                                                             |
| DO duration             | 13,000 GB-s/day, billed at a fixed 128 MB while active (or idle but unable to hibernate)                                                                                                                                                                                                                                                         |
| DO SQLite rows          | **5 M read/day, 100 k written/day**. Every index entry updated counts as an extra row written; deletes count; each `setAlarm()` is one row written                                                                                                                                                                                               |
| DO storage              | 5 GB per account. Per object the docs disagree (table: 10 GB; FAQ: "1 GB on the Free plan"): **plan for 1 GB**                                                                                                                                                                                                                                   |
| DO SQL                  | 100 KB statements, 100 bound params, 100 columns, 8 MB rows; no `BEGIN`/`SAVEPOINT` in `exec` (use `transactionSync`)                                                                                                                                                                                                                            |
| DO CPU                  | Limits page: 30 s per request (reset by each request). Its FAQ also says DOs "have the same per invocation CPU limits as any Workers do". **We design for 10 ms** per request/alarm and treat 30 s as a bonus                                                                                                                                    |
| Over a DO daily limit   | "further operations of that type will fail with an error" until 00:00 UTC. No surprise bill on Free                                                                                                                                                                                                                                              |
| Alarms                  | One per object; `setAlarm` replaces. At-least-once, one `alarm()` at a time. An uncaught throw retries with backoff from 2 s, up to 6 times, then stops until the next `setAlarm`. 15 min wall per run. After eviction the constructor runs before `alarm()`                                                                                     |
| `nodejs_compat`         | On by default from compat date 2026-08-04 (set the flag anyway). `node:crypto` is supported except argon2, DSA/DH keygen, ed448/x448, `randomUUIDv7`; so `scrypt`, `createCipheriv('aes-256-gcm')`, `hkdfSync`, `createHash`, `randomBytes`, `timingSafeEqual` all exist. `node:https` exists but the `web-push` stack is not a safe bet (below) |
| Drizzle                 | `drizzle-orm/durable-sqlite` ships in our pinned `drizzle-orm@0.45.4`. Its session is **`'sync'`** and `transaction()` maps to `ctx.storage.transactionSync`: the same shape as better-sqlite3. `migrate(db, {journal, migrations})` from `drizzle-orm/durable-sqlite/migrator`, run in `blockConcurrencyWhile`                                  |

Two consequences drive the whole design:

1. **Duration can't run out.** One object that never sleeps uses 86,400 s × 0.125 GB =
   10,800 GB-s/day, under 13,000. That holds only while there is exactly **one** object.
2. **Rows written (100 k/day) and CPU per invocation (10 ms) are the real limits.** Everything
   below is shaped around them.

## Architecture

```
browser (PWA) ──► Worker "hoseidon" ──static──► assets (apps/web/dist, SPA fallback)  [free]
                    │  run_worker_first: /api/*, /hooks/*
                    │  cheap edge checks (CSRF header + Origin on mutations, 404s, size caps)
                    ▼  stub.fetch(request)   (idFromName("brain"), always the same object)
             Durable Object "Brain" (SQLite)
                    ├─ Hono app (today's createApp routes, unchanged)
                    ├─ drizzle(ctx.storage) – all tables, migrations on construct
                    ├─ alarm(): the one timer – poller, engine tick, verify steps,
                    │           history reconcile, gcal queue, push flush
                    └─ outbound fetch: LinkTap, Open-Meteo, Google, push services
cron "*/10 * * * *" ──► Worker.scheduled ──► Brain.ensureAlarm()   (watchdog)
```

- **One Worker** serves the built web app as static assets (`not_found_handling:
"single-page-application"`) and runs only for `/api/*` and `/hooks/*`. Asset requests are free
  and don't count against the 100 k requests. The Worker does no state work: it rejects obvious
  junk (mutating `/api` call without `x-hoseidon-csrf` or with a foreign `Origin`) so it never
  costs a DO request, then forwards to the Brain. `CF-Connecting-IP` is trusted (the
  `TRUST_PROXY` rule becomes always-on).
- **One Durable Object, "Brain"**, owns all state and all logic. A single object matches the
  domain: one household, LinkTap's limits are per account, and the engine already assumes one
  process. Requests are serialized by the DO's input gates, which is the same guarantee Node's
  single thread gives today.
- **The existing Hono app runs inside the DO** (`fetch(request) → app.fetch(request)`). Routes,
  zod DTOs and the CSRF/session guard move over as they are. Auth lives in the DO because
  sessions are in its SQLite. Use HTTP forwarding, not RPC: one Worker request = one DO request
  either way, and it keeps the app testable with `app.request` in Node.
- **Alarms replace `setInterval`/`setTimeout`.** See [Timers](#timers-alarm-scheduler).
- **One Cron Trigger** (`*/10 * * * *`, 144/day) is a watchdog: it calls `ensureAlarm()`, which
  re-arms the alarm if `getAlarm()` is `null` (after six failed retries an alarm stays dead) or
  is overdue by more than 2 min. It never polls LinkTap itself.

### Timers (alarm scheduler)

The DO has one alarm. `Brain.alarm()` runs a small in-process timer wheel:

1. Compute each recurring task's next due time **from state that is already persisted**, so no
   extra rows are written per tick:
   - device poll: `linktap.lastCall[devices] + 5 min` (the rate-limit store already persists it)
   - status poll: only while a run is open; per outlet `lastCall[status:<id>] + 31 s`, one
     outlet per wake, round-robin as today
   - history: `lastCall[history:<id>] + 10 min`, one device per wake
   - engine tick: every 30 s while a planned run is due within 2 min or running, else with the
     device poll. `materialize` (48 h ahead) at most hourly
   - push flush: when `max(events.id) > push.cursor`
   - gcal: when its persisted `pending`/`backoffUntil` says so, plus the 5 min periodic pass
2. One-off delayed steps (executor verify at +20 s / +50 s, history reconcile at +5 s, gcal
   debounce at +3 s, a re-sent rate-limited start at +16 s) go in a tiny `timers` table
   (`key` PK, `due_at`, `payload`). Keyed upserts make them idempotent; at-least-once alarms make
   a duplicate run possible, so each step must be safe to repeat (they already check state first).
3. Run due tasks in priority order (verify/start > status > engine > devices > history > push >
   gcal), **at most one LinkTap call and a bounded amount of work per wake**, then
   `setAlarm(min(next due))`. `alarm()` catches everything and always re-arms, so the built-in
   six-retry cut-off never strands the schedule.

The LinkTap rate limits stay exactly as live-verified (getAllDevices 5 min account-wide,
commands 15 s account-wide, getWateringStatus 31 s per taplinker, history 10 min per taplinker).
`RateLimiter` already persists `lastCall` per lane; on Workers the store is the DO's `settings`
table, written **before** the call goes out (conservative: a call killed mid-flight by an
eviction or deploy still counts). The in-memory queue keeps working inside one DO lifetime; after
an eviction it restarts empty and the persisted times still gate the next call. Background work
never sleeps on a lane: if a lane is busy it sets its next due time instead. Interactive commands
(`POST /devices/:id/run`) may wait in the request (no CPU while awaiting a timer; DO requests
have no wall limit while the client is connected) or return `nextCommandAt` as now.

`Date.now()` in Workers only advances across I/O, so **work per invocation is bounded by count,
never by elapsed time**.

**Deploys restart the object.** Every merge to `main` evicts the Brain; alarms survive. A
scheduled start therefore persists a `launching` marker on its planned run before sending the
command. On construct, a `launching` row goes to the verify path (status / evidence / history),
never straight to a re-send, so a deploy can't double-water a zone.

## Replacing Node dependencies

| Node piece                           | Workers replacement                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `better-sqlite3`                     | `drizzle-orm/durable-sqlite` on `ctx.storage`. Same sync query API. Only `auth/service.ts` reads `.run().changes`; switch it to `.returning()`. `openDb`'s pragmas and phase-0 cleanup stay Node-only. Migrations: reuse `apps/server/drizzle/*.sql`; a build step writes `migrations.js` (journal + SQL as text, wrangler `rules: Text **/*.sql`). No migration uses `PRAGMA`; FK enforcement on DO SQLite is assumed on (as in D1) – verify in phase B |
| `scrypt` (passwords)                 | Supported by `nodejs_compat` but N=2^15 costs **64 ms** – over budget. Use WebCrypto **PBKDF2-SHA256, 25,000 iterations** (`pbkdf2$25000$salt$hash`). See [CPU](#cpu-hot-spots). Node keeps scrypt; the verifier accepts both schemes. Hashes are never migrated: each target derives its own from `ADMIN_PASSWORD`, which on Workers must be a generated ≥ 20-char secret                                                                               |
| `web-push`                           | Imports `node:https`, `https-proxy-agent`, `asn1.js`, `jws`, `http_ece`. Replace with a ~150-line WebCrypto sender: VAPID ES256 JWT (RFC 8292) + `aes128gcm` payload (RFC 8291/8188) + `fetch`. Import the stored VAPID keys (web-push's raw base64url format) as JWK, so no subscription breaks. Node uses the same code (WebCrypto is global in Node 24); `web-push` stays a dev dependency to cross-check in tests                                    |
| `node:crypto` AES-GCM / HKDF / hash  | Supported under `nodejs_compat`, so `SecretBox`, OAuth PKCE and the webhook secret compare can stay. Move to WebCrypto only where it is free to (new code)                                                                                                                                                                                                                                                                                               |
| `@simplewebauthn/server@14`          | Pure JS over `globalThis.crypto` (`getWebCrypto` stub); no `node:crypto`. Expected to run; prove it with a registration + authentication round trip in the workerd test pool (phase B)                                                                                                                                                                                                                                                                   |
| `rrule`, `open-location-code`, `zod` | Pure JS. `Intl` time zones work in workerd. `TZ` env doesn't exist: the zone comes from the `app.timeZone` setting (then gateway zones), default `UTC`                                                                                                                                                                                                                                                                                                   |
| `@hono/node-server`, `serveStatic`   | Node entry only. Workers: static assets binding                                                                                                                                                                                                                                                                                                                                                                                                          |
| In-memory state                      | Must survive eviction: login throttle, passkey challenges and gcal OAuth `state` go to small tables (with expiry). LinkTap API stats may stay in memory (they reset on deploy; documented)                                                                                                                                                                                                                                                               |

## Keeping the Node/Docker target

Kept, because it is cheap: the DO driver is sync like better-sqlite3, so the query code doesn't
change. The core (`apps/server/src` minus `index.ts`, `db/index.ts`, static serving) will depend on:

- `Db = BaseSQLiteDatabase<'sync', unknown, typeof schema>` (both drivers satisfy it),
- a `Clock` (`now()`) and a `Timers` port (`schedule(key, at, payload)`, `cancel(key)`) with two
  implementations: `setTimeout`-driven in Node, alarm-driven in the DO,
- WebCrypto (`crypto.subtle`, global in Node 24 and workerd) plus the `node:crypto` subset above.

Entries: `apps/server/src/index.ts` (Node, unchanged behaviour) and a new `apps/worker`
(`wrangler.jsonc`, `src/index.ts` Worker + `Brain` DO) that imports the core. Vitest keeps running
the core on better-sqlite3; a small `@cloudflare/vitest-pool-workers` suite covers the DO
(alarm loop, migrations, WebAuthn, push encryption). If that pool doesn't support our vitest
major, fall back to `wrangler dev` + HTTP smoke tests in CI.

Never run both targets against the real LinkTap account at once: limits are per account and two
engines would double-water.

## Free-tier budget

Household: 1 gateway, 4 outlets, 3 schedules, 2 h of watering per day (twice the expected
~1 h), two clients with the PWA open 12 h/day each (gateways every 60 s, 10 s while watering;
planned runs every 30 s; events every 60 s), ~300 webhooks/day, and the cadence above.
Write counts include index entries. "Measured" CPU is wall time on the dev box (Node 24, x64,
better-sqlite3 in memory, mock LinkTap) for the existing code; workerd should be the same order.

| Path (per day)                                   |  Count | Worker req |      DO req | Rows written |  Rows read | CPU each (measured)    |
| ------------------------------------------------ | -----: | ---------: | ----------: | -----------: | ---------: | ---------------------- |
| UI API calls                                     | ~8,000 |      8,000 |       8,000 |       ~0.2 k |     ~400 k | 0.2–1.4 ms             |
| Webhooks                                         |   ~300 |        300 |         300 |       ~1.5 k |      ~15 k | <1 ms                  |
| Cron watchdog (`*/10`)                           |    144 |        144 |         144 |            0 |          0 | <1 ms                  |
| Alarm wakes (30 s worst case + one-offs)         | ~3,100 |          – |       3,100 |  3,100 (set) |          – | –                      |
| ├ device poll (5 min)                            |    288 |          – |           – |       ~5.8 k |      ~15 k | 3.3 ms (mock incl.)    |
| ├ status poll (31 s, while watering)             |   ~232 |          – |           – |       ~1.4 k |      ~10 k | ~1 ms                  |
| ├ history (10 min, one device)                   |    144 |          – |           – |       ~0.7 k |      ~15 k | ~1 ms                  |
| ├ engine tick                                    | ≤2,880 |          – |           – |       ~0.5 k |     ~290 k | 1.0 ms idle            |
| └ push, gcal, weather, events                    |      – |          – |           – |       ~0.6 k |      ~20 k | ~0.5 ms/push msg       |
| Network/analytics views (20/day, 30-day windows) |     20 |    (in UI) |           – |            0 |     ~800 k | **17–41 ms** (network) |
| Snapshot retention prune                         |      1 |          – |           – |       ~2.3 k |       ~3 k | batched                |
| **Total**                                        |        | **~8.5 k** | **~11.5 k** |    **~16 k** | **~1.6 M** |                        |
| **Free limit**                                   |        |  100 k/day |   100 k/day |    100 k/day |    5 M/day | 10 ms                  |
| **Headroom**                                     |        |       ~12× |         ~9× |          ~6× |        ~3× | network view: **over** |

- **Duration**: expected ~0.5–1.5 k GB-s/day (an alarm wake is active for one LinkTap round trip,
  roughly 0.5–2 s; between wakes the object can hibernate). Worst case, never idle: 10,800 GB-s
  (83%). Safe only with one object: always `idFromName("brain")`, no per-user objects, and no
  long-running `wrangler dev --remote` sessions against production.
- **Storage**: snapshots are the only growing table (4 × 288 rows/day, ~1 KB each with `raw`
  JSON ≈ 1.2 MB/day). Keep raw 5-minute rows 30 days, drop `raw` after 7, roll older rows up to
  hourly. That stays well under 1 GB per object and also caps the rows a 30-day query reads.
- **Subrequests** (50/invocation): an alarm wake makes ≤ 1 LinkTap call, ≤ 2 Open-Meteo calls,
  ≤ 30 Google calls (gcal `applyOps` is chunked across wakes), ≤ 10 push sends (more continue next
  wake). A Worker request makes 1 (the DO call).

### Guardrails

- **Meter**: wrap `ctx.storage.sql.exec` before handing `ctx.storage` to Drizzle and add each
  cursor's `rowsRead`/`rowsWritten` to per-UTC-day counters (in memory, flushed every 10 min into
  `settings`). Count DO requests and alarm wakes the same way. `GET /api/budget` and the Settings
  page show them against the limits; crossing 50% of any limit writes one `budget.warn` event
  (pushed as an alert).
- **Degrade, don't fail**: past 80% of rows written, history polling and snapshot writes back off
  (snapshot only on change or every 15 min); commands, status polls and the engine never back off.
- Watch `wrangler tail` and the dashboard's CPU time per invocation during phase B and after
  every feature that touches a hot path.

## CPU hot spots

| Hot spot                                            | Measured / estimated                                                                                         | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/network/overview` (and per-device views)  | 17 ms (1 day), 18 ms (7 days), 41 ms (30 days) with 30 days of snapshots                                     | Must fix before go-live. The 1-day number shows it scans more than its window: profile first. Then an hourly rollup table written by ingest (one upsert per device per hour) and timeline/uptime computed from rollups + events; cache per data version                                                                                                                                                                                                                 |
| PBKDF2 login                                        | WebCrypto PBKDF2-SHA256: 10 k → 1.8 ms, 25 k → 3.6 ms, 50 k → 9.2 ms, 100 k → 16.6 ms. scrypt N=2^15 → 64 ms | 25,000 iterations (~4 ms, 2× margin). That is far below OWASP's 600 k and weak against **offline** guessing if the hash ever leaks (throttling doesn't help there), so the strength must come from the secret: on Workers require a generated `ADMIN_PASSWORD` (≥ 20 random chars, e.g. `openssl rand -base64 18`) and refuse shorter ones in `insecureConfig`; never export or import the hash (each target re-derives it from `ADMIN_PASSWORD`); offer passkeys first |
| History normalization                               | One device's history per call, ~1 ms                                                                         | Keep one device per wake                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| rrule expansion (engine materialize, preview, gcal) | Preview 0.8 ms; engine tick 1.0 ms idle                                                                      | Materialize at most hourly (and on schedule edits), not every tick; FREQ faster than DAILY is already rejected                                                                                                                                                                                                                                                                                                                                                          |
| Analytics (`/api/analytics/*`, 90 d / 1 y)          | Summary 0.6 ms on little data; grows with runs (~4.4 k runs/year)                                            | Aggregate in SQL (`GROUP BY` day), keep weekly folding for > 120 days, cap at 1 year; add a daily rollup if it crosses ~5 ms                                                                                                                                                                                                                                                                                                                                            |
| Push dispatch                                       | ~0.5 ms per message (ECDH + AES-GCM + ES256, measured)                                                       | ≤ 10 per wake                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| gcal full resync                                    | Diff + JSON for tens of events, a few ms; many subrequests                                                   | Chunk `applyOps` (≤ 30 ops per wake), persist the cursor of remaining ops                                                                                                                                                                                                                                                                                                                                                                                               |
| Migrations on first construct                       | One-off                                                                                                      | Inside `blockConcurrencyWhile`; if 10 ms ever bites, the 30 s DO figure applies to this path in practice                                                                                                                                                                                                                                                                                                                                                                |

## Secrets and config

Wrangler secrets (`wrangler secret put`): `LINKTAP_USERNAME`, `LINKTAP_API_KEY`, `ADMIN_PASSWORD`,
`SESSION_SECRET`, `WEBHOOK_SECRET`, `GOOGLE_CLIENT_SECRET`.

Plain vars (`wrangler.jsonc`): `PUBLIC_URL` (the `*.workers.dev` URL or a custom domain on a free
Cloudflare zone; must be https for passkeys, push and the webhook), `LINKTAP_MOCK`,
`GOOGLE_CLIENT_ID`, `ENGINE_ENABLED` (kill switch for the poller + engine, default `false` until
cutover).

Generated and stored in the DO: VAPID keys (`push.vapid`), sessions, passkeys.

GitHub Actions secrets: `CLOUDFLARE_API_TOKEN` (Workers Scripts: Edit only), `CLOUDFLARE_ACCOUNT_ID`.
The app secrets are set once by hand with `wrangler secret put`; CI never sees them. The existing
`insecureConfig` check runs on DO construct and refuses to enable the engine with weak secrets.

## Migration plan (Node → Workers)

1. Deploy with `LINKTAP_MOCK=true`, `ENGINE_ENABLED=false`. Check login, UI, budget page.
2. Rehearse the import (below) against this mock deployment, then wipe it.
3. Cutover:
   1. **Stop the Node instance** (no more writes, no more LinkTap calls), then take the final
      export from its SQLite: a script that writes JSON per table.
   2. Import through `POST /api/admin/import` (chunked, ≤ 100 bound params per statement):
      gateways, devices, schedules, planned runs (future only), settings except
      `linktap.lastCall` and `auth.*` (the password hash is re-derived from `ADMIN_PASSWORD`,
      never copied), push subscriptions, gcal account + events, runs and events. Skip sessions
      and passkeys (below). Snapshots: last 7 days only (~8 k rows ≈ 16 k writes); more would eat
      the daily write budget. Keeping `SESSION_SECRET` keeps the encrypted Google token valid.
   3. Wait out the 5 min devices window, set the real secrets, `LINKTAP_MOCK=false`,
      `ENGINE_ENABLED=true`.
   4. Re-point integrations: register the LinkTap webhook at the new `PUBLIC_URL`, add the new
      Google OAuth redirect URI (keep the old one listed for rollback).
   5. On each phone: sign in with the password, register a new passkey (passkeys are bound to the
      RP ID, i.e. the hostname, so old ones only carry over if the hostname stays the same) and
      re-enable push (the origin changes, so old subscriptions don't move).
4. Rollback: `ENGINE_ENABLED=false` on Workers, then re-register the LinkTap webhook at the Node
   URL, switch clients back to the Node URL, and start Node on its kept DB file. Schedule edits
   made on Workers after cutover are re-applied by hand (export `/api/schedules` first); run and
   event history from the Workers period is lost to Node unless exported the same way.

## Phased task list

- **B. Core seams** (no behaviour change): `Db` sync type, `Clock`, `Timers` port; move Node-only
  bits out of the core; `.changes` → `.returning()`; WebCrypto push sender (tests against
  `web-push`); password scheme `pbkdf2` alongside `scrypt`; persist login throttle, passkey
  challenges and OAuth state; `launching` marker on planned runs. Node stays green.
- **C. Worker + Brain**: `apps/worker` with wrangler config (assets, `run_worker_first`,
  `new_sqlite_classes: ["Brain"]`, one cron, `nodejs_compat`, pinned compat date), migrations
  bundle, alarm scheduler, edge checks, workerd test pool (alarm loop, rate-limit persistence
  across a simulated eviction, WebAuthn, migrations).
- **D. Budget**: sql meter, `/api/budget`, Settings card, `budget.warn`, snapshot retention and
  hourly rollups, network overview rewrite under 10 ms, materialize hourly.
- **E. CI/CD**: deploy job on push to `main` (after lint/typecheck/test/build) with
  `cloudflare/wrangler-action`, pinned wrangler; PRs run `wrangler deploy --dry-run`. Docs:
  README section, `.env.example`/`wrangler.jsonc` notes.
- **F. Cutover**: import tooling, mock-mode soak for a few days while watching the budget, then
  the migration plan above.

## Open questions

- Which DO CPU limit really applies on Free (10 ms vs 30 s). Measure in phase C; the design
  assumes 10 ms.
- Per-object storage on Free (1 GB vs 10 GB). Retention keeps us far below 1 GB either way.
- Whether cron invocations count as Worker requests (budgeted as if they do).
- FK enforcement and `ON DELETE CASCADE` behaviour on DO SQLite (assumed same as D1: always on).
