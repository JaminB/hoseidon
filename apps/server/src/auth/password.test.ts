import { pbkdf2Sync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashPassword, pbkdf2Key, PBKDF2_ITERATIONS, schemeOf, verifyPassword } from './password';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('PBKDF2 (WebCrypto)', () => {
  it('matches the RFC 7914 section 11 PBKDF2-HMAC-SHA256 vector', async () => {
    const key = await pbkdf2Key('passwd', new TextEncoder().encode('salt'), 1, 64);
    expect(hex(key)).toBe(
      '55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc' +
        '49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783',
    );
  });

  it('agrees with node:crypto pbkdf2Sync at the production cost', async () => {
    const salt = new Uint8Array(16).fill(7);
    const key = await pbkdf2Key('correct horse battery staple', salt, PBKDF2_ITERATIONS);
    expect(hex(key)).toBe(
      pbkdf2Sync('correct horse battery staple', salt, PBKDF2_ITERATIONS, 32, 'sha256').toString(
        'hex',
      ),
    );
  });
});

describe('hashPassword / verifyPassword', () => {
  it('round-trips both schemes and tells them apart', async () => {
    for (const scheme of ['pbkdf2', 'scrypt'] as const) {
      const stored = await hashPassword('a-long-random-password', scheme);
      expect(schemeOf(stored)).toBe(scheme);
      expect(stored.split('$')).toHaveLength(4);
      expect(await verifyPassword('a-long-random-password', stored)).toBe(true);
      expect(await verifyPassword('a-long-random-passwore', stored)).toBe(false);
    }
  });

  it('uses a fresh salt each time', async () => {
    const [a, b] = await Promise.all([hashPassword('x', 'pbkdf2'), hashPassword('x', 'pbkdf2')]);
    expect(a).not.toBe(b);
  });

  it('rejects unknown schemes, other costs and junk', async () => {
    const stored = await hashPassword('pw', 'pbkdf2');
    const [, , salt, hash] = stored.split('$');
    expect(await verifyPassword('pw', `pbkdf2$1000$${salt}$${hash}`)).toBe(false);
    expect(await verifyPassword('pw', `bcrypt$10$${salt}$${hash}`)).toBe(false);
    expect(await verifyPassword('pw', 'garbage')).toBe(false);
    expect(schemeOf('garbage')).toBeUndefined();
  });
});
