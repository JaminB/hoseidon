import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { GCAL_SCOPE } from '@hoseidon/shared';

/** Google OAuth 2.0 for a confidential web client: auth-code flow with PKCE, plain fetch. */

export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** The token endpoint said no. `invalidGrant` means the refresh token is dead: reconnect. */
export class GoogleAuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
  get invalidGrant() {
    return this.code === 'invalid_grant';
  }
}

export function pkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function authUrl(client: OAuthClient, state: string, challenge: string): string {
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: 'code',
    scope: GCAL_SCOPE,
    // offline + consent: always hand back a refresh token, even on a reconnect.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

const tokenSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});
export type TokenResponse = z.infer<typeof tokenSchema>;

/** A hung Google call must not stall the Durable Object's single alarm handler. */
export const GOOGLE_TIMEOUT_MS = 15_000;

async function tokenRequest(
  fetchImpl: typeof fetch,
  params: Record<string, string>,
): Promise<TokenResponse> {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const code = typeof json?.error === 'string' ? json.error : `http_${res.status}`;
    const desc = typeof json?.error_description === 'string' ? json.error_description : code;
    throw new GoogleAuthError(`Google token request failed: ${desc}`, code, res.status);
  }
  const parsed = tokenSchema.safeParse(json);
  if (!parsed.success)
    throw new GoogleAuthError('Unexpected token response', 'invalid_response', 502);
  return parsed.data;
}

export function exchangeCode(
  fetchImpl: typeof fetch,
  client: OAuthClient,
  code: string,
  verifier: string,
) {
  return tokenRequest(fetchImpl, {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: client.redirectUri,
  });
}

export function refreshAccessToken(
  fetchImpl: typeof fetch,
  client: OAuthClient,
  refreshToken: string,
) {
  return tokenRequest(fetchImpl, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: client.clientId,
    client_secret: client.clientSecret,
  });
}

/** Best effort: a token that is already dead can't be revoked, and that's fine. */
export async function revokeToken(fetchImpl: typeof fetch, token: string): Promise<void> {
  await fetchImpl(REVOKE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
    signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
  }).catch(() => undefined);
}

/** Caches the access token and refreshes it a minute before it expires. */
export class TokenSource {
  #access: { token: string; expiresAt: number } | null = null;
  #inflight: Promise<string> | null = null;

  constructor(
    private readonly opts: {
      fetch: typeof fetch;
      client: OAuthClient;
      refreshToken: () => string;
      now?: () => number;
    },
  ) {}

  /** Seed with the access token from the code exchange. */
  set(token: string, expiresInSec: number) {
    this.#access = { token, expiresAt: this.now() + expiresInSec * 1000 };
  }

  clear() {
    this.#access = null;
  }

  async get(force = false): Promise<string> {
    if (!force && this.#access && this.#access.expiresAt - 60_000 > this.now()) {
      return this.#access.token;
    }
    // Concurrent callers share one refresh.
    this.#inflight ??= refreshAccessToken(
      this.opts.fetch,
      this.opts.client,
      this.opts.refreshToken(),
    )
      .then((t) => {
        this.set(t.access_token, t.expires_in);
        return t.access_token;
      })
      .finally(() => {
        this.#inflight = null;
      });
    return this.#inflight;
  }

  private now() {
    return this.opts.now?.() ?? Date.now();
  }
}
