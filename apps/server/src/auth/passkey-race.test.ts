import { beforeEach, describe, expect, it, vi } from 'vitest';
import { harness } from '../test-utils';
import { passkeys, sessions } from '../db/schema';

// Verification is stubbed so the test can remove the user while it is still pending.
const gate = vi.hoisted(() => ({
  release: null as null | (() => void),
  wait: null as null | Promise<void>,
}));
vi.mock('@simplewebauthn/server', async (orig) => {
  const real = await orig<typeof import('@simplewebauthn/server')>();
  const pending = async (result: unknown) => {
    await gate.wait;
    return result;
  };
  return {
    ...real,
    verifyAuthenticationResponse: vi.fn(() =>
      pending({ verified: true, authenticationInfo: { newCounter: 1 } }),
    ),
    verifyRegistrationResponse: vi.fn(() =>
      pending({
        verified: true,
        registrationInfo: {
          credential: { id: 'new-pk', publicKey: new Uint8Array([1]), counter: 0 },
        },
      }),
    ),
  };
});

const OWNER = 'owner@example.com';
const FRIEND = 'friend@example.com';

async function setup() {
  const h = harness({
    auth: true,
    env: {
      GOOGLE_CLIENT_ID: 'c.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 's',
      ADMIN_EMAIL: OWNER,
      PUBLIC_URL: 'https://hose.example.com',
    },
  });
  await h.auth.whenReady();
  h.auth.addUser(FRIEND, 'member', OWNER);
  gate.wait = new Promise<void>((r) => (gate.release = r));
  return h;
}

describe('removal while passkey verification is pending', () => {
  beforeEach(() => {
    gate.release = null;
    gate.wait = null;
  });

  it('a passkey login finishing after removal creates no session', async () => {
    const h = await setup();
    h.db
      .insert(passkeys)
      .values({ id: 'pk', name: 'Phone', publicKey: 'AQ', userEmail: FRIEND })
      .run();
    const { challengeId } = await h.auth.authenticationOptions();
    const login = h.auth.loginWithPasskey(challengeId, { id: 'pk' } as never);
    h.auth.removeUser(FRIEND);
    gate.release!();
    expect(await login).toBeNull();
    expect(h.db.select().from(sessions).all()).toHaveLength(0);
  });

  it('a passkey registration finishing after removal stores nothing', async () => {
    const h = await setup();
    const { challengeId } = await h.auth.registrationOptions(FRIEND);
    const reg = h.auth.registerPasskey(challengeId, {} as never, 'Phone', FRIEND);
    h.auth.removeUser(FRIEND);
    gate.release!();
    expect(await reg).toBe(false);
    expect(h.db.select().from(passkeys).all()).toHaveLength(0);
  });
});
