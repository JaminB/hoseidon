import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { harness } from '../test-utils';
import { passkeys, sessions, users } from '../db/schema';
import { FakeOidc, type AuthorizeOptions } from './fake-oidc';
import { safeNext } from './service';
import { SIGNIN_SCOPE } from './google';

const CSRF = { 'x-hoseidon-csrf': '1' };
const CLIENT_ID = 'client-123.apps.googleusercontent.com';
const PUBLIC_URL = 'https://hose.example.com';
const OWNER = 'owner@example.com';

const GOOGLE_ENV = {
  GOOGLE_CLIENT_ID: CLIENT_ID,
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  // Messy on purpose: trimmed and lowercased, list form.
  ADMIN_EMAIL: ' Owner@Example.com , ',
  PUBLIC_URL,
  ADMIN_PASSWORD: 'a-password-that-must-be-ignored',
};

async function setup(env: NodeJS.ProcessEnv = {}) {
  const google = await FakeOidc.create(CLIENT_ID);
  const logs: string[] = [];
  const h = harness({ auth: true, env: { ...GOOGLE_ENV, ...env }, authFetch: google.fetch });
  await h.auth.whenReady();
  return { ...h, google, logs };
}
type H = Awaited<ReturnType<typeof setup>>;

const cookieOf = (res: Response, name: string) => {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    if (pair!.startsWith(`${name}=`)) return pair!;
  }
  return undefined;
};

/** start -> Google -> callback, like a browser. Returns the callback response and session cookie. */
async function signIn(h: H, o: AuthorizeOptions & { next?: string; tamper?: 'replay' }) {
  const start = await h.app.request(
    `/api/auth/google/start${o.next ? `?next=${encodeURIComponent(o.next)}` : ''}`,
  );
  expect(start.status).toBe(302);
  const location = start.headers.get('location')!;
  const stateCookie = cookieOf(start, 'hoseidon_signin')!;
  const state = new URL(location).searchParams.get('state')!;
  const code = h.google.authorize(location, o);
  const callback = (c = code) =>
    h.app.request(
      `/api/auth/google/callback?code=${encodeURIComponent(c)}&state=${encodeURIComponent(state)}`,
      { headers: { cookie: stateCookie } },
    );
  const res = await callback();
  const session = cookieOf(res, 'hoseidon_session');
  return { res, session, location, state, stateCookie, callback };
}

const reason = (res: Response) => new URL(res.headers.get('location')!).searchParams.get('signin');

const json = (h: H, method: string, path: string, cookie?: string, body?: unknown) =>
  h.app.request(path, {
    method,
    headers: {
      ...CSRF,
      'content-type': 'application/json',
      origin: h.config.PUBLIC_URL,
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('Google sign-in: start', () => {
  it('redirects to Google with OIDC + PKCE parameters and binds the state to a cookie', async () => {
    const h = await setup();
    const res = await h.app.request('/api/auth/google/start');
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get('location')!);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const q = url.searchParams;
    expect(q.get('client_id')).toBe(CLIENT_ID);
    expect(q.get('redirect_uri')).toBe(`${PUBLIC_URL}/api/auth/google/callback`);
    expect(q.get('response_type')).toBe('code');
    expect(q.get('scope')).toBe(SIGNIN_SCOPE);
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toMatch(/^[\w-]{43}$/);
    expect(q.get('nonce')).toMatch(/^[\w-]{32}$/);
    const state = q.get('state')!;
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('hoseidon_signin='))!;
    expect(cookie).toContain(`hoseidon_signin=${state}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\/api\/auth\/google/);
  });

  it('redirects to a friendly error when Google sign-in is not configured', async () => {
    const h = harness({ auth: true, env: { ADMIN_PASSWORD: 'correct horse battery' } });
    const res = await h.app.request('/api/auth/google/start');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://localhost:8787/?signin=not_configured');
  });

  it('keeps only same-site paths as the destination', () => {
    expect(safeNext('/schedule?x=1')).toBe('/schedule?x=1');
    for (const bad of [
      '//evil.example',
      'https://evil.example',
      '/\\evil.example',
      '',
      'x',
      '/a b',
    ])
      expect(safeNext(bad)).toBe('/');
    expect(safeNext(undefined)).toBe('/');
  });
});

describe('Google sign-in: callback', () => {
  it('signs an invited admin in and returns to `next`', async () => {
    const h = await setup();
    const { res, session } = await signIn(h, { email: 'OWNER@example.com', next: '/schedule' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${PUBLIC_URL}/schedule`);
    expect(session).toBeDefined();
    // The state cookie is cleared.
    expect(res.headers.getSetCookie().some((c) => /^hoseidon_signin=;/.test(c))).toBe(true);
    const probe = await (
      await h.app.request('/api/auth/session', { headers: { cookie: session! } })
    ).json();
    expect(probe).toMatchObject({
      authenticated: true,
      google: true,
      password: false,
      email: OWNER,
      name: 'Test Person',
      picture: 'https://example.com/avatar.png',
      role: 'admin',
    });
    expect((await h.app.request('/api/gateways', { headers: { cookie: session! } })).status).toBe(
      200,
    );
    const row = h.db.select().from(users).where(eq(users.email, OWNER)).get()!;
    expect(row.lastLoginAt).toBeInstanceOf(Date);
    expect(h.db.select().from(sessions).all()[0]!.userEmail).toBe(OWNER);
  });

  it('accepts the bare issuer form too', async () => {
    const h = await setup();
    const { session } = await signIn(h, { email: OWNER, claims: { iss: 'accounts.google.com' } });
    expect(session).toBeDefined();
  });

  const refused: [
    string,
    Partial<AuthorizeOptions> | (() => Promise<Partial<AuthorizeOptions>>),
  ][] = [
    ['a bad signature', async () => ({ signWith: await FakeOidc.strayKey() })],
    ['an unknown key id', { kid: 'nope' }],
    [
      'the wrong audience',
      { claims: { aud: 'someone-else.apps.googleusercontent.com', azp: undefined } },
    ],
    ['the wrong authorized party', { claims: { aud: [CLIENT_ID, 'other'], azp: 'other' } }],
    ['the wrong issuer', { claims: { iss: 'https://evil.example.com' } }],
    ['an expired token', { claims: { exp: Math.floor(Date.now() / 1000) - 120 } }],
    ['a token from the future', { claims: { iat: Math.floor(Date.now() / 1000) + 600 } }],
    ['a nonce mismatch', { claims: { nonce: 'not-the-nonce' } }],
    ['a missing nonce', { claims: { nonce: undefined } }],
    ['an unverified email', { claims: { email_verified: false } }],
    ['email_verified as a string', { claims: { email_verified: 'true' } }],
  ];
  for (const [what, opts] of refused) {
    it(`refuses ${what} without creating a session`, async () => {
      const h = await setup();
      const extra = typeof opts === 'function' ? await opts() : opts;
      const { res, session } = await signIn(h, { email: OWNER, ...extra });
      expect(res.status).toBe(302);
      expect(reason(res)).toBe('failed');
      expect(session).toBeUndefined();
      expect(h.db.select().from(sessions).all()).toHaveLength(0);
    });
  }

  it('tolerates a little clock skew on exp', async () => {
    const h = await setup();
    const { session } = await signIn(h, {
      email: OWNER,
      claims: { exp: Math.floor(Date.now() / 1000) - 10 },
    });
    expect(session).toBeDefined();
  });

  it('turns away a verified Google account that is not invited', async () => {
    const h = await setup();
    const { res, session } = await signIn(h, { email: 'stranger@example.com' });
    expect(res.headers.get('location')).toBe(`${PUBLIC_URL}/?signin=not_invited`);
    expect(session).toBeUndefined();
    expect(h.db.select().from(sessions).all()).toHaveLength(0);
    expect(
      h.db
        .select()
        .from(users)
        .all()
        .map((u) => u.email),
    ).toEqual([OWNER]);
  });

  it('uses each state once: a replayed callback is refused', async () => {
    const h = await setup();
    const first = await signIn(h, { email: OWNER });
    expect(first.session).toBeDefined();
    const again = await first.callback();
    expect(reason(again)).toBe('expired');
    expect(cookieOf(again, 'hoseidon_session')).toBeUndefined();
    expect(h.google.tokenCalls).toBe(1);
  });

  it('refuses a callback from a browser that did not start the sign-in', async () => {
    const h = await setup();
    const start = await h.app.request('/api/auth/google/start');
    const location = start.headers.get('location')!;
    const state = new URL(location).searchParams.get('state')!;
    const code = h.google.authorize(location, { email: OWNER });
    const res = await h.app.request(`/api/auth/google/callback?code=${code}&state=${state}`);
    expect(reason(res)).toBe('expired');
    expect(h.google.tokenCalls).toBe(0);
    // And the state is spent, so the right browser can't finish it later either.
    const later = await h.app.request(`/api/auth/google/callback?code=${code}&state=${state}`, {
      headers: { cookie: cookieOf(start, 'hoseidon_signin')! },
    });
    expect(reason(later)).toBe('expired');
  });

  it('reports a cancelled consent screen', async () => {
    const h = await setup();
    const res = await h.app.request('/api/auth/google/callback?error=access_denied&state=x');
    expect(reason(res)).toBe('cancelled');
  });

  it('caches the JWKS and refetches when Google rotates its key', async () => {
    const h = await setup();
    await signIn(h, { email: OWNER });
    await signIn(h, { email: OWNER });
    expect(h.google.jwksCalls).toBe(1);
    await h.google.rotate('key-2');
    const { session } = await signIn(h, { email: OWNER });
    expect(session).toBeDefined();
    expect(h.google.jwksCalls).toBe(2);
  });
});

describe('password sign-in', () => {
  it('is gone when Google sign-in is configured, even with ADMIN_PASSWORD set', async () => {
    const h = await setup();
    const res = await json(h, 'POST', '/api/auth/login', undefined, {
      password: GOOGLE_ENV.ADMIN_PASSWORD,
    });
    expect(res.status).toBe(410);
    expect(cookieOf(res, 'hoseidon_session')).toBeUndefined();
    const probe = await (await h.app.request('/api/auth/session')).json();
    expect(probe).toMatchObject({ configured: true, google: true, password: false });
  });

  it('still works when Google sign-in is not configured', async () => {
    const h = harness({ auth: true, env: { ADMIN_PASSWORD: 'correct horse battery' } });
    await h.auth.whenReady();
    const res = await json(h as never, 'POST', '/api/auth/login', undefined, {
      password: 'correct horse battery',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      authenticated: true,
      google: false,
      password: true,
      email: null,
      role: 'admin',
    });
  });

  it('ends password-admin sessions and ignores their passkeys once Google sign-in is on', async () => {
    const before = harness({ auth: true, env: { ADMIN_PASSWORD: 'correct horse battery' } });
    await before.auth.whenReady();
    const { token } = before.auth.createSession(null);
    before.db
      .insert(passkeys)
      .values({ id: 'legacy', name: 'Old', publicKey: 'x', userEmail: null })
      .run();
    expect(before.auth.hasPasskeys).toBe(true);
    const { AuthService } = await import('./service');
    const { loadConfig } = await import('../config');
    const after = new AuthService({
      db: before.db,
      config: loadConfig({ ...GOOGLE_ENV, LINKTAP_MOCK: 'true' }),
    });
    await after.whenReady();
    expect(after.isValid(token)).toBe(false);
    expect(before.db.select().from(sessions).all()).toHaveLength(0);
    expect(after.hasPasskeys).toBe(false);
  });
});

describe('admin user management', () => {
  async function asOwner() {
    const h = await setup();
    const { session } = await signIn(h, { email: OWNER });
    return { h, owner: session! };
  }

  it('lists, invites, changes roles and removes users', async () => {
    const { h, owner } = await asOwner();
    const list = await (await json(h, 'GET', '/api/admin/users', owner)).json();
    expect(list).toEqual([
      expect.objectContaining({ email: OWNER, role: 'admin', protected: true, disabled: false }),
    ]);

    const added = await json(h, 'POST', '/api/admin/users', owner, {
      email: ' Friend@Example.com ',
    });
    expect(added.status).toBe(201);
    expect(await added.json()).toMatchObject({
      email: 'friend@example.com',
      role: 'member',
      addedBy: OWNER,
      protected: false,
      lastLoginAt: null,
    });
    const dup = await json(h, 'POST', '/api/admin/users', owner, { email: 'friend@example.com' });
    expect(dup.status).toBe(409);
    const bad = await json(h, 'POST', '/api/admin/users', owner, { email: 'not-an-email' });
    expect(bad.status).toBe(400);

    // The friend can sign in now, as a member: the app works, the admin API doesn't.
    const friend = (await signIn(h, { email: 'friend@example.com' })).session!;
    expect((await json(h, 'GET', '/api/gateways', friend)).status).toBe(200);
    expect((await json(h, 'GET', '/api/admin/users', friend)).status).toBe(403);
    expect(
      (await json(h, 'POST', '/api/admin/users', friend, { email: 'x@example.com' })).status,
    ).toBe(403);

    const promoted = await json(h, 'PATCH', '/api/admin/users/friend@example.com', owner, {
      role: 'admin',
    });
    expect(await promoted.json()).toMatchObject({ role: 'admin' });
    // Takes effect on the existing session at once.
    expect((await json(h, 'GET', '/api/admin/users', friend)).status).toBe(200);

    const removed = await json(h, 'DELETE', '/api/admin/users/friend@example.com', owner);
    expect(removed.status).toBe(200);
    expect((await removed.json()).map((u: { email: string }) => u.email)).toEqual([OWNER]);
    expect((await json(h, 'DELETE', '/api/admin/users/friend@example.com', owner)).status).toBe(
      404,
    );
  });

  it('never removes, demotes or disables an ADMIN_EMAIL account', async () => {
    const { h, owner } = await asOwner();
    expect((await json(h, 'DELETE', `/api/admin/users/${OWNER}`, owner)).status).toBe(403);
    expect(
      (
        await json(
          h,
          'DELETE',
          `/api/admin/users/${encodeURIComponent('OWNER@example.com')}`,
          owner,
        )
      ).status,
    ).toBe(403);
    expect(
      (await json(h, 'PATCH', `/api/admin/users/${OWNER}`, owner, { role: 'member' })).status,
    ).toBe(403);
    expect(
      (await json(h, 'PATCH', `/api/admin/users/${OWNER}`, owner, { disabled: true })).status,
    ).toBe(403);
    expect(h.auth.user(OWNER)).toMatchObject({ role: 'admin', disabled: false });
  });

  it('removing a user ends their sessions and deletes their passkeys at once', async () => {
    const { h, owner } = await asOwner();
    await json(h, 'POST', '/api/admin/users', owner, { email: 'friend@example.com' });
    const friend = (await signIn(h, { email: 'friend@example.com' })).session!;
    h.db
      .insert(passkeys)
      .values({ id: 'pk-friend', name: 'Phone', publicKey: 'x', userEmail: 'friend@example.com' })
      .run();
    h.db
      .insert(passkeys)
      .values({ id: 'pk-owner', name: 'Laptop', publicKey: 'x', userEmail: OWNER })
      .run();
    expect((await json(h, 'GET', '/api/gateways', friend)).status).toBe(200);

    await json(h, 'DELETE', '/api/admin/users/friend@example.com', owner);
    expect((await json(h, 'GET', '/api/gateways', friend)).status).toBe(401);
    expect(
      h.db
        .select()
        .from(passkeys)
        .all()
        .map((p) => p.id),
    ).toEqual(['pk-owner']);
    // And they can't come back with Google either.
    const again = await signIn(h, { email: 'friend@example.com' });
    expect(reason(again.res)).toBe('not_invited');
  });

  it('disabling a user ends their sessions and passkeys; enabling lets them sign in again', async () => {
    const { h, owner } = await asOwner();
    await json(h, 'POST', '/api/admin/users', owner, { email: 'friend@example.com' });
    const friend = (await signIn(h, { email: 'friend@example.com' })).session!;
    h.db
      .insert(passkeys)
      .values({ id: 'pk-friend', name: 'Phone', publicKey: 'x', userEmail: 'friend@example.com' })
      .run();
    const off = await json(h, 'PATCH', '/api/admin/users/friend@example.com', owner, {
      disabled: true,
    });
    expect(await off.json()).toMatchObject({ disabled: true });
    expect((await json(h, 'GET', '/api/gateways', friend)).status).toBe(401);
    expect(h.db.select().from(passkeys).all()).toHaveLength(0);
    expect(reason((await signIn(h, { email: 'friend@example.com' })).res)).toBe('not_invited');
    await json(h, 'PATCH', '/api/admin/users/friend@example.com', owner, { disabled: false });
    expect((await signIn(h, { email: 'friend@example.com' })).session).toBeDefined();
  });

  it('needs a session, and the CSRF header on changes', async () => {
    const { h, owner } = await asOwner();
    expect((await h.app.request('/api/admin/users')).status).toBe(401);
    const noCsrf = await h.app.request('/api/admin/users', {
      method: 'POST',
      headers: { cookie: owner, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'x@example.com' }),
    });
    expect(noCsrf.status).toBe(403);
  });
});

describe('passkeys per user', () => {
  it('registration needs a signed-in user and is bound to them', async () => {
    const h = await setup();
    expect((await json(h, 'POST', '/api/auth/passkey/register/options')).status).toBe(401);
    const { session } = await signIn(h, { email: OWNER });
    const res = await json(h, 'POST', '/api/auth/passkey/register/options', session);
    expect(res.status).toBe(200);
    const { options } = (await res.json()) as { options: { user: { name: string } } };
    expect(options.user.name).toBe(OWNER);
  });

  it('lists and deletes only your own passkeys', async () => {
    const h = await setup();
    const { session } = await signIn(h, { email: OWNER });
    h.db
      .insert(passkeys)
      .values([
        { id: 'mine', name: 'Laptop', publicKey: 'x', userEmail: OWNER },
        { id: 'theirs', name: 'Phone', publicKey: 'x', userEmail: 'other@example.com' },
      ])
      .run();
    const list = await (await json(h, 'GET', '/api/auth/passkeys', session)).json();
    expect(list.map((p: { id: string }) => p.id)).toEqual(['mine']);
    expect((await json(h, 'DELETE', '/api/auth/passkeys/theirs', session)).status).toBe(404);
    expect((await json(h, 'DELETE', '/api/auth/passkeys/mine', session)).status).toBe(200);
  });

  it('a passkey of a user who is no longer allowed is refused before verification', async () => {
    const h = await setup();
    h.db
      .insert(passkeys)
      .values({ id: 'ghost', name: 'Old', publicKey: 'x', userEmail: 'gone@example.com' })
      .run();
    const { challengeId } = await h.auth.authenticationOptions();
    const s = await h.auth.loginWithPasskey(challengeId, { id: 'ghost' } as never);
    expect(s).toBeNull();
  });
});
