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
- [ ] Device and network monitoring (gateways, timers, battery, signal, alarms)
- [x] A real scheduler engine: RRULE-based and DST-safe, one zone at a time per gateway,
      cycle-and-soak, skip rules, verified starts, and quick add ("every other day 6am front lawn 15m")
- [ ] Weather-driven skips (rain, freeze, wind) and ET₀ scaling (the rules exist; the forecast
      arrives with the weather phase)
- [ ] Google Calendar sync
- [ ] Per-sprinkler analytics next to weather (rain, ET0, soil moisture)
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

## Running with Docker

```sh
cp .env.example .env     # fill in your values
docker compose up -d --build
```

Then open <http://localhost:8787>. Data lives in the `hoseidon-data` volume (SQLite).

## Configuration

See [`.env.example`](./.env.example). Highlights:

| Variable                                    | What it does                                                     |
| ------------------------------------------- | ---------------------------------------------------------------- |
| `LINKTAP_USERNAME` / `LINKTAP_API_KEY`      | Your LinkTap cloud credentials (link-tap.com, API section)       |
| `LINKTAP_MOCK`                              | `true` uses a fake LinkTap server. Set `false` for real hardware |
| `ADMIN_PASSWORD` / `SESSION_SECRET`         | Single-household login                                           |
| `PUBLIC_URL` / `WEBHOOK_SECRET`             | Where LinkTap webhooks and Google OAuth call back                |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Optional Google Calendar sync                                    |

### Google OAuth (Calendar sync)

_Coming soon._ This section will walk through creating a Google Cloud project, enabling the
Calendar API, and creating an OAuth client with the `calendar.app.created` scope.

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

[MIT](./LICENSE). Weather data (later) by [Open-Meteo](https://open-meteo.com), CC BY 4.0.
