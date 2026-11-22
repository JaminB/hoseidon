import { createDecipheriv, createECDH, hkdfSync } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHarness } from 'wrangler';

/**
 * Smoke test of the real Worker + Brain Durable Object in local workerd (wrangler's test
 * harness, Miniflare underneath), with LINKTAP_MOCK=true. Nothing leaves the machine, nothing
 * binds port 8787, and the real LinkTap API is never called. Each test signs in and waits for
 * the first poll itself (memoized), so any test can run on its own.
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

async function sql<T>(query: string): Promise<T[]> {
  const storage = await server.getWorker().getDurableObjectStorage('Brain', { name: 'brain' });
  return (await storage.exec(query)) as T[];
}

async function until<T>(fn: () => Promise<T | undefined> | T | undefined, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Signed in once, on first use. */
let session: Promise<string> | undefined;
const login = () =>
  (session ??= (async () => {
    const res = await server.fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, ...CSRF },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(res.status).toBe(200);
    return res.headers.get('set-cookie')!.split(';')[0]!;
  })());

/** Gateways, once the alarm (armed by the first request, nothing else) has polled LinkTap. */
let polled: Promise<{ id: string; devices: unknown[] }[]> | undefined;
const firstPoll = () =>
  (polled ??= (async () => {
    const cookie = await login();
    return until(async () => {
      const r = await server.fetch('/api/gateways', { headers: { cookie } });
      expect(r.status).toBe(200);
      const list = (await r.json()) as { id: string; devices: unknown[] }[];
      return list.length ? list : undefined;
    });
  })());

/** RFC 8291 Appendix A browser keys: the test knows the private key, so it can decrypt. */
const UA = {
  private: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  public: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
};

/** RFC 8291 decryption with node:crypto, as the browser would do it. */
function decrypt(body: Buffer): string {
  const salt = body.subarray(0, 16);
  const idlen = body[20]!;
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(UA.private, 'base64url'));
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]);
  const secret = ecdh.computeSecret(asPublic);
  const ikm = hkdfSync('sha256', secret, Buffer.from(UA.auth, 'base64url'), info, 32);
  const cek = hkdfSync('sha256', ikm, salt, 'Content-Encoding: aes128gcm\0', 16);
  const nonce = hkdfSync('sha256', ikm, salt, 'Content-Encoding: nonce\0', 12);
  const d = createDecipheriv('aes-128-gcm', Buffer.from(cek), Buffer.from(nonce));
  d.setAuthTag(ct.subarray(-16));
  const plain = Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]);
  return plain.subarray(0, -1).toString('utf8');
}

/** A local stand-in for a browser push service (127.0.0.1, random port). */
const pushes: { headers: IncomingHttpHeaders; body: Buffer }[] = [];
let sink: Server | undefined;
let sinkUrl = '';

beforeAll(async () => {
  const s = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      pushes.push({ headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(201).end();
    });
  });
  sink = s;
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  sinkUrl = `http://127.0.0.1:${(s.address() as AddressInfo).port}/push/abc`;

  const { url } = await server.listen();
  expect(url.port).not.toBe('8787');
  base = url.origin;
}, 120_000);

afterAll(async () => {
  await server.close();
  await new Promise((r) => (sink ? sink.close(r) : r(undefined)));
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
    expect(await login()).toMatch(/^hoseidon_session=/);
    const [hash] = await sql<{ value: string }>(
      "select value from settings where key = 'auth.passwordHash'",
    );
    expect(hash?.value).toMatch(/^pbkdf2\$25000\$/);
    // Nobody called the poller: the alarm armed on the first request does the first poll.
    const gateways = await firstPoll();
    expect(gateways[0]!.devices.length).toBeGreaterThan(0);
  });

  it('keeps sessions and LinkTap limits across a Durable Object eviction', async () => {
    const cookie = await login();
    await firstPoll();
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
    const cookie = await login();
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

  it('encrypts and sends a push from workerd that a browser could decrypt', async () => {
    const cookie = await login();
    const sub = await server.fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: base, ...CSRF },
      body: JSON.stringify({ endpoint: sinkUrl, keys: { p256dh: UA.public, auth: UA.auth } }),
    });
    expect(sub.status).toBe(200);
    const res = await server.fetch('/api/push/test', {
      method: 'POST',
      headers: { cookie, origin: base, ...CSRF },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 1, failed: 0 });
    expect(pushes).toHaveLength(1);
    const push = pushes[0]!;
    expect(push.headers['content-encoding']).toBe('aes128gcm');
    expect(push.headers.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=B[\w-]{86}$/);
    expect(JSON.parse(decrypt(push.body))).toMatchObject({ title: 'Hoseidon', tag: 'test' });
  });

  it('creates a schedule and plans its runs (rrule + Intl time zones in workerd)', async () => {
    const cookie = await login();
    await firstPoll();
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

  it('the cron watchdog asks the Brain for its alarm', async () => {
    await firstPoll();
    server.clearLogs();
    const result = await server.getWorker().scheduled({ cron: '*/10 * * * *' });
    expect(result.outcome).toBe('ok');
    // ensureAlarm really ran in the Brain and reported a live alarm.
    const line = await until(() =>
      server
        .getLogs()
        .map((l) => l.message)
        .find((m) => m.includes('watchdog: alarm at')),
    );
    const at = Date.parse(/alarm at (\S+)/.exec(line)![1]!);
    expect(at).toBeGreaterThan(Date.now() - 2 * 60_000);
  });
});
