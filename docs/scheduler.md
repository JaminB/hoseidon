# Scheduler

Hoseidon owns the schedules. The LinkTap cloud API can start and stop a timer, but it can't store
a plan, so the server works out when each zone should run and sends timed instant runs
(`activateInstantMode`) itself.

## Schedules

A schedule has:

- **Name and color**, for the calendar view.
- **Repeat**: an RFC 5545 RRULE body without `DTSTART`, e.g. `FREQ=DAILY;INTERVAL=2` or
  `FREQ=WEEKLY;BYDAY=MO,WE,FR`. `COUNT` and `UNTIL` work. A rule that repeats more often than
  daily is rejected.
- **Start**: `dtstart`, a local wall-clock time (`YYYY-MM-DDTHH:mm`), plus `timezone` (IANA). The
  time zone defaults to the first zone's gateway time zone, then to the server's.
- **Zones**: an ordered list of `{deviceId, seconds}`. `seconds` is the total time for each
  occurrence.
- **Cycle and soak** (optional): `{cycles, soakMinutes}`. Each zone's time is split into `cycles`
  runs, with at least `soakMinutes` of rest between one run and the next.
- **Sequential** (default on): zones on the same gateway run one at a time, for water pressure.
  Zones on different gateways still run in parallel.
- **Skip rules**: `rainForecastMm`, `freezeC`, `windKph`, `etScaling`, `minScale` and `maxScale`.
- **gcalEventId**: reserved for Google Calendar sync in phase 6.

### DST

Occurrences are expanded in "floating" time and converted to real instants in the schedule's
zone, so 06:00 stays at 06:00 across DST changes.

- A wall time that doesn't exist (02:30 on spring-forward day) runs at 03:30.
- A wall time that happens twice (01:30 on fall-back day) runs once, at the first 01:30.

## Planned runs

The engine materializes upcoming occurrences into `planned_runs`, one row per zone per cycle, 48
hours ahead. It also looks back a day, so that occurrences missed during downtime are still
recorded.

| Status      | Meaning                                                  |
| ----------- | -------------------------------------------------------- |
| `planned`   | Waiting for its time, its turn in the lane, or its soak  |
| `running`   | Started and verified (linked to a `runs` row)            |
| `done`      | Finished                                                 |
| `skipped`   | Didn't run; `skipReason` says why                        |
| `failed`    | The start was rejected or never took; `error` says why   |
| `cancelled` | Someone stopped it mid-run (the rest of its cycles skip) |

Editing a schedule's timing, zones or rules, or turning it on or off, deletes its occurrences that
haven't begun and plans again from now. Occurrences already under way finish as originally planned.

## The engine loop (every 30 s)

1. **Settle.** Close out finished runs. A planned run finishes when its `runs` row closes; the
   poller does that when `getWateringStatus` goes null. If the poller hasn't closed it two minutes
   after its time is up, the engine closes it, because LinkTap stops instant runs on its own.
2. **Materialize** upcoming occurrences.
3. **Catch up.** An occurrence that never began and is more than 10 minutes late is skipped with
   "Missed (...): Hoseidon was offline", and a `schedule.missed` event is logged. On the first
   tick after a restart, runs inside an occurrence that should have started more than 10 minutes
   ago are skipped the same way.
4. **Skip rules.** When an occurrence comes due, the engine asks the `WeatherProvider` for each
   gateway's location.
   - Rain above the threshold, a low at or below `freezeC`, or wind at or above `windKph` skips the
     whole occurrence on that gateway. The reason is recorded and a `schedule.skipped` event is
     logged.
   - With `etScaling`, durations are multiplied by ET₀ divided by the baseline, clamped to
     `[minScale, maxScale]`.
   - No location or no data means no skip. The current provider is `NullWeatherProvider`; phase 4
     plugs in Open-Meteo.
5. **Start** ready runs one at a time. A run is ready when all of these hold:
   - its occurrence time has passed
   - every run ahead of it in its lane is finished (the lane is the gateway when the schedule is
     sequential, otherwise the device)
   - its previous cycle is `done` and the soak has passed. If the previous cycle didn't run, this
     one is skipped too.
   - the device isn't already watering, and for sequential schedules nothing else on the gateway
     is either (including manual runs and LinkTap-app runs)

   An offline device, or one with a `noWater` or `valveBroken` alarm, is skipped. A run blocked by
   a busy gateway for two hours is skipped too.

## Executors and verification

`Executor` is the seam between the engine and the hardware:
`quantize(device, seconds)`, `start(device, seconds)`, `stop(device)` and `verify(device)`.

- **CloudExecutor** uses the phase 1 client, so starts go through its rate-limit queue.
  - Durations are rounded to whole minutes (1 to 1439). Devices flagged with `supportsSeconds`
    (S models) keep their seconds.
  - `verify` waits 5 s, then calls `getWateringStatus`. A null status counts as "not watering",
    and that includes the null LinkTap returns for bad credentials.
- **LocalGatewayExecutor** is a stub that throws `NotImplementedError`. It will be the LAN
  HTTP/MQTT path.

`startVerified` starts the run and verifies it, and if the check fails it starts again once. If
the second check also fails, the planned run is marked `failed` and a `failed` row is written to
`runs`. A `schedule.run_failed` event with severity `alert` is logged as well. API errors such as
"device has an active alarm" are not retried.

## Conflicts

A device whose `workMode` isn't `M` (manual) or `N` (none) has a LinkTap-app plan active. The
schedule then carries a `linktap_plan` warning. Schedules also warn about offline or deleted
devices. The preview endpoint flags occurrences that overlap another schedule on a shared gateway
(`overlapsWith`).

## API

| Route                                                           | What it does                                                     |
| --------------------------------------------------------------- | ---------------------------------------------------------------- |
| `GET /api/schedules`                                            | All schedules, with `nextAt` and `warnings`                      |
| `POST /api/schedules`                                           | Create (`scheduleInputSchema`); returns 201                      |
| `GET /api/schedules/:id`                                        | One schedule                                                     |
| `PATCH /api/schedules/:id`                                      | Partial update (`schedulePatchSchema`)                           |
| `DELETE /api/schedules/:id`                                     | Delete. Its planned runs go too; a run already watering finishes |
| `GET /api/schedules/preview?from&to&scheduleId`                 | Occurrences with per-zone slots for a calendar (at most 62 days) |
| `POST /api/schedules/quick-add` `{text}`                        | Natural-language parse into a draft you can POST back            |
| `GET /api/planned-runs?from&to&scheduleId&deviceId&status`      | Planned runs by `plannedAt` (default: last 24 h to next 48 h)    |
| `POST /api/planned-runs/:id/skip` `{reason?, wholeOccurrence?}` | Skip one run or its whole occurrence; 409 once started           |
| `GET /api/scheduler/status`                                     | Engine status and last tick                                      |

## Quick add

`parseQuickAdd` in `@hoseidon/shared` understands these pieces:

- **Repeats**: "every other day", "every 3 days", "daily", "weekdays", "weekends", "mon wed fri",
  "every other monday", "weekly", "odd days" and "even days".
- **Times**: "6am", "5:30", "18:05", "at 7", "noon" and "midnight".
- **Zones and durations**: "front lawn 15m", "drip a 10 min and side yard 1h", or
  "front lawn and back beds 12 minutes", where both zones get 12 minutes.
- **Cycles and soak**: "x3", "3 times", "soak 20" or "soak 1h".

"10 min x3" means three 10-minute cycles, so the zone's total is 30 minutes. Zone names are matched
to device names with forgiving rules: exact first, then prefix, then shared words. When something
is missing, the parser falls back to sensible defaults (daily, 6:00 AM) and adds a warning.
Anything it can't resolve, it reports as an error.
