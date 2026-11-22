<div align="center">

# 🔱 Hoseidon

**God of the garden hose.**

A beautiful, self-hosted PWA for [LinkTap](https://www.link-tap.com) smart water timers.
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
- [ ] Installable PWA with push notifications for alarms and offline devices

## Stack

React + Vite + Tailwind v4 + TanStack Query on the front, Hono + Drizzle + SQLite on the back,
Zod schemas shared between them. One Docker container, one SQLite file. No cloud of our own.

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

## Running with Docker

```sh
cp .env.example .env     # fill in your values
docker compose up -d --build
```

Then open <http://localhost:8787>. Data lives in the `hoseidon-data` volume (SQLite).

## Configuration

See [`.env.example`](./.env.example). Highlights:

| Variable                                    | What it does                                                                        |
| ------------------------------------------- | ----------------------------------------------------------------------------------- |
| `LINKTAP_USERNAME` / `LINKTAP_API_KEY`      | Your LinkTap cloud credentials (link-tap.com, API section)                          |
| `LINKTAP_MOCK`                              | `true` uses a fake LinkTap server. Set `false` for real hardware                    |
| `ADMIN_PASSWORD` / `SESSION_SECRET`         | Single-household login. `SESSION_SECRET` also encrypts the Google token (16+ chars) |
| `PUBLIC_URL` / `WEBHOOK_SECRET`             | Where LinkTap webhooks and Google OAuth call back                                   |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Optional Google Calendar sync                                                       |

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

### Cloudflare Tunnel (webhooks, push, off-LAN access)

_Coming soon._ This section will cover creating a tunnel, setting `CLOUDFLARE_TUNNEL_TOKEN`, and
starting the optional profile with `docker compose --profile tunnel up -d`.

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
