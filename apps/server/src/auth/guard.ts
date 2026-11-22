import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { CSRF_HEADER } from '@hoseidon/shared';
import type { AuthService } from './service';

import { SESSION_COOKIE } from './token';

export { SESSION_COOKIE };

/** /api paths that work without a session. (/hooks/* is not under /api and has its own secret.) */
export const PUBLIC: { method: string; path: string }[] = [
  { method: 'GET', path: '/health' },
  { method: 'GET', path: '/auth/session' },
  { method: 'POST', path: '/auth/login' },
  { method: 'POST', path: '/auth/logout' },
  { method: 'POST', path: '/auth/passkey/login/options' },
  { method: 'POST', path: '/auth/passkey/login/verify' },
  // Google sign-in: browser navigations. The start writes one ephemeral row; the callback is
  // validated by its single-use state (bound to a cookie), PKCE and the ID token.
  { method: 'GET', path: '/auth/google/start' },
  { method: 'GET', path: '/auth/google/callback' },
  // Google redirects the browser here; the OAuth `state` is what's validated.
  { method: 'GET', path: '/gcal/callback' },
];

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Hosts a browser may legitimately send as the Origin of a same-site request. */
function allowedHosts(publicUrl: string, req: Request): Set<string> {
  const hosts = new Set<string>();
  for (const h of [req.headers.get('host'), req.headers.get('x-forwarded-host')]) {
    if (h) hosts.add(h.split(',')[0]!.trim());
  }
  try {
    hosts.add(new URL(publicUrl).host);
  } catch {
    // ignore a malformed PUBLIC_URL
  }
  return hosts;
}

/**
 * Session check plus CSRF defence for everything under /api.
 *
 * Cookies are SameSite=Lax, and every mutating request must (a) come from our own origin when the
 * browser says where it came from, and (b) carry a custom header, which a cross-site page cannot
 * add without a CORS preflight that we never approve.
 */
export function apiGuard(opts: { auth: AuthService; publicUrl: string }): MiddlewareHandler {
  return async (c, next) => {
    const path = c.req.path.replace(/^\/api/, '') || '/';

    if (!SAFE_METHODS.has(c.req.method)) {
      const origin = c.req.header('origin');
      if (origin && origin !== 'null') {
        let host = '';
        try {
          host = new URL(origin).host;
        } catch {
          // falls through to the rejection below
        }
        if (!allowedHosts(opts.publicUrl, c.req.raw).has(host)) {
          return c.json({ error: 'cross-site request refused' }, 403);
        }
      } else if (c.req.header('sec-fetch-site') === 'cross-site') {
        return c.json({ error: 'cross-site request refused' }, 403);
      }
      if (c.req.header(CSRF_HEADER) !== '1') {
        return c.json({ error: 'missing CSRF header' }, 403);
      }
    }

    if (PUBLIC.some((p) => p.method === c.req.method && p.path === path)) return next();
    if (!opts.auth.isValid(getCookie(c, SESSION_COOKIE))) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    return next();
  };
}
