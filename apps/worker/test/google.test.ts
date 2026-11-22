import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHarness } from 'wrangler';
import { testConfig, workerDir } from './config';

/**
 * Google sign-in in local workerd: the start redirect, the callback's refusals and the edge's
 * public routes. Nothing here reaches Google: every callback is refused before the token
 * exchange (no valid state), and the start is only a redirect. The OIDC verification itself
 * (WebCrypto RS256) is covered by apps/server's tests with a fake Google.
 */

const CLIENT_ID = 'client-123.apps.googleusercontent.com';
const CSRF = { 'x-hoseidon-csrf': '1' };

const server = createTestHarness({
  root: workerDir,
  workers: [
    {
      configPath: testConfig('smoke-google'),
      vars: { LINKTAP_MOCK: 'true', TZ: 'UTC', GOOGLE_CLIENT_ID: CLIENT_ID },
      secrets: {
        GOOGLE_CLIENT_SECRET: 'test-client-secret',
        ADMIN_EMAIL: 'owner@example.com',
        // Ignored: Google sign-in replaces the password.
        ADMIN_PASSWORD: 'smoke-test-password-0123456789',
        SESSION_SECRET: 's'.repeat(40),
        WEBHOOK_SECRET: 'w'.repeat(32),
      },
    },
  ],
});

let base = '';

beforeAll(async () => {
  const { url } = await server.listen();
  base = url.origin;
}, 120_000);

afterAll(async () => {
  await server.close();
});

describe('Worker with Google sign-in (local workerd)', () => {
  it('reports Google sign-in on the session probe, with password sign-in off', async () => {
    const res = await server.fetch('/api/auth/session');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      authenticated: false,
      configured: true,
      google: true,
      password: false,
    });
  });

  it('starts the OIDC flow: a redirect to Google with PKCE, nonce and a state cookie', async () => {
    // Plain fetch with redirect: 'manual', so the test never follows the redirect to Google.
    const res = await fetch(`${base}/api/auth/google/start?next=%2Fschedule`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get('location')!);
    expect(url.host).toBe('accounts.google.com');
    const q = url.searchParams;
    expect(q.get('client_id')).toBe(CLIENT_ID);
    expect(q.get('redirect_uri')).toBe(`${base}/api/auth/google/callback`);
    expect(q.get('scope')).toBe('openid email profile');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('nonce')).toBeTruthy();
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`hoseidon_signin=${q.get('state')}`);
  });

  it('refuses a callback with an unknown state without calling Google', async () => {
    const res = await fetch(`${base}/api/auth/google/callback?code=abc&state=forged`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${base}/?signin=expired`);
    expect(res.headers.get('set-cookie') ?? '').not.toContain('hoseidon_session=');
  });

  it('answers password login with 410', async () => {
    const res = await server.fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, ...CSRF },
      body: JSON.stringify({ password: 'smoke-test-password-0123456789' }),
    });
    expect(res.status).toBe(410);
  });

  it('keeps the admin API behind the signed cookie at the edge', async () => {
    const res = await server.fetch('/api/admin/users');
    expect(res.status).toBe(401);
  });
});
