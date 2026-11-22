import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { GCAL_SCOPE, type GcalStatus, type Schedule } from '@hoseidon/shared';
import { gcalAccount, gcalEvents, plannedRuns, runs, schedules } from '../db/schema';
import { MOCK_IDS } from '../linktap/mock';
import { harness } from '../test-utils';
import { FakeGoogle } from './fake-google';
import { backoffMs } from './service';

const ENV = {
  GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  SESSION_SECRET: 'a-very-long-session-secret-for-tests',
  PUBLIC_URL: 'https://hose.example.com/',
};
const HOUR = 3_600_000;

async function setup(env: Record<string, string> = ENV) {
  let offset = 0;
  const now = () => new Date(Date.now() + offset);
  const google = new FakeGoogle(() => now().getTime());
  const logs: string[] = [];
  const h = harness({
    mock: { seedRunning: false },
    env,
    gcal: { fetch: google.fetch, now, timeZone: 'America/New_York', log: (m) => logs.push(m) },
  });
  await h.poller.pollDevices();
  const req = async <T>(method: string, path: string, json?: unknown) => {
    const res = await h.app.request(`/api${path}`, {
      method,
      headers: json === undefined ? undefined : { 'content-type': 'application/json' },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const text = await res.text();
    return {
      status: res.status,
      location: res.headers.get('location'),
      body: (text && res.headers.get('content-type')?.includes('json')
        ? JSON.parse(text)
        : null) as T,
    };
  };
  const status = async () => (await req<GcalStatus>('GET', '/gcal/status')).body;

  /** The whole browser round trip: /connect -> Google consent -> /callback. */
  const connect = async () => {
    const start = await req('GET', '/gcal/connect');
    expect(start.status).toBe(302);
    const { code, state } = google.consent(start.location!);
    const cb = await req('GET', `/gcal/callback?code=${code}&state=${state}`);
    expect(cb.status).toBe(302);
    return cb.location!;
  };

  const createSchedule = async (over: Record<string, unknown> = {}) =>
    (
      await req<Schedule>('POST', '/schedules', {
        name: 'Lawn',
        rrule: 'FREQ=DAILY',
        dtstart: '2026-06-10T06:00',
        timezone: 'America/New_York',
        items: [{ deviceId: MOCK_IDS.frontLawn, seconds: 900 }],
        ...over,
      })
    ).body;

  return {
    ...h,
    google,
    logs,
    req,
    status,
    connect,
    createSchedule,
    advance: (ms: number) => (offset += ms),
  };
}

describe('gcal status + config', () => {
  it('reports what is missing and does not start a flow', async () => {
    const t = await setup({ SESSION_SECRET: 'short' });
    const s = await t.status();
    expect(s).toMatchObject({
      configured: false,
      connected: false,
      missing: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SESSION_SECRET'],
      redirectUri: 'http://localhost:8787/api/gcal/callback',
      sync: { state: 'paused' },
    });
    const res = await t.req('GET', '/gcal/connect');
    expect(res.status).toBe(302);
    expect(res.location).toBe('http://localhost:8787/settings?gcal=error&reason=not_configured');
  });
});

describe('gcal OAuth', () => {
  it('sends the browser to Google with PKCE, offline access and the narrow scope', async () => {
    const t = await setup();
    const res = await t.req('GET', '/gcal/connect');
    const url = new URL(res.location!);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const p = url.searchParams;
    expect(p.get('scope')).toBe(GCAL_SCOPE);
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('prompt')).toBe('consent');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('code_challenge')).toMatch(/^[\w-]{43}$/);
    expect(p.get('state')).toMatch(/^[\w-]{32}$/);
    expect(p.get('redirect_uri')).toBe('https://hose.example.com/api/gcal/callback');
  });

  it('connects, creates the calendar and stores the refresh token encrypted', async () => {
    const t = await setup();
    expect(await t.connect()).toBe('https://hose.example.com/settings?gcal=connected');
    const [cal] = [...t.google.calendars.values()];
    expect(cal).toMatchObject({ summary: '🔱 Hoseidon', timeZone: 'America/New_York' });

    const account = t.db.select().from(gcalAccount).get()!;
    expect(account.calendarId).toBe(cal!.id);
    expect(account.refreshTokenEnc).toMatch(/^v1\./);
    expect(account.refreshTokenEnc).not.toContain('refresh-');

    const s = await t.status();
    expect(s).toMatchObject({
      configured: true,
      connected: true,
      needsReconnect: false,
      calendarId: cal!.id,
    });
    expect(Date.parse(s.reconnectDueAt!) - Date.parse(s.connectedAt!)).toBe(7 * 24 * HOUR);
  });

  it('rejects a bad or reused state, a denial and an unticked scope', async () => {
    const t = await setup();
    const start = await t.req('GET', '/gcal/connect');
    const { code, state } = t.google.consent(start.location!);
    expect((await t.req('GET', `/gcal/callback?code=${code}&state=forged`)).location).toMatch(
      /reason=state/,
    );
    expect((await t.req('GET', `/gcal/callback?code=${code}&state=${state}`)).location).toMatch(
      /connected/,
    );
    expect((await t.req('GET', `/gcal/callback?code=${code}&state=${state}`)).location).toMatch(
      /reason=state/,
    );

    const again = t.google.consent((await t.req('GET', '/gcal/connect')).location!);
    expect(
      (await t.req('GET', `/gcal/callback?error=access_denied&state=${again.state}`)).location,
    ).toMatch(/reason=denied/);

    t.google.grantScope = 'openid';
    const third = t.google.consent((await t.req('GET', '/gcal/connect')).location!);
    expect(
      (await t.req('GET', `/gcal/callback?code=${third.code}&state=${third.state}`)).location,
    ).toMatch(/reason=scope/);
  });

  it('fails the exchange when the PKCE verifier does not match', async () => {
    const t = await setup();
    const start = await t.req('GET', '/gcal/connect');
    const { state } = t.google.consent(start.location!);
    // A code issued for some other flow (different challenge).
    const other = t.google.consent(
      start.location!.replace(/code_challenge=[^&]+/, 'code_challenge=xyz'),
    );
    expect(
      (await t.req('GET', `/gcal/callback?code=${other.code}&state=${state}`)).location,
    ).toMatch(/reason=exchange/);
  });
});

describe('gcal sync', () => {
  it('creates a recurring event per enabled schedule, then only sends changes', async () => {
    const t = await setup();
    const s = await t.createSchedule({
      cycleSoak: { cycles: 2, soakMinutes: 10 },
      color: '#0b8043',
    });
    await t.connect();
    await t.gcal.syncNow();

    const [ev] = t.google.events();
    expect(ev).toMatchObject({
      summary: '💧 Lawn',
      recurrence: ['RRULE:FREQ=DAILY'],
      start: { dateTime: '2026-06-10T06:00:00', timeZone: 'America/New_York' },
      // 2 × 8 min (7.5 rounds up to whole minutes) + 10 min soak.
      end: { dateTime: '2026-06-10T06:26:00', timeZone: 'America/New_York' },
      colorId: '10',
      extendedProperties: { private: { hoseidonScheduleId: String(s.id) } },
    });
    const row = t.db.select().from(schedules).where(eq(schedules.id, s.id)).get()!;
    expect(row.gcalEventId).toBe(ev!.id);

    const posts = t.google.count('POST', '/events');
    await t.gcal.syncNow();
    expect(t.google.count('POST', '/events')).toBe(posts);
    expect(t.google.count('PUT')).toBe(0);

    await t.req('PATCH', `/schedules/${s.id}`, {
      name: 'Front lawn',
      rrule: 'FREQ=WEEKLY;BYDAY=MO,TH',
    });
    await t.gcal.syncNow();
    expect(t.google.count('PUT')).toBe(1);
    expect(t.google.events()[0]).toMatchObject({
      id: ev!.id,
      summary: '💧 Front lawn',
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO,TH'],
    });
    expect((await t.status()).events.schedules).toBe(1);
  });

  it('deletes the event when a schedule is disabled or deleted', async () => {
    const t = await setup();
    const a = await t.createSchedule();
    const b = await t.createSchedule({
      name: 'Beds',
      items: [{ deviceId: MOCK_IDS.veggies, seconds: 600 }],
    });
    await t.connect();
    await t.gcal.syncNow();
    expect(t.google.events()).toHaveLength(2);

    await t.req('PATCH', `/schedules/${a.id}`, { enabled: false });
    await t.req('DELETE', `/schedules/${b.id}`);
    await t.gcal.syncNow();
    expect(t.google.events()).toHaveLength(0);
    expect(t.db.select().from(gcalEvents).all()).toEqual([]);
    expect(
      t.db.select().from(schedules).where(eq(schedules.id, a.id)).get()!.gcalEventId,
    ).toBeNull();
  });

  it('recreates an event that was deleted in Google, and a deleted calendar', async () => {
    const t = await setup();
    await t.createSchedule();
    await t.connect();
    await t.gcal.syncNow();
    const cal = [...t.google.calendars.values()][0]!;
    cal.events.clear();
    await t.gcal.resync();
    expect(t.google.events(cal.id)).toHaveLength(1);

    t.google.calendars.delete(cal.id);
    await t.createSchedule({ name: 'Another' });
    await t.gcal.syncNow();
    const [fresh] = [...t.google.calendars.values()];
    expect(fresh!.id).not.toBe(cal.id);
    expect(
      t.google
        .events(fresh!.id)
        .map((e) => e.summary)
        .sort(),
    ).toEqual(['💧 Another', '💧 Lawn']);
    expect((await t.status()).calendarId).toBe(fresh!.id);
  });

  it('annotates a skipped occurrence as an exception on the series', async () => {
    const t = await setup();
    const s = await t.createSchedule({
      items: [
        { deviceId: MOCK_IDS.frontLawn, seconds: 600 },
        { deviceId: MOCK_IDS.veggies, seconds: 600 },
      ],
    });
    await t.connect();
    await t.gcal.syncNow();
    const occurrenceAt = new Date(Date.now() - 2 * HOUR);
    occurrenceAt.setUTCSeconds(0, 0);
    const base = {
      scheduleId: s.id,
      gatewayId: MOCK_IDS.backyard,
      occurrenceAt,
      plannedAt: occurrenceAt,
      baseSeconds: 600,
      seconds: 600,
      cycle: 1,
      status: 'skipped' as const,
      skipReason: 'Rain forecast 8 mm',
      updatedAt: new Date(),
    };
    t.db
      .insert(plannedRuns)
      .values([
        { ...base, deviceId: MOCK_IDS.frontLawn, seq: 0 },
        { ...base, deviceId: MOCK_IDS.veggies, seq: 1 },
      ])
      .run();
    await t.gcal.syncNow();

    const parent = t.google.events().find((e) => e.recurrence)!;
    const exception = t.google.events().find((e) => e.recurringEventId === parent.id)!;
    expect(exception).toMatchObject({ summary: '⏭ Lawn (skipped)', colorId: '8' });
    expect(Date.parse(exception.originalStartTime!.dateTime)).toBe(occurrenceAt.getTime());
    expect(exception.description).toContain('Rain forecast 8 mm');
    expect((await t.status()).events.skips).toBe(1);

    // Renaming the series re-applies the annotation with the new name.
    await t.req('PATCH', `/schedules/${s.id}`, { name: 'Lawn & beds' });
    await t.gcal.syncNow();
    expect(t.google.events().find((e) => e.id === exception.id)!.summary).toBe(
      '⏭ Lawn & beds (skipped)',
    );
  });

  it('logs finished runs as past events when turned on, and removes them when off', async () => {
    const t = await setup();
    await t.connect();
    const startedAt = new Date(Date.now() - 3 * HOUR);
    t.db
      .insert(runs)
      .values({
        deviceId: MOCK_IDS.veggies,
        startedAt,
        endedAt: new Date(startedAt.getTime() + 10 * 60_000),
        durationSec: 600,
        volumeMl: 52_000,
        source: 'manual',
        status: 'completed',
      })
      .run();
    await t.gcal.syncNow();
    expect(t.google.events()).toHaveLength(0);

    const on = await t.req<GcalStatus>('PATCH', '/gcal/settings', { logRuns: true });
    expect(on.body.logRuns).toBe(true);
    await t.gcal.syncNow();
    expect(t.google.events()).toMatchObject([{ summary: '✓ Veggie Beds · 10 min' }]);
    expect(t.google.events()[0]!.description).toContain('52 L');

    await t.req('PATCH', '/gcal/settings', { logRuns: false });
    await t.gcal.syncNow();
    expect(t.google.events()).toHaveLength(0);
    expect((await t.req('PATCH', '/gcal/settings', { logRuns: 'yes' })).status).toBe(400);
  });

  it('refreshes an expired access token and retries once on a 401', async () => {
    const t = await setup();
    await t.connect();
    await t.createSchedule();
    t.advance(2 * HOUR);
    await t.gcal.syncNow();
    expect(t.google.events()).toHaveLength(1);

    // Revoked early: the API says 401, we refresh and retry.
    t.google.expireAccessTokens();
    await t.createSchedule({ name: 'Two' });
    await t.gcal.syncNow();
    expect(t.google.events()).toHaveLength(2);
    expect((await t.status()).lastError).toBeNull();
  });

  it('flags needsReconnect on invalid_grant and stops syncing', async () => {
    const t = await setup();
    await t.connect();
    t.google.expireGrants();
    t.advance(2 * HOUR);
    await t.createSchedule();
    await t.gcal.syncNow();

    const s = await t.status();
    expect(s).toMatchObject({ connected: true, needsReconnect: true, sync: { state: 'paused' } });
    expect(s.lastError).toMatch(/reconnect|revoked|expired/i);
    expect(t.google.events()).toHaveLength(0);

    // Reconnecting reuses the calendar and catches up.
    const calendars = t.google.calendars.size;
    expect(await t.connect()).toMatch(/connected/);
    await t.gcal.syncNow();
    expect(t.google.calendars.size).toBe(calendars);
    expect(t.google.events()).toHaveLength(1);
    expect((await t.status()).needsReconnect).toBe(false);
  });

  it('backs off after a server error and recovers', async () => {
    const t = await setup();
    await t.connect();
    await t.createSchedule();
    t.google.failNext((m, p) => m === 'POST' && p.endsWith('/events'), 503);
    await t.gcal.syncNow();
    let s = await t.status();
    expect(s.sync).toMatchObject({ state: 'backoff', failures: 1 });
    expect(Date.parse(s.sync.nextRunAt!) - Date.now()).toBeGreaterThan(20_000);
    expect(s.lastError).toMatch(/503/);

    await t.gcal.syncNow();
    s = await t.status();
    expect(s.sync).toMatchObject({ state: 'idle', failures: 0 });
    expect(s.lastError).toBeNull();
    expect(t.google.events()).toHaveLength(1);
  });

  it('keeps going when Google rejects one event', async () => {
    const t = await setup();
    await t.connect();
    await t.createSchedule({ name: 'Bad' });
    await t.createSchedule({ name: 'Good' });
    t.google.failNext((m, p) => m === 'POST' && p.endsWith('/events'), 400);
    await t.gcal.syncNow();
    const s = await t.status();
    expect(s.lastError).toMatch(/1 event\(s\) rejected/);
    expect(t.google.events()).toHaveLength(1);
    // The rejected one is retried next time.
    await t.gcal.syncNow();
    expect(t.google.events()).toHaveLength(2);
  });

  it('does not duplicate an event when the insert response is lost', async () => {
    const t = await setup();
    await t.connect();
    await t.createSchedule();
    t.google.loseNextResponse((m, p) => m === 'POST' && p.endsWith('/events'));
    await t.gcal.syncNow();
    expect((await t.status()).sync.state).toBe('backoff');
    // Google made it; we only know its id.
    expect(t.google.events()).toHaveLength(1);

    await t.gcal.syncNow();
    expect(t.google.events()).toHaveLength(1);
    const row = t.db.select().from(gcalEvents).get()!;
    expect(row.eventId).toBe(t.google.events()[0]!.id);
    expect(row.hash).not.toBe('');
    expect((await t.status()).lastError).toBeNull();
  });

  it('recreates a series deleted in Google when a skip needs it', async () => {
    const t = await setup();
    const s = await t.createSchedule();
    await t.connect();
    await t.gcal.syncNow();
    const old = t.google.events()[0]!;
    // Deleted in Google; our hash is unchanged, so only the skip notices.
    old.status = 'cancelled';
    const occurrenceAt = new Date(Date.now() - 2 * HOUR);
    occurrenceAt.setUTCSeconds(0, 0);
    t.db
      .insert(plannedRuns)
      .values({
        scheduleId: s.id,
        gatewayId: MOCK_IDS.backyard,
        deviceId: MOCK_IDS.frontLawn,
        seq: 0,
        occurrenceAt,
        plannedAt: occurrenceAt,
        baseSeconds: 900,
        seconds: 900,
        cycle: 1,
        status: 'skipped',
        skipReason: 'Rain forecast 8 mm',
        updatedAt: new Date(),
      })
      .run();
    await t.gcal.syncNow();

    const parent = t.google.events().find((e) => e.recurrence)!;
    expect(parent.id).not.toBe(old.id);
    expect(t.google.events().find((e) => e.recurringEventId === parent.id)).toMatchObject({
      summary: '⏭ Lawn (skipped)',
    });
    const s2 = await t.status();
    expect(s2).toMatchObject({ lastError: null, sync: { failures: 0 } });
    expect(t.db.select().from(schedules).where(eq(schedules.id, s.id)).get()!.gcalEventId).toBe(
      parent.id,
    );
  });

  it('keeps the calendar when Google rate-limits the reconnect check', async () => {
    const t = await setup();
    await t.createSchedule();
    await t.connect();
    await t.gcal.syncNow();
    const cal = [...t.google.calendars.values()][0]!;
    t.google.failNext(
      (m, p) => m === 'GET' && p === `/calendars/${cal.id}`,
      403,
      1,
      'rateLimitExceeded',
    );
    expect(await t.connect()).toMatch(/reason=calendar/);
    expect(t.google.calendars.size).toBe(1);
    expect(t.db.select().from(gcalEvents).all()).toHaveLength(1);

    // A plain 403 (no access to the old calendar) does make a new one.
    t.google.failNext((m, p) => m === 'GET' && p === `/calendars/${cal.id}`, 403, 1, 'forbidden');
    expect(await t.connect()).toMatch(/connected/);
    expect(t.google.calendars.size).toBe(2);
  });

  it('backs off on invalid_client instead of asking to reconnect', async () => {
    const t = await setup();
    await t.connect();
    t.advance(2 * HOUR);
    t.google.rejectClient = true;
    await t.createSchedule();
    await t.gcal.syncNow();
    let s = await t.status();
    expect(s).toMatchObject({ needsReconnect: false, sync: { state: 'backoff' } });
    expect(s.lastError).toMatch(/OAuth client/);

    t.google.rejectClient = false;
    await t.gcal.syncNow();
    s = await t.status();
    expect(s).toMatchObject({ needsReconnect: false, lastError: null });
    expect(t.google.events()).toHaveLength(1);
  });

  it('holds syncs off while a reconnect swaps the calendar', async () => {
    const t = await setup();
    await t.createSchedule();
    await t.connect();
    await t.gcal.syncNow();
    const first = [...t.google.calendars.keys()][0]!;
    t.google.calendars.delete(first);
    // A sync is in flight when the callback lands.
    await t.createSchedule({ name: 'Two' });
    const inflight = t.gcal.syncNow();
    expect(await t.connect()).toMatch(/connected/);
    await inflight;
    await t.gcal.syncNow();
    const cal = (await t.status()).calendarId!;
    expect(t.google.calendars.has(cal)).toBe(true);
    expect(
      t.google
        .events(cal)
        .map((e) => e.summary)
        .sort(),
    ).toEqual(['💧 Lawn', '💧 Two']);
    for (const row of t.db.select().from(gcalEvents).all())
      expect(t.google.calendars.get(cal)!.events.has(row.eventId!)).toBe(true);
  });

  it('disconnect revokes the token and keeps the calendar for next time', async () => {
    const t = await setup();
    await t.connect();
    const res = await t.req<GcalStatus>('POST', '/gcal/disconnect');
    expect(res.body).toMatchObject({ connected: false, needsReconnect: false });
    expect(res.body.calendarId).not.toBeNull();
    expect(t.google.revoked).toHaveLength(1);
    expect(t.db.select().from(gcalAccount).get()!.refreshTokenEnc).toBeNull();
    expect((await t.req('POST', '/gcal/resync')).status).toBe(409);
  });

  it('does not resurrect a token sealed with an old SESSION_SECRET', async () => {
    const t = await setup();
    await t.connect();
    t.db.update(gcalAccount).set({ refreshTokenEnc: 'v1.aaaa.bbbb.cccc' }).run();
    // A fresh service (as after a restart) has no access token cached.
    const { GcalService } = await import('./service');
    const fresh = new GcalService({
      db: t.db,
      config: t.config,
      timeZone: 'UTC',
      fetch: t.google.fetch,
    });
    await t.createSchedule();
    await fresh.syncNow();
    expect(fresh.status()).toMatchObject({ needsReconnect: true });
    expect(fresh.status().lastError).toMatch(/SESSION_SECRET/);
  });
});

describe('backoffMs', () => {
  it('doubles from 30 s and caps at 30 min', () => {
    expect([1, 2, 3, 4].map(backoffMs)).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(backoffMs(20)).toBe(30 * 60_000);
  });
});
