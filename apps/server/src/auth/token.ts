import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'hoseidon_session';

const mac = (secret: string, data: string) =>
  createHmac('sha256', secret).update(data).digest('base64url');

/** Constant-time string compare (hashes first, so length does not leak). */
export function safeEqual(a: string, b: string): boolean {
  const h = (v: string) => createHash('sha256').update(v).digest();
  return timingSafeEqual(h(a), h(b));
}

/** `id.HMAC(secret, id)`: a session token the stateless edge can check without the database. */
export function signToken(id: string, secret: string): string {
  return `${id}.${mac(secret, id)}`;
}

/** True when `token` was made by signToken with this secret. */
export function hasValidSignature(token: string | undefined, secret: string): boolean {
  if (!token || !secret) return false;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return false;
  return safeEqual(token.slice(dot + 1), mac(secret, token.slice(0, dot)));
}

/** Value of one cookie from a Cookie header. */
export function cookieValue(header: string | null, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** HMAC fingerprint of a password under a server secret (cheap "did it change" check). */
export const fingerprint = mac;

/** Rate-limit key for an address: IPv6 clients are grouped by /64 (one subscriber holds a whole one). */
export function clientKey(ip: string): string {
  if (!ip.includes(':') || ip.includes('.')) return ip;
  const [head = '', tail = ''] = ip.toLowerCase().split('::');
  const a = head ? head.split(':') : [];
  const b = tail ? tail.split(':') : [];
  const groups = ip.includes('::')
    ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b]
    : a;
  return (
    groups
      .slice(0, 4)
      .map((g) => g.padStart(4, '0'))
      .join(':') + '::/64'
  );
}
