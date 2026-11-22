import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHarness } from 'wrangler';

/**
 * Smoke test of the real Worker + Brain Durable Object in local workerd (wrangler's test
 * harness, Miniflare underneath), with LINKTAP_MOCK=true. Nothing leaves the machine, nothing
 * binds port 8787, and the real LinkTap API is never called.
 */

const here = dirname(fileURLToPath(import.meta.url));
const workerDir = join(here, '..');
const PASSWORD = 'smoke-test-password-0123456789';
const CSRF = { 'x-hoseidon-csrf': '1' };

/**
 * wrangler.jsonc with the static assets pointed at a tiny fixture, so the test doesn't need the
 * web app built first. Everything else (DO binding, SQLite migration, cron, flags) is the real
 * config.
 */
function testConfig(): string {
  const raw = readFileSync(join(workerDir, 'wrangler.jsonc'), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,(\s*[}\]])/g, '$1');
  const config = JSON.parse(raw) as Record<string, unknown> & { assets: Record<string, unknown> };
  const dir = join(workerDir, '.wrangler', 'smoke');
  const assets = join(dir, 'assets');
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(assets, 'index.html'), '<!doctype html><title>Hoseidon</title><div id=root>');
  const path = join(dir, 'wrangler.json');
  delete config.$schema;
  writeFileSync(
    path,
    JSON.stringify({
      ...config,
      main: join(workerDir, 'src/index.ts'),
      assets: { ...config.assets, directory: assets },
    }),
  );
  return path;
}

const server = createTestHarness({
  root: workerDir,
  workers: [
    {
      configPath: testConfig(),
      vars: { LINKTAP_MOCK: 'true', TZ: 'UTC' },
      secrets: {
        ADMIN_PASSWORD: PASSWORD,
        SESSION_SECRET: 's'.repeat(40),
        WEBHOOK_SECRET: 'w'.repeat(32),
      },
    },
  ],
});

let base = '';
let cookie = '';

async function sql<T>(query: string): Promise<T[]> {
  const storage = await server.getWorker().getDurableObjectStorage('Brain', { name: 'brain' });
  return (await storage.exec(query)) as T[];
}

async function until<T>(fn: () => Promise<T | undefined>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 250));
  }
}

beforeAll(async () => {
  const { url } = await server.listen();
  expect(url.port).not.toBe('8787');
  base = url.origin;
}, 120_000);

afterAll(async () => {
  await server.close();
});

describe('Worker (local workerd, mock LinkTap)', () => {
  it('serves the PWA from static assets, with SPA fallback', async () => {
    for (const path of ['/', '/settings', '/schedule/week']) {
      const res = await server.fetch(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('Hoseidon');
    }
  });

  it('GET /api/health answers from the Brain', async () => {
    const res = await server.fetch('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, name: 'hoseidon', mock: true });
  });

  it('applies the migrations and has foreign keys on', async () => {
    const tables = await sql<{ name: string }>(
      "select name from sqlite_master where type = 'table' order by name",
    );
    const names = tables.map((t) => t.name);
    for (const t of ['devices', 'planned_runs', 'sessions', 'timers', 'ephemeral']) {
      expect(names).toContain(t);
    }
    const [fk] = await sql<{ foreign_keys: number }>('PRAGMA foreign_keys');
    expect(fk?.foreign_keys).toBe(1);
  });

  it('refuses a mutation without the CSRF header at the edge', async () => {
    const res = await server.fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'missing CSRF header' });
  });

  it('logs in (PBKDF2 in workerd) and lists gateways once the alarm has polled', async () => {
    const res = await server.fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, ...CSRF },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(res.status).toBe(200);
    cookie = res.headers.get('set-cookie')!.split(';')[0]!;
    const [hash] = await sql<{ value: string }>(
      "select value from settings where key = 'auth.passwordHash'",
    );
    expect(hash?.value).toMatch(/^pbkdf2\$25000\$/);

    // Nobody called the poller: the alarm armed on the first request does the first poll.
    const gateways = await until(async () => {
      const r = await server.fetch('/api/gateways', { headers: { cookie } });
      expect(r.status).toBe(200);
      const list = (await r.json()) as { id: string; devices: unknown[] }[];
      return list.length ? list : undefined;
    });
    expect(gateways[0]!.devices.length).toBeGreaterThan(0);
  });

  it('keeps sessions and LinkTap limits across a Durable Object eviction', async () => {
    const before = await sql<{ value: string }>(
      "select value from settings where key = 'linktap.lastCall'",
    );
    const lanes = JSON.parse(before[0]!.value) as Record<string, number>;
    expect(lanes.devices).toBeGreaterThan(0);

    await server.getWorker().evictDurableObject('Brain', { name: 'brain' });
    const res = await server.fetch('/api/gateways', { headers: { cookie } });
    expect(res.status).toBe(200);
    // A few seconds of alarms later, the 5-minute devices lane is still the same call.
    await new Promise((r) => setTimeout(r, 3_000));
    const after = await sql<{ value: string }>(
      "select value from settings where key = 'linktap.lastCall'",
    );
    expect((JSON.parse(after[0]!.value) as Record<string, number>).devices).toBe(lanes.devices);
  });

  it('runs WebAuthn options and VAPID key generation inside workerd', async () => {
    const opts = await server.fetch('/api/auth/passkey/register/options', {
      method: 'POST',
      headers: { cookie, origin: base, ...CSRF },
    });
    expect(opts.status).toBe(200);
    const body = (await opts.json()) as { challengeId: string; options: { challenge: string } };
    expect(body.options.challenge.length).toBeGreaterThan(10);

    const push = await server.fetch('/api/push', { headers: { cookie } });
    expect(push.status).toBe(200);
    const { publicKey } = (await push.json()) as { publicKey: string };
    expect(publicKey).toMatch(/^B[A-Za-z0-9_-]{86}$/); // 65-byte uncompressed P-256 point
  });

  it('encrypts and sends a push from workerd (to a local sink, nothing leaves the box)', async () => {
    const sub = await server.fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: base, ...CSRF },
      body: JSON.stringify({
        // RFC 8291's example browser keys; the endpoint is this Worker, which answers 404.
        endpoint: `${base}/hooks/push-sink`,
        keys: {
          p256dh:
            'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
          auth: 'BTBZMqHH6r4Tts7J_aSIgg',
        },
      }),
    });
    expect(sub.status).toBe(200);
    const res = await server.fetch('/api/push/test', {
      method: 'POST',
      headers: { cookie, origin: base, ...CSRF },
    });
    expect(res.status).toBe(200);
    // The sink refused it (404), so it counts as failed, but encryption and VAPID ran.
    expect(await res.json()).toEqual({ sent: 0, failed: 1 });
  });

  it('creates a schedule and plans its runs (rrule + Intl time zones in workerd)', async () => {
    const res = await server.fetch('/api/schedules', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: base, ...CSRF },
      body: JSON.stringify({
        name: 'Morning',
        rrule: 'FREQ=DAILY',
        dtstart: '2026-06-10T06:00',
        timezone: 'America/New_York',
        items: [{ deviceId: 'B1C2D3E4F5A60011', seconds: 600 }],
      }),
    });
    expect(res.status).toBe(201);
    const planned = await sql<{ n: number }>(
      "select count(*) as n from planned_runs where status = 'planned'",
    );
    expect(planned[0]!.n).toBeGreaterThan(0);
  });

  it('accepts a LinkTap webhook with the right secret only', async () => {
    const hook = (secret: string) =>
      server.fetch(`/hooks/linktap/${secret}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event: 'wateringOff', deviceId: 'B1C2D3E4F5A60011' }),
      });
    expect((await hook('nope')).status).toBe(404);
    expect((await hook('w'.repeat(32))).status).toBe(200);
  });

  it('the cron watchdog finds a live alarm', async () => {
    const result = await server.getWorker().scheduled({ cron: '*/10 * * * *' });
    expect(result.outcome).toBe('ok');
  });
});
