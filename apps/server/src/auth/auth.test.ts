import { describe, expect, it } from 'vitest';
import { harness } from '../test-utils';
import { hashPassword, verifyPassword } from './password';
import { SESSION_TTL_MS } from './service';

const CSRF = { 'x-hoseidon-csrf': '1' };
const PASSWORD = 'correct horse battery';

async function secured(env: NodeJS.ProcessEnv = {}) {
  const h = harness({ auth: true, env: { ADMIN_PASSWORD: PASSWORD, ...env } });
  await h.auth.whenReady();
  return h;
}

const post =
  (app: { request: (p: string, i?: RequestInit) => Response | Promise<Response> }) =>
  (path: string, json: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...CSRF, ...headers },
      body: JSON.stringify(json),
    });

async function signIn(h: Awaited<ReturnType<typeof secured>>) {
  const res = await post(h.app)('/api/auth/login', { password: PASSWORD });
  expect(res.status).toBe(200);
  const cookie = res.headers.get('set-cookie') ?? '';
  return { cookie: cookie.split(';')[0]!, setCookie: cookie };
}

describe('password hashing', () => {
  it('verifies the right password and rejects others', async () => {
    const stored = await hashPassword('hunter2');
    expect(stored).toMatch(/^scrypt\$/);
    expect(await verifyPassword('hunter2', stored)).toBe(true);
    expect(await verifyPassword('hunter3', stored)).toBe(false);
    expect(await verifyPassword('hunter2', 'garbage')).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });
});

describe('API guard', () => {
  it('refuses /api without a session, but leaves health and the session probe open', async () => {
    const { app } = await secured();
    expect((await app.request('/api/devices')).status).toBe(401);
    expect((await app.request('/api/gateways')).status).toBe(401);
    expect((await app.request('/api/settings')).status).toBe(401);
    expect((await app.request('/api/health')).status).toBe(200);
    const probe = await app.request('/api/auth/session');
    expect(await probe.json()).toEqual({ authenticated: false, configured: true, passkeys: false });
  });

  it('lets the Google callback through (OAuth state is checked inside)', async () => {
    const { app } = await secured();
    const res = await app.request('/api/gcal/callback?error=access_denied');
    expect(res.status).not.toBe(401);
  });

  it('does not guard /hooks, which have their own secret', async () => {
    const { app } = await secured();
    const wrong = await app.request('/hooks/linktap/nope', { method: 'POST' });
    expect(wrong.status).toBe(404);
  });

  it('serves the API after login, using the httpOnly cookie', async () => {
    const h = await secured();
    const { cookie, setCookie } = await signIn(h);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).not.toMatch(/Secure/i); // PUBLIC_URL is http in tests
    const res = await h.app.request('/api/health', { headers: { cookie } });
    expect(res.status).toBe(200);
    const devices = await h.app.request('/api/gateways', { headers: { cookie } });
    expect(devices.status).toBe(200);
    const probe = await h.app.request('/api/auth/session', { headers: { cookie } });
    expect((await probe.json()).authenticated).toBe(true);
  });

  it('marks the cookie Secure when PUBLIC_URL is https', async () => {
    const h = await secured({ PUBLIC_URL: 'https://hose.example.com' });
    const { setCookie } = await signIn(h);
    expect(setCookie).toMatch(/Secure/i);
  });

  it('rejects a forged or unknown cookie', async () => {
    const { app } = await secured();
    const res = await app.request('/api/devices', {
      headers: { cookie: 'hoseidon_session=not-a-real-token' },
    });
    expect(res.status).toBe(401);
  });

  it('logout ends the session on the server', async () => {
    const h = await secured();
    const { cookie } = await signIn(h);
    const out = await post(h.app)('/api/auth/logout', {}, { cookie });
    expect(out.status).toBe(200);
    expect((await h.app.request('/api/devices', { headers: { cookie } })).status).toBe(401);
  });

  it('expires sessions after 30 days', async () => {
    let now = Date.now();
    const h = harness({ auth: true, env: { ADMIN_PASSWORD: PASSWORD } });
    // Rebuild the service with a controllable clock, sharing the same DB.
    const { AuthService } = await import('./service');
    const auth = new AuthService({ db: h.db, config: h.config, now: () => now });
    await auth.whenReady();
    const { token } = auth.createSession();
    expect(auth.isValid(token)).toBe(true);
    now += SESSION_TTL_MS + 1000;
    expect(auth.isValid(token)).toBe(false);
  });
});

describe('login', () => {
  it('rejects a wrong password with 401 and no cookie', async () => {
    const { app } = await secured();
    const res = await post(app)('/api/auth/login', { password: 'nope' });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('answers 503 while no admin password is configured', async () => {
    const h = harness({ auth: true });
    await h.auth.whenReady();
    const res = await post(h.app)('/api/auth/login', { password: 'anything' });
    expect(res.status).toBe(503);
    const probe = await h.app.request('/api/auth/session');
    expect((await probe.json()).configured).toBe(false);
  });

  it('throttles after repeated failures, even for the right password', async () => {
    const { app } = await secured();
    for (let i = 0; i < 8; i++) {
      expect((await post(app)('/api/auth/login', { password: `bad${i}` })).status).toBe(401);
    }
    const locked = await post(app)('/api/auth/login', { password: PASSWORD });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('picks up a changed ADMIN_PASSWORD and signs old sessions out', async () => {
    const h = await secured();
    const { cookie } = await signIn(h);
    const { AuthService } = await import('./service');
    const next = new AuthService({ db: h.db, config: { ...h.config, ADMIN_PASSWORD: 'new one' } });
    await next.whenReady();
    expect(h.auth.isValid(cookie.split('=')[1])).toBe(false);
    expect((await next.login(PASSWORD)).ok).toBe(false);
    expect((await next.login('new one')).ok).toBe(true);
  });
});

describe('CSRF', () => {
  it('refuses a mutating request without the CSRF header', async () => {
    const h = await secured();
    const { cookie } = await signIn(h);
    const res = await h.app.request('/api/settings', {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ timeZone: 'UTC' }),
    });
    expect(res.status).toBe(403);
  });

  it('refuses a request from another origin even with the header', async () => {
    const h = await secured();
    const { cookie } = await signIn(h);
    const res = await h.app.request('http://hose.local/api/settings', {
      method: 'PATCH',
      headers: {
        cookie,
        origin: 'https://evil.example',
        'content-type': 'application/json',
        ...CSRF,
      },
      body: JSON.stringify({ timeZone: 'UTC' }),
    });
    expect(res.status).toBe(403);
  });

  it('refuses a cross-site login attempt', async () => {
    const { app } = await secured();
    const res = await post(app)(
      '/api/auth/login',
      { password: PASSWORD },
      { origin: 'https://evil.example' },
    );
    expect(res.status).toBe(403);
  });

  it('accepts same-origin requests (Origin matches Host or PUBLIC_URL)', async () => {
    const h = await secured({ PUBLIC_URL: 'https://hose.example.com' });
    const { cookie } = await signIn(h);
    const patch = (origin: string, host?: string) =>
      h.app.request('/api/settings', {
        method: 'PATCH',
        headers: {
          cookie,
          origin,
          ...(host ? { host } : {}),
          'content-type': 'application/json',
          ...CSRF,
        },
        body: JSON.stringify({ timeZone: 'UTC' }),
      });
    expect((await patch('https://hose.example.com')).status).toBe(200);
    expect((await patch('http://localhost:5173', 'localhost:5173')).status).toBe(200);
  });

  it('does not ask for the header on reads', async () => {
    const h = await secured();
    const { cookie } = await signIn(h);
    expect((await h.app.request('/api/settings', { headers: { cookie } })).status).toBe(200);
  });
});

describe('passkeys', () => {
  it('offers passkey login only once one is registered', async () => {
    const { app } = await secured();
    expect((await post(app)('/api/auth/passkey/login/options', {})).status).toBe(404);
  });

  it('needs a session to start registration', async () => {
    const h = await secured();
    expect((await post(h.app)('/api/auth/passkey/register/options', {})).status).toBe(401);
    const { cookie } = await signIn(h);
    const res = await post(h.app)('/api/auth/passkey/register/options', {}, { cookie });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.options.rp.id).toBe('localhost');
    expect(json.challengeId).toBeTruthy();
  });

  it('refuses a bogus assertion and burns the challenge', async () => {
    const h = await secured();
    const { cookie } = await signIn(h);
    // Register is refused for garbage, which also exercises the one-shot challenge.
    const opts = await (
      await post(h.app)('/api/auth/passkey/register/options', {}, { cookie })
    ).json();
    const bad = await post(h.app)(
      '/api/auth/passkey/register/verify',
      { challengeId: opts.challengeId, response: { id: 'x' } },
      { cookie },
    );
    expect(bad.status).toBe(400);
    const replay = await post(h.app)(
      '/api/auth/passkey/register/verify',
      { challengeId: opts.challengeId, response: { id: 'x' } },
      { cookie },
    );
    expect(replay.status).toBe(400);
  });
});
