import { randomBytes, scrypt, timingSafeEqual, type BinaryLike } from 'node:crypto';

const N = 2 ** 15;
const KEYLEN = 32;
const OPTS = { N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

const derive = (password: string, salt: BinaryLike) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, KEYLEN, OPTS, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );

/** "scrypt$<N>$<salt>$<hash>" (base64url), so the cost can change later without breaking old hashes. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$${N}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || Number(n) !== N || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await derive(password, Buffer.from(salt, 'base64url'));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
