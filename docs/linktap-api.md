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
- [Verified against live API (2026-11-22)](#verified-against-live-api-2026-11-22)
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
- Failure: `{"result":"error","message":"..."}`. Rate-limit violations come back the same way.
  Seen live for `getWateringStatus`: `"The minimum interval of calling this API is 30 seconds."`;
  the docs mention "too frequently". Hoseidon classifies both (and any "minimum interval"
  message) as `LinkTapError` kind `rate_limit`.

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

The shapes below were inferred before the first live capture. The next section records what the
real API actually returned and supersedes them where they differ. Hoseidon parses them with loose zod schemas (`looseObject`), so
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
          "signal": "66%", // RF signal to the gateway (live API: a number, e.g. 88)
          "workMode": "M", // see below
          "watering": null, // or { remaining, total, vel, vol }
          "noWater": false,
          "valveBroken": false,
          "fallFlag": false, // live API: "fall"
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
- `watering.remaining` and `watering.total` are assumed to be **minutes**, like the verified
  `getWateringStatus` fields (see `WATERING_TIME_UNIT_SEC`). The exact `watering` shape inside
  `getAllDevices` for a running outlet is still unseen.
- `vel` is the flow rate (ml/min) and `vol` is the volume so far (ml). Only G2 models report them.
- Flags may arrive as booleans, `0`/`1` or `"true"`/`"false"`. Hoseidon accepts all of them.

### `getWateringStatus`

`{"result":"ok","status": null | {...}}`. The running shape is in the verified section below
(all values are strings; `onDuration` is not a countdown).

- **`status: null` also comes back when the credentials are bad.** Never take a successful call
  as proof that the credentials work. Use `getAllDevices` for that.

### `getWateringHistory`

This returns 30 days of records: `{ Y: "YYYYMMDD", H, M, ss, D, S, vol }`.

- `Y`, `H`, `M` and `ss` are the end time in the gateway's local time.
- `D` (minutes) plus `S` (seconds) is the duration.
- `vol` is in ml (G2 only).

The response key is `status` (verified; Hoseidon also accepts `history` or `data`). The time is
the run's **end** (see the verified section). It converts the local
times to UTC using the gateway's `timezone`, which the user sets, falling back to the server's
`TZ`.

## Verified against live API (2026-11-22)

First real captures (one gateway, one 4-outlet ValveLinker with flow meter). IDs and the location
below are sanitized; the shapes are exactly as received. Sanitized copies are the test fixtures in
`apps/server/src/linktap/fixtures/`.

### `getAllDevices`

```jsonc
{
  "result": "ok",
  "devices": [
    {
      "name": "Gateway",
      "location": "849VCWC8+R9 Mountain View, CA, USA", // Google Plus Code + locality
      "gatewayId": "A1B2C3D4004B1200",
      "status": "Connected",
      "version": "G0609472606040836I_C0502012507221443", // gateway firmware
      "taplinker": [
        {
          "taplinkerName": "ValveLinker_1",
          "taplinkerId": "E5F60718004B1200_1",
          "status": "Connected",
          "flowMeterStatus": "on",
          "location": "Not specified", // taplinkers don't carry a location
          "dType": 16, // 16 = 4-outlet ValveLinker
          "batteryStatus": "100%", // string with %
          "workMode": "M",
          "plan": {
            // last instant-mode plan; absent when workMode is "N"
            "action": false,
            "duration": 0,
            "Y": 2026,
            "X": 11, // month
            "Z": 21, // day
            "H": 19,
            "M": 55,
            "eco": false,
            "ecoOn": 1,
            "ecoOff": 1,
            "ecoOnS": 0,
            "ecoOffS": 0,
            "wType": "d",
            "multi": false,
          },
          "watering": null,
          "vel": 9911, // top-level flow, ml/min (last/current), present while idle
          "fall": false, // NOT "fallFlag"
          "valveBroken": false,
          "noWater": false,
          "leakFlag": false,
          "clogFlag": false,
          "signal": 88, // a number, not "88%"
        },
      ],
    },
  ],
}
```

- The fall alarm is `fall` (Hoseidon also accepts `fallFlag`). `pcFlag` and `pbFlag` were absent;
  Hoseidon treats absent as not raised and still maps them if a firmware sends them.
- `signal` is a number and `batteryStatus` is `"100%"`; `parsePercent` handles both.
- `vel` is **top-level**, not inside `watering`. A 30 minute run used 294219 ml (about 9.8 L/min)
  and `vel` read about 9911, so it is ml/min. It keeps the last value when idle, so Hoseidon
  stores it as `flowMlPerMin` on every snapshot and only displays it while watering.
- `flowMeterStatus: "on"` means a flow meter is fitted. Hoseidon hides flow charts when it is
  present and not `on`.
- `dType` is stored raw. `plan` is stored on the device as reported (not interpreted).
- The gateway `location` is a Plus Code, short or full, followed by a locality. Hoseidon
  recovers the full code near the geocoded locality (`open-location-code` + Open-Meteo geocoding)
  and sets the gateway's lat/lon and time zone unless the user set a location by hand.
  "Not specified" or anything unparseable leaves it unset.

### `getWateringStatus`

An idle outlet that has not run returned `{"result":"ok","status":null}`, as assumed.

A running outlet (first live watering test, 1-minute instant runs) returned **every value as a
string**:

```jsonc
{
  "result": "ok",
  "status": {
    "onDuration": "1", // whole minutes; did NOT count down over the 60 s run
    "onDurSec": "0", // seconds part
    "total": "1", // planned, whole minutes
    "totalSec": "0", // seconds part
    "onStamp": "1795000000000", // run start, epoch ms
    "firstDt": "1795000000000",
    "vel": "8509", // live flow, ml/min (read "0" 12 s in, then about 8500-11300)
    "vol": "0", // stayed "0" for the whole run
    "dur": "60", // planned length in SECONDS
    "cm": "M",
    // also: pbThrd, pcThrd, pDelay, pbCnt, pcCnt, fmc, frd, wFlag, volExp, spb, spc, pbm, pcm
  },
}
```

- Units are resolved: `onDuration`/`total` are minutes and `onDurSec`/`totalSec` the seconds
  part; `dur` is seconds. `WATERING_TIME_UNIT_SEC` stays 60.
- Hoseidon computes total = `dur` (fallback `total` x 60 + `totalSec`) and remaining =
  `onStamp` + total - now, clamped to [0, total]. A `vol` of `"0"` next to `onStamp` is treated as
  unknown; the real volume comes from history.
- **After a run ends** the outlet answers `{"result":"ok","status":{"dur":"60"}}`, not `null`. A
  status is "watering" only when it has `onStamp` (or `onDuration`/`total`/`remaining`); a bare
  `dur` is idle (`isWateringStatus` in `normalize.ts`; fixture `getWateringStatus.finished.json`).
- **Start latency.** An outlet answered `status: null` 12 s after an accepted start, yet history
  shows it ran (13 s, about 1.2 L, before it was stopped). Another showed running with `vel` "0"
  at 12 s. One null right after a start proves nothing; see "How Hoseidon uses it".
- Rate limit: `"The minimum interval of calling this API is 30 seconds."` (see Rate limits).

### `activateInstantMode` (verified)

Verified bodies (ids sanitized):

```jsonc
// start -> {"result":"ok","message":"success"}
{
  "gatewayId": "A1B2C3D4004B1200",
  "taplinkerId": "E5F60718004B1200_1",
  "action": true,
  "duration": 1,
  "autoBack": false,
}
// stop -> {"result":"ok","message":"success"}; the valve stopped (history shows the 13 s run)
{ "gatewayId": "A1B2C3D4004B1200", "taplinkerId": "E5F60718004B1200_2", "action": false, "duration": 0 }
```

- The 16-char gateway id plus the full 18-char outlet id (`..._1`) works for commands.
- Commands for different outlets 17-18 s apart all succeeded (consistent with the 15 s limit).
- The client sends exactly these fields; `durationSec` only when non-zero, `eco`/`ecoOn`/`ecoOff`
  only for cycle-and-soak. Hoseidon's starts send `autoBack: true` by default (go back to the
  LinkTap plan afterwards); only `false` has been exercised live.

### `getWateringHistory`

The records are under **`status`** (an array), not `history`/`data`:

```jsonc
{
  "result": "ok",
  "status": [
    {
      "macaddr": "E5F60718004B1200_1",
      "Y": 20261118, // YYYYMMDD
      "H": 14,
      "M": 16,
      "ss": 58,
      "D": 30, // minutes
      "S": 0, // seconds
      "vol": 294219, // ml
      "cm": "M", // optional: work mode the run happened under
      "createdAt": "2026-11-18T19:16:59.557Z", // ISO UTC, when the record was stored
      "__v": 0,
    },
  ],
}
```

- `Y/H/M/ss` is when the run **ended**, in the gateway's local time (19:24:09Z matched 14:24:08
  EST). The start is the end minus `D`/`S`.
- `createdAt` is more precise but sometimes batched days after the event (11-15 entries stamped
  11-18). Hoseidon uses it only when it is within 2 minutes of the local-time conversion.
- Entries with `D` and `S` both 0 are not runs and are dropped. `cm` is kept as the run's `mode`.
- A finished run appears within about a second of ending, with `createdAt` at about the end time,
  so the poller fetches that outlet's history right after it sees the run end.
- Two different outlets fetched back to back both succeeded, so the 10-minute limit looks **per
  taplinker**, not per account.

### Resolved and still open

- Resolved: the history response key (`status`), the `fall` flag name, numeric `signal`, the
  running `getWateringStatus` shape and its units, the post-run `{dur}` status, the start/stop
  command bodies, the 30 s status limit and its message, and history being limited per taplinker.
- Still unverified: whether the status limit is per account or per taplinker (see Rate limits),
  the running `watering` shape inside `getAllDevices`, webhook event strings, which endpoints
  require 16-char ids, whether a rejected (rate-limited) call resets LinkTap's window, and
  `autoBack: true` on a live start.

## Rate limits

| Call                                            | Minimum interval     | Hoseidon bucket                     |
| ----------------------------------------------- | -------------------- | ----------------------------------- |
| `getAllDevices`                                 | 5 min                | `devices`, account-wide             |
| Commands (`activate*`, `pause`, `dismissAlarm`) | 15 s                 | `command`, account-wide             |
| `getWateringHistory`                            | 10 min               | `history`, per taplinker            |
| `getWateringStatus`                             | 30 s (verified live) | `status`, account-wide, spaced 31 s |

`getWateringStatus` scope: in the live test, a status call for outlet 1 failed with the 30 s
message 18 s after outlet 1's previous call (in the same second as a successful call for outlet
2), and outlet 2 failed 15 s after its own previous call. Later, two different outlets succeeded
in the same second, each at least 30 s after its own last call. That pattern also fits a
**per-taplinker** 30 s limit, but the sample is small, so Hoseidon spaces status calls
**account-wide** at 31 s, which can never trip either reading. If more captures confirm
per-taplinker, add `status` to `PER_TAPLINKER_BUCKETS` in `client.ts` (and `perTaplinker` in the
mock's `MOCK_API_LIMITS`).

The limits are set in `LINKTAP_LIMITS` (`client.ts`). The queue (`rate-limit.ts`) handles them as
follows:

- It runs the calls in each lane one at a time, spaced from when the previous call finished.
  Per-taplinker buckets get one lane per taplinker id.
- Identical reads that are queued or in flight share one promise.
- A `priority` call (the scheduler's start check) goes ahead of queued background polls.
- A failed call still uses up its slot.
- It exposes `nextAvailableAt(bucket, taplinkerId?)`, so the UI can show "next command in 9 s".
- A rate-limit rejection is a `LinkTapError` with `kind: 'rate_limit'`: the call did not happen.
  The poller ends its status turn and retries next tick (not a device failure); the scheduler
  re-sends a rate-limited start after 16 s (safe, it never ran).

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
- Community reports say a start command can come back `ok` and still not start the valve, and
  live, a start that did run reported `null` 12 s later. Re-sending a start that actually ran
  double-waters, so the scheduler is careful (see "How Hoseidon uses it"). The poller gives a new
  run 60 s before a `null` (or `{dur}`) status closes it.
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
| Poller (5 min devices, 31 s status, 10 min history) | `apps/server/src/poller/index.ts`       |
| DB ingest, derived events, webhooks                 | `apps/server/src/poller/ingest.ts`      |
| REST and webhook routes                             | `apps/server/src/api/`                  |
| Start and verify (`startVerified`, `CloudExecutor`) | `apps/server/src/schedule/executor.ts`  |

**Status polling.** One account-wide status call per 31 s, so running outlets take turns (least
recently polled first, one per tick). When a poll sees a run end, the poller fetches that
outlet's history 5 s later (if its 10-minute history slot is free) to fill in the real volume.

**Starting a scheduled run** (`startVerified`):

1. Send the start. A rate-limited start is re-sent after 16 s (up to twice).
2. Wait 20 s, then check `getWateringStatus` (priority over background polls). Running: done.
3. Otherwise wait about 30 s more and check again. Running: done.
4. Still nothing: look for evidence that costs no waiting: a getAllDevices snapshot or webhook in
   the DB showing it watering, or a history entry ending after the start (only if that outlet's
   history slot is free now). Any of these: done.
5. Re-send the start once only if both checks said "not watering", nothing else suggests it ran,
   and less than half the planned run has passed. If a check could not be made (rate limit,
   error), or it is too late, do not re-send: record the run as running and raise a
   `schedule.run_unverified` event (push category "failed") instead.
6. Two accepted starts that both check "not watering": the planned run fails
   (`schedule.run_failed`).

## Sources

- LinkTap API docs: https://link-tap.com/modules/core/views/api.client.view.html
- LinkTap Gateway MQTT client integration guide:
  https://linktap-static.s3.amazonaws.com/manual/LinkTap_Gateway_MQTT_Client_Integration.pdf
- homebridge-platform-linktap (community HomeKit plugin)
- openHAB LinkTap binding (community)
