import { CSRF_HEADER } from '@hoseidon/shared';
import { MAX_API_BODY, MAX_HOOK_BODY } from '@hoseidon/server/runtime/brain';
import { PUBLIC } from '@hoseidon/server/auth/guard';
import {
  clientKey,
  cookieValue,
  hasValidSignature,
  safeEqual,
  SESSION_COOKIE,
} from '@hoseidon/server/auth/token';

export { MAX_API_BODY, MAX_HOOK_BODY };

/**
 * Cheap checks in the stateless Worker, so obvious junk never costs a Durable Object request
 * (100 k/day on Free). They mirror the DO-side guard (auth/guard.ts), which still runs: this is
 * only a filter, never the authority.
 *
 * Why it matters: the Free plan caps Durable Object requests at 100k/day and alarm runs count
 * toward the same cap, so anonymous junk forwarded to the Brain could use up the day's quota and
 * stop the scheduler. Hence the webhook secret and the session cookie are checked here too
 * (the cookie's HMAC under SESSION_SECRET; the Brain keeps the authoritative database lookup).
 */

/** The secrets and the rate-limit binding the edge needs. */
export interface EdgeEnv {
  WEBHOOK_SECRET?: string;
  SESSION_SECRET?: string;
  /** Workers rate-limiting binding (Free plan); absent in tests and local dev. */
  AUTH_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> };
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
// A declared Content-Length over the cap is refused here for free; the Brain also counts the
// bytes it actually reads (runtime/brain.ts limitBody), so a missing or lying header can't
// get a bigger body through.

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

const json = (status: number, error: string) => Response.json({ error }, { status });

/** null = pass it on to the Brain; otherwise the response to send right away. */
export async function edgeCheck(request: Request, env: EdgeEnv = {}): Promise<Response | null> {
  const url = new URL(request.url);
  const length = Number(request.headers.get('content-length') ?? 0);

  if (url.pathname.startsWith('/hooks/')) {
    if (request.method !== 'POST') return json(404, 'not found');
    // Same 404 for a wrong secret as the Brain gives; never wake the object for it.
    const given = url.pathname.slice('/hooks/linktap/'.length);
    const ok = url.pathname.startsWith('/hooks/linktap/') && !given.includes('/');
    if (!env.WEBHOOK_SECRET || !ok || !safeEqual(decode(given), env.WEBHOOK_SECRET)) {
      return json(404, 'not found');
    }
    if (length > MAX_HOOK_BODY) return json(413, 'payload too large');
    return null;
  }

  if (length > MAX_API_BODY) return json(413, 'payload too large');
  if (SAFE.has(request.method)) return gate(request, url, env);
  // Mutations need the custom header (a cross-site page can't add it without a preflight we
  // never approve) and, when the browser names one, our own origin.
  if (request.headers.get(CSRF_HEADER) !== '1') return json(403, 'missing CSRF header');
  const origin = request.headers.get('origin');
  if (origin && origin !== 'null') {
    let host = '';
    try {
      host = new URL(origin).host;
    } catch {
      // falls through to the rejection
    }
    if (host !== url.host) return json(403, 'cross-site request refused');
  } else if (request.headers.get('sec-fetch-site') === 'cross-site') {
    return json(403, 'cross-site request refused');
  }
  return gate(request, url, env);
}

/** Session cookie (when sessions are signed) and the per-client limit on public routes. */
async function gate(request: Request, url: URL, env: EdgeEnv): Promise<Response | null> {
  const path = url.pathname.slice('/api'.length) || '/';
  const isPublic = PUBLIC.some((p) => p.method === request.method && p.path === path);
  if (!isPublic) {
    const token = cookieValue(request.headers.get('cookie'), SESSION_COOKIE);
    // Without SESSION_SECRET (mock/dev) tokens are unsigned and only the Brain can tell.
    if (env.SESSION_SECRET && !hasValidSignature(token, env.SESSION_SECRET)) {
      return json(401, 'unauthorized');
    }
    return null;
  }
  if (env.AUTH_LIMITER && path !== '/gcal/callback') {
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    const { success } = await env.AUTH_LIMITER.limit({ key: clientKey(ip) });
    if (!success) return json(429, 'too many requests');
  }
  return null;
}
