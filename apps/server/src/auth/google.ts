import { z } from 'zod';
import { AUTH_URL, GOOGLE_TIMEOUT_MS, TOKEN_URL, type OAuthClient } from '../gcal/oauth';

/**
 * "Sign in with Google": OpenID Connect authorization-code flow (state + nonce + PKCE S256) and
 * ID token validation with WebCrypto only, so it runs the same on Node and in workerd.
 *
 * The ID token arrives straight from Google's token endpoint over TLS, but it is still verified
 * in full (signature against Google's JWKS, iss, aud/azp, exp/iat, nonce, email_verified).
 */

export const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
export const SIGNIN_SCOPE = 'openid email profile';
export const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
/** Clock skew allowed on exp and iat. */
export const CLOCK_SKEW_SEC = 60;
/** JWKS cache lifetime when Google sends no usable Cache-Control. */
const DEFAULT_JWKS_TTL_MS = 3600_000;

export function signinUrl(
  client: OAuthClient,
  p: { state: string; nonce: string; challenge: string },
): string {
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: 'code',
    scope: SIGNIN_SCOPE,
    state: p.state,
    nonce: p.nonce,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
    // Let people with several Google accounts pick the invited one.
    prompt: 'select_account',
  }).toString();
  return url.toString();
}

export class IdTokenError extends Error {}

const tokenResponseSchema = z.object({ id_token: z.string().min(1) });

/** Code -> ID token (the access token is not used: the profile is in the ID token). */
export async function exchangeSigninCode(
  fetchImpl: typeof fetch,
  client: OAuthClient,
  code: string,
  verifier: string,
): Promise<string> {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: client.redirectUri,
    }).toString(),
    signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
  });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const code = (json as { error?: unknown } | null)?.error;
    throw new IdTokenError(`token exchange failed: ${typeof code === 'string' ? code : res.status}`);
  }
  const parsed = tokenResponseSchema.safeParse(json);
  if (!parsed.success) throw new IdTokenError('token response has no id_token');
  return parsed.data.id_token;
}

// ---- JWKS ---------------------------------------------------------------------------------------

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

/** Google's signing keys, cached for as long as Cache-Control allows; refetched on an unknown kid. */
export class Jwks {
  #keys = new Map<string, Promise<CryptoKey>>();
  #expiresAt = 0;
  #inflight: Promise<void> | null = null;

  constructor(
    private readonly opts: { fetch: typeof fetch; now?: () => number; url?: string },
  ) {}

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  async key(kid: string): Promise<CryptoKey> {
    if (this.now() >= this.#expiresAt || !this.#keys.has(kid)) await this.refresh();
    const key = this.#keys.get(kid);
    if (!key) throw new IdTokenError('unknown signing key');
    return key;
  }

  private refresh(): Promise<void> {
    this.#inflight ??= this.load().finally(() => {
      this.#inflight = null;
    });
    return this.#inflight;
  }

  private async load(): Promise<void> {
    const res = await this.opts.fetch(this.opts.url ?? JWKS_URL, {
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    });
    if (!res.ok) throw new IdTokenError(`JWKS fetch failed: ${res.status}`);
    const body = (await res.json().catch(() => null)) as { keys?: Jwk[] } | null;
    const keys = new Map<string, Promise<CryptoKey>>();
    for (const jwk of body?.keys ?? []) {
      if (!jwk.kid || jwk.kty !== 'RSA' || !jwk.n || !jwk.e) continue;
      if (jwk.alg && jwk.alg !== 'RS256') continue;
      if (jwk.use && jwk.use !== 'sig') continue;
      const imported = crypto.subtle.importKey(
        'jwk',
        { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      );
      imported.catch(() => {}); // a bad key only fails when it is used
      keys.set(jwk.kid, imported);
    }
    this.#keys = keys;
    this.#expiresAt = this.now() + maxAgeMs(res.headers.get('cache-control'));
  }
}

function maxAgeMs(cacheControl: string | null): number {
  const m = /(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl ?? '');
  if (!m || /no-store|no-cache/i.test(cacheControl ?? '')) return DEFAULT_JWKS_TTL_MS;
  // Never cache for longer than a day, whatever the header says.
  return Math.min(Number(m[1]) * 1000, 24 * 3600_000);
}

// ---- ID token -----------------------------------------------------------------------------------

const b64urlBytes = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const decodePart = (s: string): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(b64urlBytes(s)));
  } catch {
    throw new IdTokenError('malformed token');
  }
};

const claimsSchema = z.object({
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  azp: z.string().optional(),
  exp: z.number(),
  iat: z.number(),
  nonce: z.string().optional(),
  sub: z.string(),
  email: z.string().optional(),
  email_verified: z.unknown().optional(),
  name: z.string().optional(),
  picture: z.string().optional(),
});

export interface GoogleIdentity {
  sub: string;
  /** Trimmed and lowercased. */
  email: string;
  name: string | null;
  picture: string | null;
}

/** Verify an ID token and return who it names. Throws IdTokenError on anything off. */
export async function verifyIdToken(
  token: string,
  o: { jwks: Jwks; clientId: string; nonce: string; now?: number },
): Promise<GoogleIdentity> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new IdTokenError('malformed token');
  const [h, p, sig] = parts as [string, string, string];
  const header = decodePart(h) as { alg?: unknown; kid?: unknown } | null;
  if (header?.alg !== 'RS256') throw new IdTokenError('unexpected algorithm');
  if (typeof header.kid !== 'string') throw new IdTokenError('no key id');
  const key = await o.jwks.key(header.kid);
  const ok = await crypto.subtle
    .verify(
      { name: 'RSASSA-PKCS1-v1_5' },
      key,
      b64urlBytes(sig),
      new TextEncoder().encode(`${h}.${p}`),
    )
    .catch(() => false);
  if (!ok) throw new IdTokenError('bad signature');

  const parsed = claimsSchema.safeParse(decodePart(p));
  if (!parsed.success) throw new IdTokenError('unexpected claims');
  const c = parsed.data;
  if (!ISSUERS.has(c.iss)) throw new IdTokenError('wrong issuer');
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(o.clientId)) throw new IdTokenError('wrong audience');
  if ((aud.length > 1 || c.azp !== undefined) && c.azp !== o.clientId) {
    throw new IdTokenError('wrong authorized party');
  }
  const now = Math.floor((o.now ?? Date.now()) / 1000);
  if (c.exp + CLOCK_SKEW_SEC <= now) throw new IdTokenError('token expired');
  if (c.iat - CLOCK_SKEW_SEC > now) throw new IdTokenError('token issued in the future');
  if (!c.nonce || !constantTimeEqual(c.nonce, o.nonce)) throw new IdTokenError('nonce mismatch');
  if (c.email_verified !== true) {
    throw new IdTokenError('email not verified');
  }
  if (!c.email) throw new IdTokenError('no email');
  return {
    sub: c.sub,
    email: c.email.trim().toLowerCase(),
    name: c.name ?? null,
    picture: c.picture ?? null,
  };
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
