# Google Calendar sync

One-way: Hoseidon → Google. Setup steps for the Google Cloud side are in the
[README](../README.md#google-calendar-sync). Code lives in `apps/server/src/gcal/`.

## OAuth

- Server-side authorization-code flow for a confidential web client, with PKCE (S256) and a random
  `state`. Plain `fetch`, no Google SDK (`gcal/oauth.ts`).
- Scope: `https://www.googleapis.com/auth/calendar.app.created` only. It lets the app create
  secondary calendars and manage events in them, and see nothing else.
- `access_type=offline` + `prompt=consent`, so every connect (including a reconnect) returns a
  refresh token. Redirect URI: `${PUBLIC_URL}/api/gcal/callback`.
- Pending `state` → PKCE verifier pairs are in memory for 10 minutes and single-use. A restart in
  the middle of a consent screen means clicking Connect again.
- The callback checks that the granted scopes include ours (the consent screen lets people untick
  it) and that a refresh token came back, then redirects to `${PUBLIC_URL}/settings?gcal=connected`
  or `?gcal=error&reason=denied|state|exchange|scope|no_refresh_token|calendar|not_configured`.
- The refresh token is stored in `gcal_account.refresh_token_enc` as AES-256-GCM ciphertext
  (`gcal/crypto.ts`), with the key derived from `SESSION_SECRET` by HKDF-SHA256. Access tokens stay
  in memory and refresh a minute before expiry; a 401 from the API forces one refresh and a retry.
- `invalid_grant` on refresh (revoked, or the 7-day expiry of apps in Testing mode), a 401 after a
  fresh token, `insufficientPermissions`, or a token that no longer decrypts (new `SESSION_SECRET`)
  all set `needs_reconnect`. Sync pauses until the user connects again; the web app shows a banner
  on every page except Settings, which shows a Reconnect card instead.
- Disconnect revokes the refresh token (best effort) and clears it. The calendar id and the event
  map are kept, so reconnecting the same Google account continues where it left off. If the stored
  calendar is gone or not ours (404/403), connecting creates a new one and forgets the old map.

## What gets synced

| Hoseidon                                             | Google                                                                                                                                                                                                                                                                                                                                                                | Key                      |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| An enabled schedule                                  | A recurring event: `RRULE` from the schedule, `DTSTART` = `dtstart` in the schedule zone, length = one whole occurrence (every zone and cycle, soaks included, rounded like real runs). Zones, cycle-and-soak and skip rules go in the notes. Nearest Google color to the schedule color. Transparent, no reminders. `extendedProperties.private.hoseidonScheduleId`. | `schedule:<id>`          |
| A disabled or deleted schedule                       | Event deleted                                                                                                                                                                                                                                                                                                                                                         | —                        |
| An occurrence with skipped runs                      | That instance is patched (an exception): "⏭ Name (skipped)" in grey, or "(partly skipped)", with the reasons in the notes                                                                                                                                                                                                                                             | `skip:<id>:<occurrence>` |
| A finished occurrence (if "Log finished runs" is on) | A past, single event spanning what actually ran, with per-zone minutes and litres                                                                                                                                                                                                                                                                                     | `occ:<id>:<occurrence>`  |
| A manual or LinkTap-app run (same setting)           | A past, single event                                                                                                                                                                                                                                                                                                                                                  | `run:<runId>`            |

RRULE mapping (`toGoogleRrule`): keys and values are upper-cased and `RRULE:` is prefixed. Our
engine reads `UNTIL` as wall-clock time in the schedule's zone (date-only = local midnight), while
RFC 5545 wants a UTC `UNTIL` when `DTSTART` has a time zone, so `UNTIL` is converted the same way
the engine reads it.

## How a sync runs

`gcal/sync.ts` is a reconcile, so it's always safe to re-run:

1. `buildDesired(db)` computes every item above, with a hash of the exact body we'd send.
2. `diffSync(desired, gcal_events)` compares hashes with what we last pushed and returns inserts,
   updates and deletes. Series go first (skips need their parent's event id), deletes last within a
   kind. Skips and logs older than 14 days are history: they're never touched again, except that
   all logs are deleted when "Log finished runs" is switched off, and skips go with their series.
3. `applyOps` sends them one by one and records each success in `gcal_events`, so progress survives
   a failure halfway through.
   - Update is a full `PUT` (edits made in Google are overwritten). A 404/410 means the user deleted
     it in Google, so it is inserted again.
   - A skip looks up the instance with `events.instances(timeMin = occurrence − 1 min, timeMax = +1
min)` and patches it. No instance (the rule changed) is recorded with a null event id and tried
     again when the series changes (the parent hash is part of the skip hash).
   - A 404 on insert means the calendar itself was deleted: a new one is created, the map is
     cleared, and the sync runs once more.
   - A 400 on one item is recorded in `last_error` and the rest carry on; the item is retried on
     the next sync.

The queue (`GcalService`) runs one sync at a time:

- Schedule create, edit, delete and manual skip call `request()`, which debounces 3 s.
- A periodic request every 5 minutes picks up skips and finished runs from the engine. A pass with
  nothing to send doesn't call Google at all, not even to refresh a token.
- A request during a sync marks it dirty, so it runs again right after.
- On failure (5xx, 429, network) it backs off 30 s, 1 min, 2 min, … up to 30 min. Requests made
  during a backoff wait for the retry. Resync clears every stored hash and runs now.

API: `GET /api/gcal/status`, `GET /api/gcal/connect` (redirect), `GET /api/gcal/callback`
(redirect), `POST /api/gcal/disconnect`, `POST /api/gcal/resync`, `PATCH /api/gcal/settings
{logRuns}`. The setting lives in `settings` under `gcal.logRuns` (default off).

## TODO: two-way sync (not built)

The plan is to let a few edits made in Google flow back, using push notifications:

1. **Watch.** After connecting, `POST /calendars/{calendarId}/events/watch` with
   `{id: uuid, type: 'web_hook', address: '${PUBLIC_URL}/hooks/gcal', token: <secret>,
params: {ttl: 604800}}`. Store the channel id, resource id, token and expiration in a
   `gcal_channels` table. Needs a public HTTPS `PUBLIC_URL` (the Cloudflare Tunnel).
2. **Receive.** `POST /hooks/gcal` checks `X-Goog-Channel-ID` and `X-Goog-Channel-Token` against
   the stored channel, answers 200 immediately, and queues an incremental pull.
3. **Pull.** `GET /calendars/{id}/events?syncToken=…&showDeleted=true` (a full list the first
   time to get a `nextSyncToken`). A 410 means the token expired: do a full list again.
4. **Apply.** For each changed event with `extendedProperties.private.hoseidonScheduleId`:
   - Ignore our own writes: compare the event body with the hash in `gcal_events`.
   - Moving a single instance becomes a one-off reschedule.
   - Deleting a single instance becomes a skip ("Skipped in Google Calendar").
   - Deleting the series disables the schedule (never deletes it).
   - Start or RRULE edits on the series patch the schedule (`dtstart`/`rrule`, with the UNTIL
     conversion reversed). Anything else (title, notes) is overwritten on the next push.
5. **Renew.** Channels expire after at most 7 days (and Testing-mode grants after 7 days too).
   A daily job re-creates channels expiring within 24 h and stops old ones with `channels/stop`.

`gcal/service.ts` would gain `watch()`/`pull()`; `gcal_events` already maps keys to event ids.
