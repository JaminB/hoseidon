# LinkTap API: what it can and can't do

This is Hoseidon's working reference for the LinkTap APIs. It collects the official docs, the
gateway MQTT integration guide, and what community integrations (homebridge, openHAB) have found
in practice. Anything marked **unverified** is inferred and should be confirmed against a real
account during the live smoke test. When it is confirmed, update this file and the matching
constant in `apps/server/src/linktap/`.

## Contents

- [Cloud API](#cloud-api)
- [Endpoints](#endpoints)
- [Data shapes](#data-shapes)
- [Rate limits](#rate-limits)
- [Webhooks](#webhooks)
- [Local gateway API (HTTP / MQTT)](#local-gateway-api-http--mqtt)
- [What is not possible](#what-is-not-possible)
- [Gotchas](#gotchas)
- [How Hoseidon uses it](#how-hoseidon-uses-it)
- [Sources](#sources)

## Cloud API

- Base URL: `https://www.link-tap.com/api/<endpoint>`.
- Every call is an HTTP `POST` with a JSON body. The body always includes `username` and `apiKey`.
  You get the key from link-tap.com under the API section, or from the `getApiKey` call.
- CORS is `*`, but the API key must never reach the browser. Hoseidon calls LinkTap only from
  the server.
- Success: `{"result":"ok", ...}`.
- Failure: `{"result":"error","message":"..."}`. Rate-limit violations come back the same way, as
  an error with a "too frequently" message.

### IDs

| Id                  | Format                                      | Notes                                                    |
| ------------------- | ------------------------------------------- | -------------------------------------------------------- |
| `gatewayId`         | 16 hex chars                                | Some UIs show a longer string; always send the first 16. |
| `taplinkerId`       | 16 hex chars                                | One per TapLinker / ValveLinker.                         |
| Multi-outlet outlet | 18 chars: `<16>_<n>`, e.g. `..._1`, `..._2` | ValveLinker outlets are listed as separate taplinkers.   |

Some endpoints only accept the 16-char base id. The docs don't say which ones, so this is
**unverified**. Hoseidon sends the gateway id as 16 chars everywhere and keeps the `_n` suffix
on taplinker ids, because commands have to target a single outlet. The ID mapping lives in one
place (`ids()` in `client.ts`) so it is easy to change.

## Endpoints

| Endpoint                              | Purpose                                                | Key params                 |
| ------------------------------------- | ------------------------------------------------------ | -------------------------- |
| `getAllDevices` (alias `listDevices`) | All gateways, with their taplinkers and live state.    | none                       |
| `getWateringStatus`                   | The live run on one taplinker.                         | `taplinkerId`              |
| `getWateringHistory`                  | The last 30 days of runs for one taplinker.            | `taplinkerId`              |
| `activateInstantMode`                 | Start or stop watering now.                            | see below                  |
| `activateIntervalMode`                | Switch to the Interval plan set up in the LinkTap app. | `gatewayId`, `taplinkerId` |
| `activateOddEvenMode`                 | Switch to the Odd-even plan.                           | same                       |
| `activateSevenDayMode`                | Switch to the 7-day plan.                              | same                       |
| `activateMonthMode`                   | Switch to the Month plan.                              | same                       |
| `activateCalendarMode`                | Switch to the Calendar plan (newer firmware).          | same                       |
| `pauseWateringPlan`                   | Pause the active plan.                                 | `pauseDuration`            |
| `dismissAlarm`                        | Clear an alarm flag.                                   | `alarm`                    |
| `setWebHookUrl` / `deleteWebHookUrl`  | Register or remove the account's webhook.              | `webHookUrl`               |
| `getApiKey`                           | Get the API key from a username and password.          | `username`, `password`     |

### `activateInstantMode`

| Param                      | Type                | Notes                                                |
| -------------------------- | ------------------- | ---------------------------------------------------- |
| `gatewayId`, `taplinkerId` | string              |                                                      |
| `action`                   | bool                | `true` starts watering, `false` stops it.            |
| `duration`                 | int minutes, 1–1439 | Send `0` when `action=false`.                        |
| `durationSec`              | int, 0–59           | Extra seconds. Only S models honour it.              |
| `eco`                      | bool                | Turns on cycle-and-soak.                             |
| `ecoOn`, `ecoOff`          | minutes             | How long each water and soak phase lasts.            |
| `autoBack`                 | bool                | Go back to the previous plan mode when the run ends. |

Sub-minute runs are not possible on non-S models. Hoseidon only accepts runs of 60 s or longer
(`runRequestSchema`).

### `pauseWateringPlan`

- `pauseDuration` is in hours, from 0.1 to 240, or `-1` to pause indefinitely.
- **There is no resume call.** To resume, re-activate a mode. You also **can't read** whether a
  device is paused, so Hoseidon records the pause as an event and can't show it as live state.

### `dismissAlarm`

`alarm` must be one of `noWater`, `valveBroken`, `fallFlag`, `pcFlag` (water cut-off) or `pbFlag`
(pipe burst). The other flags (`leakFlag`, `clogFlag`, `freezeFlag`) show up in `getAllDevices`,
but this endpoint can't clear them.

## Data shapes

All of these are **inferred**. Hoseidon parses them with loose zod schemas (`looseObject`), so
unknown keys pass through and are kept in `raw` JSON on snapshots.

### `getAllDevices`

```jsonc
{
  "result": "ok",
  "devices": [
    {
      "gatewayId": "A1B2C3D4E5F60001",
      "name": "Backyard Gateway",
      "status": "Connected", // anything else = offline
      "taplinker": [
        {
          "taplinkerId": "B1C2D3E4F5A60011",
          "taplinkerName": "Front Lawn",
          "status": "Connected",
          "batteryStatus": "80%", // string with %
          "signal": "66%", // RF signal to the gateway
          "workMode": "M", // see below
          "watering": null, // or { remaining, total, vel, vol }
          "noWater": false,
          "valveBroken": false,
          "fallFlag": false,
          "leakFlag": false,
          "clogFlag": false,
          "pcFlag": false,
          "pbFlag": false,
        },
      ],
    },
  ],
}
```

- `workMode` values are `M` (Instant/manual), `I` (Interval), `T` (7-day), `O` (Odd-even),
  `Y` (Month) and `N` (none). `D` (calendar/day) is **unverified**, and any other value is
  treated as unknown.
- `watering.remaining` and `watering.total` are assumed to be **minutes** (**unverified**, see
  `WATERING_TIME_UNIT_SEC`).
- `vel` is the flow rate (ml/min) and `vol` is the volume so far (ml). Only G2 models report them.
- Flags may arrive as booleans, `0`/`1` or `"true"`/`"false"`. Hoseidon accepts all of them.

### `getWateringStatus`

`{"result":"ok","status": null | {"onDuration": n, "total": n, "vel"?: n, "vol"?: n}}`

- `onDuration` is the time remaining and `total` is the planned length. Both are assumed to be in
  minutes.
- **`status: null` also comes back when the credentials are bad.** Never take a successful call
  as proof that the credentials work. Use `getAllDevices` for that.

### `getWateringHistory`

This returns 30 days of records: `{ Y: "YYYYMMDD", H, M, ss, D, S, vol }`.

- `Y`, `H`, `M` and `ss` are the start time in the gateway's local time.
- `D` (minutes) plus `S` (seconds) is the duration.
- `vol` is in ml (G2 only).

The response key is **unverified**. Hoseidon accepts `history` or `data`. It converts the local
times to UTC using the gateway's `timezone`, which the user sets, falling back to the server's
`TZ`.

## Rate limits

| Call                                            | Minimum interval            | Hoseidon bucket         |
| ----------------------------------------------- | --------------------------- | ----------------------- |
| `getAllDevices`                                 | 5 min                       | `devices`, account-wide |
| Commands (`activate*`, `pause`, `dismissAlarm`) | 15 s                        | `command`, account-wide |
| `getWateringHistory`                            | 10 min                      | `history`, account-wide |
| `getWateringStatus`                             | not documented; we use 15 s | `status`, per taplinker |

The docs don't say whether these limits apply per account or per device, so Hoseidon assumes
the stricter one (per account) everywhere except `getWateringStatus`. The limits are set in
`LINKTAP_LIMITS` (`client.ts`). The queue (`rate-limit.ts`) handles them as follows:

- It runs the calls in each bucket one at a time, spaced from when the previous call finished.
- Identical reads that are queued or in flight share one promise.
- A failed call still uses up its slot.
- It exposes `nextAvailableAt(bucket)`, so the UI can show "next command in 9 s".

## Webhooks

- Register the URL with `setWebHookUrl`. There is one URL per account.
- Hoseidon's URL is `POST ${PUBLIC_URL}/hooks/linktap/${WEBHOOK_SECRET}`. LinkTap can't sign
  requests, so the secret is in the URL path.
- LinkTap has to reach the URL over the internet, which means you need the Cloudflare Tunnel.

Payload:

```json
{
  "username": "you",
  "event": "wateringOn",
  "title": "...",
  "content": "...",
  "gatewayId": "...",
  "deviceId": "...",
  "workMode": "M"
}
```

The event types are:

- watering start, end and skipped
- gateway offline and online
- device offline and online
- low battery
- water cut-off
- high and low flow
- valve broken
- fall
- freeze
- alarm cleared
- manual button press

The exact event strings are **unverified**, so Hoseidon matches them loosely: anything containing
`offline` or `online`, and the `wateringOn`/`wateringOff` variants. Each delivery is stored as
`linktap.<event>`, and the full payload is kept. `deviceId` can be the 16-char base id of a
multi-outlet device. When it matches more than one outlet, Hoseidon stores the event but doesn't
guess which outlet it was for.

## Local gateway API (HTTP / MQTT)

The gateway also has a local API. Hoseidon doesn't use it yet; it is planned for a later
local-gateway executor.

- **HTTP:** `POST http://<gateway-ip>/api.shtml` with a JSON command frame.
- **MQTT:** the gateway connects to your broker (set in its local web UI) and publishes and
  subscribes on topics you choose.
- It sends a status frame about every 2 minutes, which is much fresher than the cloud's 5-minute
  polling.
- Command numbers:

  | Cmd   | Meaning                                                                  |
  | ----- | ------------------------------------------------------------------------ |
  | 3     | Status.                                                                  |
  | 4 / 5 | Set or remove a plan. The gateway then runs the plan by itself, offline. |
  | 6 / 7 | Start / stop watering.                                                   |
  | 15    | Wireless (RF) check.                                                     |
  | 18    | Pause.                                                                   |

- The full frame schemas are in LinkTap's "Interaction Messages" document, which isn't public.
  We need to ask LinkTap support for it.
- Local plans are the only way to put a schedule on the device itself.

## What is not possible

- **Writing schedules through the cloud.** The `activate*Mode` calls only switch to a plan that
  was built in the LinkTap app. Hoseidon therefore owns schedules itself and fires timed instant
  runs.
- **Device location.** The API has none, so the user sets a location on each gateway.
- **Mesh, extender or repeater topology.** Network health has to be built from other signals:
  - gateway online status
  - each timer's `signal`% and battery
  - offline/online webhooks
  - our own last-seen tracking
- **Pause state and resume.** The API can't report whether a device is paused, and there is no
  call to resume one.
- **Live data faster than about 30 s** from the cloud. Use the local API for that.
- **Sub-minute instant runs** on non-S models.
- **Clearing** `leakFlag`, `clogFlag` or `freezeFlag` through `dismissAlarm`.

## Gotchas

- `getWateringStatus` returns `null` even when the credentials are bad (see above).
- Community reports say a start command can come back `ok` and still not start the valve.
  Hoseidon's scheduler (phase 2) checks with `getWateringStatus` that the run started and retries
  once. The poller also gives a new run 20 s before a `null` status closes it.
- If a LinkTap-app plan is active (`workMode` is anything except `M` or `N`) while Hoseidon also
  waters on a schedule, the device waters twice. The UI warns about this.
- `autoBack: true` sends the device back to its plan after an instant run, so `workMode` flips
  back from `M` to the plan's mode.
- Percentages are strings (`"80%"`), and flags come in several types. See `normalize.ts`.
- A rate-limit violation is an ordinary error response, not an HTTP 429.

## How Hoseidon uses it

| Piece                                               | File                                    |
| --------------------------------------------------- | --------------------------------------- |
| Loose response schemas                              | `apps/server/src/linktap/schemas.ts`    |
| Normalizers and ID helpers                          | `apps/server/src/linktap/normalize.ts`  |
| Rate-limit queue                                    | `apps/server/src/linktap/rate-limit.ts` |
| Typed client                                        | `apps/server/src/linktap/client.ts`     |
| In-process mock (`LINKTAP_MOCK=true`)               | `apps/server/src/linktap/mock.ts`       |
| Poller (5 min devices, 30 s status, 10 min history) | `apps/server/src/poller/index.ts`       |
| DB ingest, derived events, webhooks                 | `apps/server/src/poller/ingest.ts`      |
| REST and webhook routes                             | `apps/server/src/api/`                  |

## Sources

- LinkTap API docs: https://link-tap.com/modules/core/views/api.client.view.html
- LinkTap Gateway MQTT client integration guide:
  https://linktap-static.s3.amazonaws.com/manual/LinkTap_Gateway_MQTT_Client_Integration.pdf
- homebridge-platform-linktap (community HomeKit plugin)
- openHAB LinkTap binding (community)
