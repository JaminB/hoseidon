import { CSRF_HEADER } from '@hoseidon/shared';

/**
 * Cheap checks in the stateless Worker, so obvious junk never costs a Durable Object request
 * (100 k/day on Free). They mirror the DO-side guard (auth/guard.ts), which still runs: this is
 * only a filter, never the authority.
 */

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Biggest body the API takes (schedules, WebAuthn payloads are a few KB). */
export const MAX_API_BODY = 256 * 1024;
/** LinkTap webhooks are tiny JSON objects. */
export const MAX_HOOK_BODY = 16 * 1024;

const json = (status: number, error: string) => Response.json({ error }, { status });

/** null = pass it on to the Brain; otherwise the response to send right away. */
export function edgeCheck(request: Request): Response | null {
  const url = new URL(request.url);
  const length = Number(request.headers.get('content-length') ?? 0);

  if (url.pathname.startsWith('/hooks/')) {
    if (request.method !== 'POST') return json(404, 'not found');
    if (length > MAX_HOOK_BODY) return json(413, 'payload too large');
    return null;
  }

  if (length > MAX_API_BODY) return json(413, 'payload too large');
  if (SAFE.has(request.method)) return null;
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
  return null;
}
