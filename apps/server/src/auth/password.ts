import { randomBytes, scrypt, timingSafeEqual, type BinaryLike } from 'node:crypto';

/**
 * Password hashes, self-describing so the cost (or the scheme) can change without breaking old
 * hashes:
 * - "scrypt$<N>$<salt>$<hash>": Node/Docker. N = 2^15 costs ~64 ms of CPU.
 * - "pbkdf2$<iterations>$<salt>$<hash>": Cloudflare Workers. WebCrypto PBKDF2-SHA256; 25,000
 *   iterations is ~4 ms, inside the Free plan's 10 ms CPU budget. That is weak against offline
 *   guessing if the hash leaks, so Workers insists on a long random ADMIN_PASSWORD (config.ts).
 * Salt and hash are base64url. verifyPassword accepts both schemes.
 */
export type PasswordScheme = 'scrypt' | 'pbkdf2';

const N = 2 ** 15;
const KEYLEN = 32;
const OPTS = { N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const PBKDF2_ITERATIONS = 25_000;

const scryptKey = (password: string, salt: BinaryLike) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, KEYLEN, OPTS, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );

/** PBKDF2-SHA256 over WebCrypto (global in Node 24 and workerd). */
export async function pbkdf2Key(
  password: string,
  salt: Uint8Array,
  iterations: number,
  length = KEYLEN,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password.normalize('NFKC')),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: Uint8Array.from(salt), iterations },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(
  password: string,
  scheme: PasswordScheme = 'scrypt',
): Promise<string> {
  const salt = randomBytes(16);
  if (scheme === 'pbkdf2') {
    const key = await pbkdf2Key(password, salt, PBKDF2_ITERATIONS);
    return `pbkdf2$${PBKDF2_ITERATIONS}$${salt.toString('base64url')}$${Buffer.from(key).toString('base64url')}`;
  }
  const key = await scryptKey(password, salt);
  return `scrypt$${N}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** The scheme a stored hash uses, or undefined if it isn't one of ours. */
export function schemeOf(stored: string): PasswordScheme | undefined {
  const scheme = stored.split('$')[0];
  return scheme === 'scrypt' || scheme === 'pbkdf2' ? scheme : undefined;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, cost, salt, hash] = stored.split('$');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  let actual: Uint8Array;
  if (scheme === 'scrypt' && Number(cost) === N) {
    actual = await scryptKey(password, Buffer.from(salt, 'base64url'));
  } else if (scheme === 'pbkdf2' && Number(cost) === PBKDF2_ITERATIONS) {
    actual = await pbkdf2Key(password, Buffer.from(salt, 'base64url'), PBKDF2_ITERATIONS);
  } else {
    return false;
  }
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
