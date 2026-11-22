import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE, signToken } from '@hoseidon/server/auth/token';
import { edgeCheck, MAX_API_BODY, MAX_HOOK_BODY, type EdgeEnv } from '../src/edge';

const req = (path: string, init: RequestInit = {}) =>
  new Request(`https://hose.example.com${path}`, init);

const SECRET = 's'.repeat(40);
const HOOK = 'w'.repeat(32);
const env: EdgeEnv = { WEBHOOK_SECRET: HOOK, SESSION_SECRET: SECRET };
const cookie = (token: string) => ({ cookie: `${SESSION_COOKIE}=${token}` });
const good = cookie(signToken('abc', SECRET));
const CSRF = { 'x-hoseidon-csrf': '1' };

describe('edgeCheck', () => {
  it('passes signed-in reads and well-formed mutations through', async () => {
    expect(await edgeCheck(req('/api/gateways', { headers: good }), env)).toBeNull();
    expect(
      await edgeCheck(
        req('/api/schedules', {
          method: 'POST',
          headers: { ...CSRF, ...good, origin: 'https://hose.example.com' },
        }),
        env,
      ),
    ).toBeNull();
    expect(await edgeCheck(req(`/hooks/linktap/${HOOK}`, { method: 'POST' }), env)).toBeNull();
  });

  it('refuses mutations without the CSRF header or from another origin', async () => {
    const missing = await edgeCheck(req('/api/auth/login', { method: 'POST' }), env);
    expect(missing?.status).toBe(403);
    const foreign = await edgeCheck(
      req('/api/auth/login', {
        method: 'POST',
        headers: { ...CSRF, origin: 'https://evil.example.net' },
      }),
      env,
    );
    expect(foreign?.status).toBe(403);
    expect(await foreign?.json()).toEqual({ error: 'cross-site request refused' });
    const crossSite = await edgeCheck(
      req('/api/auth/login', {
        method: 'POST',
        headers: { ...CSRF, 'sec-fetch-site': 'cross-site' },
      }),
      env,
    );
    expect(crossSite?.status).toBe(403);
  });

  it('caps body sizes and only takes POSTs on /hooks', async () => {
    const big = (n: number) => ({ 'content-length': String(n), ...CSRF, ...good });
    expect(
      (await edgeCheck(req('/api/x', { method: 'POST', headers: big(MAX_API_BODY + 1) }), env))
        ?.status,
    ).toBe(413);
    expect(
      (
        await edgeCheck(
          req(`/hooks/linktap/${HOOK}`, { method: 'POST', headers: big(MAX_HOOK_BODY + 1) }),
          env,
        )
      )?.status,
    ).toBe(413);
    expect((await edgeCheck(req(`/hooks/linktap/${HOOK}`), env))?.status).toBe(404);
  });

  // Regression: anonymous junk must never reach the Durable Object (100k requests/day on Free).
  it('answers a wrong or missing webhook secret without the Brain', async () => {
    const post = (path: string, e: EdgeEnv = env) => edgeCheck(req(path, { method: 'POST' }), e);
    expect((await post('/hooks/linktap/wrong'))?.status).toBe(404);
    expect((await post(`/hooks/linktap/${HOOK}x`))?.status).toBe(404);
    expect((await post(`/hooks/linktap/${HOOK}/extra`))?.status).toBe(404);
    expect((await post('/hooks/other/' + HOOK))?.status).toBe(404);
    expect((await post(`/hooks/linktap/${HOOK}`, {}))?.status).toBe(404); // no secret set
  });

  it('answers a missing, unsigned or foreign session cookie without the Brain', async () => {
    const get = (headers: Record<string, string> = {}, e: EdgeEnv = env) =>
      edgeCheck(req('/api/devices', { headers }), e);
    expect((await get())?.status).toBe(401);
    expect((await get(cookie('rawtokenwithoutsignature')))?.status).toBe(401);
    expect((await get(cookie(signToken('abc', 'x'.repeat(40)))))?.status).toBe(401);
    expect((await get(cookie(signToken('abc', SECRET) + 'a')))?.status).toBe(401);
    expect(await get(good)).toBeNull();
    // Unsigned sessions (no SESSION_SECRET: mock/dev): the Brain decides.
    expect(await get({}, {})).toBeNull();
    // Public routes need no cookie.
    expect(await edgeCheck(req('/api/health'), env)).toBeNull();
    expect(await edgeCheck(req('/api/auth/session'), env)).toBeNull();
  });

  it('rate-limits public routes per client, grouping IPv6 by /64', async () => {
    const seen: string[] = [];
    let allow = true;
    const limited: EdgeEnv = {
      ...env,
      AUTH_LIMITER: {
        limit: async ({ key }) => {
          seen.push(key);
          return { success: allow };
        },
      },
    };
    const login = (ip: string) =>
      edgeCheck(
        req('/api/auth/login', { method: 'POST', headers: { ...CSRF, 'cf-connecting-ip': ip } }),
        limited,
      );
    expect(await login('2001:db8:1:2:aaaa::1')).toBeNull();
    expect(await login('2001:db8:1:2:bbbb::9')).toBeNull();
    expect(seen[0]).toBe(seen[1]);
    allow = false;
    expect((await login('203.0.113.7'))?.status).toBe(429);
    // Signed-in routes are not limited here.
    seen.length = 0;
    expect(await edgeCheck(req('/api/devices', { headers: good }), limited)).toBeNull();
    expect(seen).toEqual([]);
  });
});

describe('edgeCheck: Google sign-in and the admin API', () => {
  const limiter = (allow: () => boolean, seen: string[] = []): EdgeEnv => ({
    ...env,
    AUTH_LIMITER: {
      limit: async ({ key }) => {
        seen.push(key);
        return { success: allow() };
      },
    },
  });

  it('lets the sign-in navigations through without a cookie, rate limited per client', async () => {
    let allow = true;
    const seen: string[] = [];
    const e = limiter(() => allow, seen);
    const nav = (path: string) =>
      edgeCheck(req(path, { headers: { 'cf-connecting-ip': '203.0.113.9' } }), e);
    expect(await nav('/api/auth/google/start?next=%2Fschedule')).toBeNull();
    expect(await nav('/api/auth/google/callback?code=abc&state=xyz')).toBeNull();
    expect(seen).toEqual(['203.0.113.9', '203.0.113.9']);
    allow = false;
    expect((await nav('/api/auth/google/start'))?.status).toBe(429);
    expect((await nav('/api/auth/google/callback?code=abc&state=xyz'))?.status).toBe(429);
  });

  it('only GETs are public there', async () => {
    const res = await edgeCheck(
      req('/api/auth/google/start', { method: 'POST', headers: { ...CSRF } }),
      env,
    );
    expect(res?.status).toBe(401);
  });

  it('needs a signed session cookie for the admin API (never the Brain without one)', async () => {
    const e = limiter(() => true);
    expect((await edgeCheck(req('/api/admin/users'), e))?.status).toBe(401);
    expect(
      (await edgeCheck(req('/api/admin/users', { headers: cookie('unsigned') }), e))?.status,
    ).toBe(401);
    expect(await edgeCheck(req('/api/admin/users', { headers: good }), e)).toBeNull();
    const del = await edgeCheck(
      req('/api/admin/users/friend%40example.com', {
        method: 'DELETE',
        headers: { ...good, origin: 'https://hose.example.com' },
      }),
      e,
    );
    expect(del?.status).toBe(403); // no CSRF header
  });
});

describe('migrations.gen.ts', () => {
  it('matches apps/server/drizzle (run `pnpm --filter @hoseidon/worker gen` after db:generate)', () => {
    const script = join(dirname(fileURLToPath(import.meta.url)), '../scripts/gen-migrations.mjs');
    expect(() =>
      execFileSync(process.execPath, [script, '--check'], { stdio: 'pipe' }),
    ).not.toThrow();
  });
});
