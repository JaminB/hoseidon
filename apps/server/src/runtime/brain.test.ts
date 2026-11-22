import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CSRF_HEADER } from '@hoseidon/shared';
import { openDb } from '../db';
import { getSetting, lastCalls } from '../db/kv';
import { gateways, timers } from '../db/schema';
import type { LinkTapClient } from '../linktap/client';
import { MOCK_IDS } from '../linktap/mock';
import { BrainCore, MAX_ALARM_GAP_MS, PUBLIC_URL_KEY, type AlarmPort } from './brain';
import { TASK_COST, WHEEL } from './wheel';

/**
 * The Cloudflare host's Durable Object logic, run on better-sqlite3. "Eviction" = throwing the
 * BrainCore away and building a new one over the same database, which is exactly what a deploy
 * or an idle eviction does to the real object (memory gone, SQLite and the alarm kept).
 */

const T0 = Date.parse('2026-06-10T06:00:00Z');
const MIN = 60_000;
const ORIGIN = 'https://hoseidon.example.workers.dev';
const PASSWORD = 'correct-horse-battery-staple-42';
const ENV = {
  LINKTAP_MOCK: 'true',
  ADMIN_PASSWORD: PASSWORD,
  SESSION_SECRET: 's'.repeat(40),
  WEBHOOK_SECRET: 'w'.repeat(32),
  TZ: 'UTC',
};

class FakeAlarm implements AlarmPort {
  at: number | null = null;
  sets = 0;
  async get() {
    return this.at;
  }
  async set(at: number) {
    this.at = at;
    this.sets++;
  }
}

function setup(env: Record<string, unknown> = ENV) {
  const { db } = openDb(':memory:');
  const alarm = new FakeAlarm();
  const logs: string[] = [];
  const make = (linktap?: LinkTapClient) =>
    new BrainCore({ db, env, alarm, log: (m) => logs.push(m), linktap });
  return { db, alarm, logs, make };
}

const deviceCalls = (b: BrainCore) =>
  b.services.mock!.calls.filter((c) => c.endpoint === 'getAllDevices').length;

async function login(brain: BrainCore): Promise<string> {
  const res = await brain.fetch(
    new Request(`${ORIGIN}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1', origin: ORIGIN },
      body: JSON.stringify({ password: PASSWORD }),
    }),
  );
  expect(res.status).toBe(200);
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

describe('BrainCore alarm wheel', () => {
  it('first alarm polls LinkTap, then re-arms at the next due time', async () => {
    const { db, alarm, make } = setup();
    const brain = make();
    await brain.alarm();
    expect(db.select().from(gateways).all().length).toBeGreaterThan(0);
    expect(deviceCalls(brain)).toBe(1);
    // Saved before the call went out, then overwritten with the finish time.
    expect(lastCalls(db).devices).toBe(T0);
    expect(alarm.at).toBeGreaterThan(T0);
    expect(alarm.at).toBeLessThanOrEqual(T0 + MAX_ALARM_GAP_MS);
    expect(alarm.at).toBe(brain.nextAlarmAt());
  });

  it('computes due times from persisted state: devices every 5 min, status per outlet', async () => {
    const { make } = setup();
    const brain = make();
    await brain.alarm();
    const due = brain.wheel.dueTimes(Date.now());
    expect(due.devices).toBe(T0 + 5 * MIN);
    // The mock seeds a running lawn: its status lane is next, 31 s after its last call.
    expect(due.status).not.toBeNull();
    // The engine ticked at T0 with nothing planned: idle cadence.
    expect(due.engine).toBe(T0 + WHEEL.engineIdleMs);
  });

  it('keeps every LinkTap limit across an eviction', async () => {
    const { db, make } = setup();
    await make().alarm();
    const statusLanes = Object.keys(lastCalls(db)).filter((k) => k.startsWith('status:'));

    // Deploy one minute later: a new object, empty memory, same SQLite.
    vi.setSystemTime(T0 + MIN);
    const revived = make();
    const due = revived.wheel.dueTimes(Date.now());
    expect(due.devices).toBe(T0 + 5 * MIN);
    for (const lane of statusLanes) {
      const id = lane.slice('status:'.length);
      expect(revived.services.linktap.nextAvailableAt('status', id).getTime()).toBe(
        lastCalls(db)[lane]! + 31_000,
      );
    }
    for (let i = 0; i < 3; i++) await revived.alarm();
    expect(deviceCalls(revived)).toBe(0);

    vi.setSystemTime(T0 + 5 * MIN);
    await revived.alarm();
    expect(deviceCalls(revived)).toBe(1);
  });

  it('a one-off timer survives an eviction and fires once', async () => {
    const { db, make } = setup();
    const brain = make();
    await brain.alarm();
    brain.wheel.schedule(`reconcile:${MOCK_IDS.frontLawn}`, new Date(T0 + 5_000));
    expect(brain.wheel.dueTimes(Date.now()).timers).toBe(T0 + 5_000);

    const revived = make();
    expect(revived.wheel.dueTimes(Date.now()).timers).toBe(T0 + 5_000);
    vi.setSystemTime(T0 + 6_000);
    const ran = await revived.wheel.runDue(Date.now());
    expect(ran).toContain('timers');
    expect(db.select().from(timers).all()).toEqual([]);
  });

  it('retries a failing one-off timer a few times, then drops it', async () => {
    const { db, make } = setup();
    const brain = make();
    let calls = 0;
    brain.services.poller.reconcileHistory = async () => {
      calls++;
      throw new Error('boom');
    };
    brain.wheel.schedule(`reconcile:${MOCK_IDS.frontLawn}`, new Date(T0));
    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(T0 + i * MIN);
      await brain.wheel.runDue(Date.now());
    }
    expect(calls).toBe(3);
    expect(db.select().from(timers).all()).toEqual([]);
  });

  it('ticks the engine every 30 s around a planned run, every 5 min otherwise', async () => {
    const { make } = setup();
    const brain = make();
    await brain.alarm();
    const cookie = await login(brain);
    const res = await brain.fetch(
      new Request(`${ORIGIN}/api/schedules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1', cookie },
        body: JSON.stringify({
          name: 'Morning',
          rrule: 'FREQ=DAILY',
          dtstart: '2026-06-10T06:03',
          timezone: 'UTC',
          items: [{ deviceId: MOCK_IDS.dripA, seconds: 600 }],
        }),
      }),
    );
    expect(res.status).toBe(201);
    // Next occurrence 06:03: wake a minute before it (instead of the idle 06:05)...
    expect(brain.wheel.dueTimes(Date.now()).engine).toBe(T0 + 2 * MIN);

    // ...then tick every 30 s while it is close or running.
    vi.setSystemTime(T0 + 2 * MIN);
    await brain.services.scheduler.tick();
    expect(brain.wheel.dueTimes(Date.now()).engine).toBe(T0 + 2 * MIN + WHEEL.engineActiveMs);
  });

  it('runs at most a budget of work per wake and leaves the rest for the next one', async () => {
    const { make } = setup();
    const brain = make();
    const wakes: string[][] = [];
    for (let t = T0; t < T0 + 30 * MIN; t += 15_000) {
      vi.setSystemTime(t);
      const ran = await brain.wheel.runDue(Date.now());
      if (ran.length) wakes.push(ran);
      const spent = ran.reduce((n, task) => n + TASK_COST[task], 0);
      if (ran.length > 1) expect(spent).toBeLessThanOrEqual(WHEEL.budget);
    }
    // Work that didn't fit ran on a later wake: everything got its turn.
    const all = new Set(wakes.flat());
    for (const task of ['status', 'engine', 'devices', 'history', 'push']) {
      expect(all).toContain(task);
    }
    expect(wakes.flat().filter((t) => t === 'devices')).toHaveLength(6); // every 5 min
  });

  it('the cron watchdog re-arms a missing or long-overdue alarm, and leaves a live one', async () => {
    const { alarm, make } = setup();
    const brain = make();
    expect(await brain.ensureAlarm()).toMatchObject({ rearmed: true });
    const armed = alarm.at;
    expect(armed).not.toBeNull();
    expect(await brain.ensureAlarm()).toEqual({ alarmAt: armed, rearmed: false });
    vi.setSystemTime(armed! + 3 * MIN); // six failed retries later, it never fired
    expect(await brain.ensureAlarm()).toMatchObject({ rearmed: true });
    expect(alarm.at).toBeGreaterThan(Date.now());
  });
});

describe('BrainCore requests', () => {
  it('serves health, login and gateways (LINKTAP_MOCK) and adopts the first origin', async () => {
    const { db, make } = setup();
    const brain = make();
    const health = await brain.fetch(new Request(`${ORIGIN}/api/health`));
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, mock: true });
    expect(getSetting(db, PUBLIC_URL_KEY)).toBe(ORIGIN);
    expect(brain.publicUrl).toBe(ORIGIN);

    expect((await brain.fetch(new Request(`${ORIGIN}/api/gateways`))).status).toBe(401);
    await brain.alarm();
    const cookie = await login(brain);
    expect(cookie).toMatch(/^hoseidon_session=/);
    const res = await brain.fetch(new Request(`${ORIGIN}/api/gateways`, { headers: { cookie } }));
    expect(res.status).toBe(200);
    const list = (await res.json()) as { id: string; devices: unknown[] }[];
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]!.devices.length).toBeGreaterThan(0);

    // A second host doesn't steal PUBLIC_URL (set it explicitly to change it).
    await brain.fetch(new Request('https://other.example.com/api/health'));
    expect(brain.publicUrl).toBe(ORIGIN);
  });

  it('stores the password as PBKDF2 and keeps the login throttle across an eviction', async () => {
    const { db, make } = setup();
    const brain = make();
    await brain.fetch(new Request(`${ORIGIN}/api/health`));
    expect(getSetting(db, 'auth.passwordHash')).toMatch(/^pbkdf2\$25000\$/);
    const wrong = (b: BrainCore) =>
      b.fetch(
        new Request(`${ORIGIN}/api/auth/login`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [CSRF_HEADER]: '1',
            'cf-connecting-ip': '203.0.113.9',
          },
          body: JSON.stringify({ password: 'nope' }),
        }),
      );
    for (let i = 0; i < 8; i++) expect((await wrong(brain)).status).toBe(401);
    const revived = make();
    expect((await wrong(revived)).status).toBe(429);
  });

  it('counts body bytes as they are read, whatever Content-Length says', async () => {
    const { make } = setup();
    const brain = make();
    const chunk = new Uint8Array(64 * 1024).fill(32);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent++ < 8) c.enqueue(chunk);
        else c.close();
      },
    });
    const res = await brain.fetch(
      new Request(`${ORIGIN}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1' },
        body,
        duplex: 'half',
      } as RequestInit),
    );
    expect(res.status).toBe(413);
    expect(sent).toBeLessThan(8); // gave up reading early
  });

  it('a webhook makes push due, and moves the alarm earlier', async () => {
    const { alarm, make } = setup();
    const brain = make();
    await brain.alarm();
    await brain.wheel.runDue(Date.now()); // flush the first push cursor
    expect(brain.wheel.dueTimes(Date.now()).push).toBeNull();
    // A fresh object finds the alarm far out (it reads it once, then tracks it).
    alarm.at = Date.now() + 9 * MIN;
    const revived = make();
    const res = await revived.fetch(
      new Request(`${ORIGIN}/hooks/linktap/${'w'.repeat(32)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          event: 'wateringOn',
          gatewayId: MOCK_IDS.backyard,
          deviceId: MOCK_IDS.frontLawn,
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(alarm.at).toBe(Date.now() + 1_000);
  });

  it('refuses to run real taps with weak secrets, without touching LinkTap', async () => {
    const { make } = setup({
      LINKTAP_MOCK: 'false',
      LINKTAP_USERNAME: 'someone',
      LINKTAP_API_KEY: 'not-a-real-key',
      ADMIN_PASSWORD: 'short-password',
      SESSION_SECRET: 's'.repeat(40),
      ENGINE_ENABLED: 'true',
    });
    const forbidden = () => {
      throw new Error('must not call LinkTap');
    };
    const stub = new Proxy({} as LinkTapClient, {
      get: (_t, key) => (key === 'nextAvailableAt' ? () => new Date() : forbidden),
    });
    const brain = make(stub);
    expect(brain.engineOn).toBe(false);
    expect(brain.problems.join()).toMatch(/ADMIN_PASSWORD/);
    expect((await brain.fetch(new Request(`${ORIGIN}/api/health`))).status).toBe(200);
    expect((await brain.fetch(new Request(`${ORIGIN}/api/gateways`))).status).toBe(503);
    await brain.alarm();
  });

  it('keeps the engine off with real taps unless ENGINE_ENABLED=true', () => {
    const stub = new Proxy({} as LinkTapClient, { get: () => () => new Date() });
    const env = {
      ...ENV,
      LINKTAP_MOCK: 'false',
      LINKTAP_USERNAME: 'someone',
      LINKTAP_API_KEY: 'k',
    };
    expect(setup(env).make(stub).engineOn).toBe(false);
    expect(setup({ ...env, ENGINE_ENABLED: 'true' }).make(stub).engineOn).toBe(true);
    expect(setup(ENV).make().engineOn).toBe(true);
  });
});
