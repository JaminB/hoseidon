<div align="center">

# 🔱 Hoseidon

**God of the garden hose.**

A beautiful PWA for [LinkTap](https://www.link-tap.com) smart water timers. Runs free on
Cloudflare Workers, or on your own box with Docker.
Because the official app has the charm of a leaky faucet.

</div>

---

## Why

The LinkTap app is clunky, hides things, and is a nightmare to troubleshoot. Hoseidon is a calm,
modern dashboard that runs on your own box, talks to the LinkTap cloud API on your behalf, and
keeps your lawn alive without a single "Oops, something went wrong" toast.

## Features

> Hoseidon is under construction. Checked items exist today; the rest is on the roadmap.

- [x] Monorepo scaffold, Docker image, CI
- [x] A mock LinkTap server so you can develop without flooding your yard
- [x] LinkTap client with a rate-limit queue, a poller, a webhook receiver and a REST API
- [x] A calm, minimal web app (light and dark): Today timeline with live countdowns, device cards
      with battery, signal, alarms and one-tap quick runs, and a drag-to-create week calendar
- [x] Network monitoring over time: gateway uptime timelines, signal history, battery drain and days left, an offline incident log, LinkTap API health and a Diagnose checklist
- [x] A real scheduler engine: RRULE-based and DST-safe, one zone at a time per gateway,
      cycle-and-soak, skip rules, verified starts, and quick add ("every other day 6am front lawn 15m")
- [x] Weather-driven skips (rain, freeze, wind) and ET₀ scaling, from Open-Meteo
- [x] Google Calendar sync: schedules as recurring events in their own calendar, skipped runs
      greyed out with the reason, and (optionally) finished runs logged as past events
- [x] Per-sprinkler analytics next to weather: water vs rain/ET₀, run duration, flow, heatmap, skips, water saved
- [x] Installable PWA (offline shell, last-known data) with push notifications for alarms, offline devices and failed or skipped runs
- [x] Sign in with Google for invited accounts (admin-managed allowlist), or a single admin
      password when Google isn't set up; optional passkeys; CSRF-protected API
- [x] Runs on the Cloudflare Workers Free plan (one Worker, one SQLite Durable Object), or in Docker

## Stack

React + Vite + Tailwind v4 + TanStack Query on the front, Hono + Drizzle + SQLite on the back,
Zod schemas shared between them. The same server core runs in two hosts: a Cloudflare Worker
with one SQLite-backed Durable Object (`apps/worker`, the primary deployment) or one Node
process with one SQLite file (`apps/server`, Docker).

## Quick start (development)

Requires Node 24 and pnpm (`corepack enable`).

```sh
cp .env.example .env     # LINKTAP_MOCK=true by default, no real water is harmed
pnpm install
pnpm dev                 # server on :8787, web on :5173 (proxies /api)
```

Other scripts: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.

Visual smoke test (Playwright): `pnpm --filter @hoseidon/web exec playwright install chromium`
once, then `pnpm --filter @hoseidon/web e2e`. It boots its own mock server and dev server on
ports 8797 and 5179, seeds a few schedules, and saves screenshots of every page (phone and
desktop, light and dark) to `apps/web/e2e/__screenshots__/`. CI uploads them as an artifact.

## Deploying to Cloudflare Workers (recommended, free)

CI deploys on every merge to `main` (skipped until the Cloudflare token is set). Step-by-step
setup, secrets and free-tier guidance: [docs/deploy.md](docs/deploy.md).

Hoseidon fits the **Workers Free plan**: no paid plan, no paid add-ons, no credit card. One
Worker serves the built PWA as static assets and forwards `/api/*` and `/hooks/*` to a single
SQLite-backed Durable Object ("Brain") that runs the API, the poller, the scheduler, push and
Google sync off one alarm. A cron every 10 minutes is a watchdog. The design, limits and daily
budget are in [docs/cloudflare.md](docs/cloudflare.md).

```sh
pnpm install
pnpm build                                   # web app + `wrangler deploy --dry-run` bundle
cd apps/worker
pnpm exec wrangler login
# Secrets (never in wrangler.jsonc). Either Google sign-in (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
# ADMIN_EMAIL; see docs/deploy.md) or ADMIN_PASSWORD: 20+ random chars, e.g. openssl rand -base64 18
pnpm exec wrangler secret put ADMIN_PASSWORD
pnpm exec wrangler secret put SESSION_SECRET    # openssl rand -hex 32
pnpm exec wrangler secret put WEBHOOK_SECRET
pnpm exec wrangler deploy
```

It starts with `LINKTAP_MOCK=true` (fake taps). Open the `*.workers.dev` URL, sign in, look
around.

> **Keep `LINKTAP_MOCK=true` on Workers for now.** Real taps wait for phase D of
> [docs/cloudflare.md](docs/cloudflare.md) (budget meter, snapshot retention, a network overview
> under the 10 ms CPU budget) and the cutover in phase F. Until then, real watering runs on the
> Node/Docker target. As a safety net, with real taps the Worker keeps the poller and scheduler
> off unless `ENGINE_ENABLED` is `"true"`, and refuses to run with weak secrets.

Free-plan notes:

- `PUBLIC_URL` can stay unset: the first request's origin (your `*.workers.dev` URL) is adopted
  and remembered. Set it as a var for a custom domain (passkeys, push and Google OAuth are bound
  to it).
- Static assets are free and unlimited; only `/api` and `/hooks` count against the 100,000
  requests a day. A household uses roughly a tenth of every daily limit (see the budget in
  docs/cloudflare.md). Over a limit, Cloudflare returns errors until 00:00 UTC; it never bills.
- Every LinkTap rate limit is stored in the Durable Object before each call, so deploys and
  evictions can't make Hoseidon call LinkTap too early, and a deploy in the middle of a
  scheduled start never sends it twice.
- Local dev of the Worker: copy `apps/worker/.dev.vars.example` to `.dev.vars`, then
  `pnpm --filter @hoseidon/worker dev` (workerd on <http://localhost:8799>).

## Running with Docker

The Node target is kept for running on your own box.

```sh
cp .env.example .env     # fill in your values
docker compose up -d --build
```

Then open <http://localhost:8787>. Data lives in the `hoseidon-data` volume (SQLite).

## Configuration

See [`.env.example`](./.env.example) (Node) or `apps/worker/wrangler.jsonc` and
`apps/worker/.dev.vars.example` (Cloudflare: vars and secrets with the same names). Highlights:

| Variable                                    | What it does                                                                                                                                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LINKTAP_USERNAME` / `LINKTAP_API_KEY`      | Your LinkTap cloud credentials (link-tap.com, API section)                                                                                                                                      |
| `LINKTAP_MOCK`                              | `true` uses a fake LinkTap server. Set `false` for real hardware                                                                                                                                |
| `ADMIN_PASSWORD` / `SESSION_SECRET`         | The admin password (hashed with scrypt on Node, PBKDF2 on Workers; changing it signs everyone out) and a long random string. `SESSION_SECRET` also encrypts the Google token                    |
| `PUBLIC_URL` / `WEBHOOK_SECRET`             | Where LinkTap webhooks and Google OAuth call back                                                                                                                                               |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Optional Google sign-in (with `ADMIN_EMAIL`) and Google Calendar sync                                                                                                                           |
| `ADMIN_EMAIL`                               | Google sign-in: comma-separated Google accounts that are always admins. With `GOOGLE_CLIENT_ID`/`SECRET` it turns Google sign-in on and password sign-in off (`ADMIN_PASSWORD` is then ignored) |
| `ENGINE_ENABLED` / `TZ`                     | Cloudflare only: allow the poller and scheduler with real taps (off until `true`), and the default time zone                                                                                    |

### Signing in

Two modes, picked by configuration:

- **Google sign-in** (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `ADMIN_EMAIL` all set): the
  login page shows "Sign in with Google" (OpenID Connect with PKCE; the ID token's signature,
  issuer, audience, expiry, nonce and verified email are all checked). Only invited email
  addresses get in. The `ADMIN_EMAIL` accounts are always admins; an admin invites others
  (member or admin) and can remove or disable them, which signs them out at once. Password
  sign-in is off in this mode. Add `${PUBLIC_URL}/api/auth/google/callback` as an authorised
  redirect URI of the OAuth client (next to the Calendar one below); setup steps for Workers are
  in [docs/deploy.md](docs/deploy.md#6-google-sign-in-and-google-calendar).
- **Admin password** (otherwise, e.g. local dev and the mock): one admin signs in with
  `ADMIN_PASSWORD`.

In both modes a signed-in user can add a passkey for faster sign-in next time; it belongs to that
user and stops working if they are removed.

### Google Calendar sync

Hoseidon can put your schedules in Google Calendar: one recurring event per schedule, in a
calendar of its own called **🔱 Hoseidon**. It's one-way (Hoseidon → Google); edits made in Google
are overwritten. It asks for the narrow `calendar.app.created` scope, so it can only see the
calendar it made, never the rest of your account. Skipped runs show up greyed out with the
reason, and Settings can also log finished runs as past events.

You need your own (free) Google Cloud OAuth client. About ten minutes:

1. **Project.** Open <https://console.cloud.google.com/>, and create a project (e.g. "Hoseidon").
2. **Enable the API.** _APIs & Services → Library_, search for **Google Calendar API**, click
   **Enable**.
3. **Consent screen.** _APIs & Services → OAuth consent screen_ (called _Google Auth Platform_ in
   newer consoles):
   - User type **External**, app name "Hoseidon", your email as support and developer contact.
   - Scopes: add `https://www.googleapis.com/auth/calendar.app.created`.
   - Leave the publishing status on **Testing**.
   - **Test users / Audience:** add your own Google account. Only listed accounts can connect.
4. **OAuth client.** _APIs & Services → Credentials → Create credentials → OAuth client ID_:
   - Application type **Web application**.
   - **Authorized redirect URI:** `${PUBLIC_URL}/api/gcal/callback`, for example
     `https://hose.example.com/api/gcal/callback`. Settings shows the exact value to copy.
5. **Configure Hoseidon.** Put the client ID and secret in `.env`, check that `PUBLIC_URL` is the
   address you open Hoseidon at and that `SESSION_SECRET` is a long random string, then restart:

   ```sh
   GOOGLE_CLIENT_ID=1234-abc.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-...
   PUBLIC_URL=https://hose.example.com
   SESSION_SECRET=<output of: openssl rand -hex 32>
   ```

6. **Connect.** _Settings → Google Calendar → Connect Google Calendar_. Google will warn that the
   app isn't verified (it's yours, in Testing mode): choose _Continue_.

**The weekly reconnect.** Google expires the access of apps in Testing mode after 7 days. When that
happens Hoseidon pauses the sync and shows a "reconnect" banner; one click on **Reconnect** picks up
the same calendar and catches up. To avoid it, set the app to "In production" on the consent
screen. The console tells you whether Google wants to verify the app first; until it does, you'll
keep seeing the unverified-app warning when you connect.

**Development.** With `pnpm dev`, set `PUBLIC_URL=http://localhost:5173` (Vite proxies `/api` to
the server) and register `http://localhost:5173/api/gcal/callback` as a second redirect URI.

The refresh token is stored encrypted (AES-256-GCM, key derived from `SESSION_SECRET`). Changing
`SESSION_SECRET` means reconnecting. See [docs/gcal.md](docs/gcal.md) for how the sync works.

### Cloudflare Tunnel (Docker only: webhooks, push, off-LAN access)

Not needed on Workers. For Docker: create a tunnel, set `CLOUDFLARE_TUNNEL_TOKEN`, and start the
optional profile with `docker compose --profile tunnel up -d`.

### Schedules

LinkTap's cloud API can't store watering plans, so Hoseidon keeps its own schedules and starts
timed instant runs itself. If a timer still has a plan from the LinkTap app, the schedule shows a
warning, because otherwise that zone gets watered twice. Switch those timers to manual in the
LinkTap app. See [docs/scheduler.md](docs/scheduler.md) for how runs are planned, skipped and
verified.

### LinkTap webhooks

Set `WEBHOOK_SECRET` to a long random string, then register
`${PUBLIC_URL}/hooks/linktap/${WEBHOOK_SECRET}` with LinkTap's `setWebHookUrl`. Leaving the secret
blank disables the endpoint. See [docs/linktap-api.md](docs/linktap-api.md) for everything the
LinkTap API can (and can't) do.

## Safety note

LinkTap's API is rate limited (5 min for device lists, 15 s for commands) and controls real
water. Keep `LINKTAP_MOCK=true` until you mean it.

## License

[MIT](./LICENSE). Weather data by [Open-Meteo](https://open-meteo.com), CC BY 4.0.
