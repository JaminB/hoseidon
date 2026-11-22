import { createHash, randomBytes } from 'node:crypto';
import { JWKS_URL } from './google';
import { TOKEN_URL } from '../gcal/oauth';

/**
 * An in-memory Google for sign-in tests: an authorize step (`authorize(url, claims)` stands in
 * for the user picking an account), the token endpoint (checks client, redirect URI and PKCE) and
 * the JWKS endpoint. ID tokens are RS256 with a locally generated key. Never touches the network.
 */

type KeyPair = { kid: string; privateKey: CryptoKey; jwk: Record<string, unknown> };

async function makeKey(kid: string): Promise<KeyPair> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as { publicKey: CryptoKey; privateKey: CryptoKey };
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as Record<string, unknown>;
  return { kid, privateKey: pair.privateKey, jwk };
}

const b64url = (data: string | Uint8Array | ArrayBuffer) =>
  Buffer.from(typeof data === 'string' ? data : new Uint8Array(data)).toString('base64url');

export type Claims = Record<string, unknown>;

export interface AuthorizeOptions {
  email: string;
  /** Override or add claims; `undefined` values remove a claim. */
  claims?: Claims;
  /** Sign with this key instead of the published one (bad-signature tests). */
  signWith?: CryptoKey;
  /** Header kid to put in the token (default: the current key's). */
  kid?: string;
  /** Header alg (default RS256). `sig` replaces the signature (`''` = unsigned). */
  alg?: string;
  sig?: string;
}

export class FakeOidc {
  keys: KeyPair[] = [];
  jwksCalls = 0;
  tokenCalls = 0;
  /** Cache-Control on the JWKS response. */
  jwksCacheControl = 'public, max-age=3600';
  private codes = new Map<
    string,
    { challenge: string; redirectUri: string; clientId: string; token: Promise<string> }
  >();

  private constructor(readonly clientId: string) {}

  static async create(clientId: string): Promise<FakeOidc> {
    const f = new FakeOidc(clientId);
    f.keys.push(await makeKey('key-1'));
    return f;
  }

  /** Publish a new key (rotation); the old one is dropped. */
  async rotate(kid: string): Promise<void> {
    this.keys = [await makeKey(kid)];
  }

  /** A key Google never published. */
  static async strayKey(): Promise<CryptoKey> {
    return (await makeKey('stray')).privateKey;
  }

  get kid(): string {
    return this.keys[0]!.kid;
  }

  async sign(
    claims: Claims,
    o: { key?: CryptoKey; kid?: string; alg?: string; sig?: string } = {},
  ): Promise<string> {
    const header = b64url(
      JSON.stringify({ alg: o.alg ?? 'RS256', kid: o.kid ?? this.kid, typ: 'JWT' }),
    );
    const payload = b64url(JSON.stringify(claims));
    if (o.sig !== undefined) return `${header}.${payload}.${o.sig}`;
    const sig = await crypto.subtle.sign(
      { name: 'RSASSA-PKCS1-v1_5' },
      o.key ?? this.keys[0]!.privateKey,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    return `${header}.${payload}.${b64url(sig)}`;
  }

  /** The user consents on Google's page: returns the `code` the browser brings back. */
  authorize(authUrl: string, o: AuthorizeOptions): string {
    const q = new URL(authUrl).searchParams;
    const now = Math.floor(Date.now() / 1000);
    const claims: Claims = {
      iss: 'https://accounts.google.com',
      aud: q.get('client_id'),
      azp: q.get('client_id'),
      sub: `sub-${o.email}`,
      email: o.email,
      email_verified: true,
      name: 'Test Person',
      picture: 'https://example.com/avatar.png',
      nonce: q.get('nonce'),
      iat: now,
      exp: now + 3600,
      ...o.claims,
    };
    for (const [k, v] of Object.entries(claims)) if (v === undefined) delete claims[k];
    const code = randomBytes(12).toString('base64url');
    this.codes.set(code, {
      challenge: q.get('code_challenge') ?? '',
      redirectUri: q.get('redirect_uri') ?? '',
      clientId: q.get('client_id') ?? '',
      token: this.sign(claims, { key: o.signWith, kid: o.kid, alg: o.alg, sig: o.sig }),
    });
    return code;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === JWKS_URL) {
      this.jwksCalls++;
      return Response.json(
        { keys: this.keys.map((k) => ({ ...k.jwk, kid: k.kid, alg: 'RS256', use: 'sig' })) },
        { headers: { 'cache-control': this.jwksCacheControl } },
      );
    }
    if (url === TOKEN_URL) {
      this.tokenCalls++;
      const form = new URLSearchParams(String(init?.body ?? ''));
      const entry = this.codes.get(form.get('code') ?? '');
      this.codes.delete(form.get('code') ?? '');
      const verifier = form.get('code_verifier') ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (
        !entry ||
        entry.challenge !== challenge ||
        entry.redirectUri !== form.get('redirect_uri') ||
        form.get('client_id') !== this.clientId ||
        entry.clientId !== this.clientId ||
        !form.get('client_secret')
      ) {
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      return Response.json({
        access_token: 'unused',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'openid email profile',
        id_token: await entry.token,
      });
    }
    throw new Error(`FakeOidc: unexpected fetch ${url}`);
  };
}
