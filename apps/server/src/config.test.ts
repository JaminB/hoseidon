import { describe, expect, it } from 'vitest';
import { adminEmails, googleSignInConfigured, insecureConfig, loadConfig } from './config';

describe('insecureConfig', () => {
  it('flags the .env.example placeholders and short secrets', () => {
    const config = loadConfig({
      ADMIN_PASSWORD: 'change-me',
      WEBHOOK_SECRET: 'change-me-too',
      SESSION_SECRET: 'change-me-to-a-long-random-string',
    });
    expect(insecureConfig(config)).toHaveLength(3);
    expect(
      insecureConfig(loadConfig({ ADMIN_PASSWORD: 'short', WEBHOOK_SECRET: 'x'.repeat(15) })),
    ).toHaveLength(2);
  });

  it('accepts strong values and unset ones', () => {
    expect(insecureConfig(loadConfig({}))).toEqual([]);
    expect(
      insecureConfig(
        loadConfig({
          ADMIN_PASSWORD: 'a-long-enough-password',
          WEBHOOK_SECRET: 'w'.repeat(32),
          SESSION_SECRET: 's'.repeat(32),
        }),
      ),
    ).toEqual([]);
  });

  it('ignores ADMIN_PASSWORD once Google sign-in is configured', () => {
    const google = {
      GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'secret',
      ADMIN_EMAIL: 'owner@example.com',
    };
    expect(insecureConfig(loadConfig({ ...google, ADMIN_PASSWORD: 'short' }))).toEqual([]);
    expect(insecureConfig(loadConfig(google), { requireSignIn: true })).toEqual([]);
  });

  it('requires some way to sign in when asked (Workers with real taps)', () => {
    expect(insecureConfig(loadConfig({}), { requireSignIn: true }).join()).toMatch(/no sign-in/);
    expect(
      insecureConfig(loadConfig({ ADMIN_PASSWORD: 'a-long-enough-password' }), {
        requireSignIn: true,
      }),
    ).toEqual([]);
    // A Google client without an admin email is not sign-in.
    expect(
      insecureConfig(loadConfig({ GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'y' }), {
        requireSignIn: true,
      }),
    ).toHaveLength(1);
  });
});

describe('ADMIN_EMAIL', () => {
  it('is a normalized, de-duplicated list', () => {
    const config = loadConfig({ ADMIN_EMAIL: ' A@Example.com,b@example.com, a@example.com ,junk' });
    expect(adminEmails(config)).toEqual(['a@example.com', 'b@example.com']);
  });

  it('turns Google sign-in on only together with the client id and secret', () => {
    expect(googleSignInConfigured(loadConfig({ ADMIN_EMAIL: 'a@example.com' }))).toBe(false);
    expect(
      googleSignInConfigured(
        loadConfig({
          ADMIN_EMAIL: 'a@example.com',
          GOOGLE_CLIENT_ID: 'x',
          GOOGLE_CLIENT_SECRET: 'y',
        }),
      ),
    ).toBe(true);
  });
});
