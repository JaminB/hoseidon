import { createECDH, createDecipheriv, hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateVAPIDKeys } from 'web-push';
import {
  b64urlDecode,
  b64urlEncode,
  encryptPayload,
  generateVapidKeys,
  PushError,
  sendWebPush,
  vapidAuthorization,
} from './webpush';

/** RFC 8291 Appendix A: the worked example, byte for byte. */
const RFC8291 = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic:
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

/** Independent RFC 8291 decryption with node:crypto, as a browser would do it. */
function decrypt(body: Uint8Array, uaPrivate: string, authSecret: string): string {
  const salt = body.slice(0, 16);
  const idlen = body[20]!;
  const asPublic = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(uaPrivate, 'base64url'));
  const uaPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(asPublic);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdfSync('sha256', secret, Buffer.from(authSecret, 'base64url'), info, 32);
  const cek = hkdfSync('sha256', ikm, salt, 'Content-Encoding: aes128gcm\0', 16);
  const nonce = hkdfSync('sha256', ikm, salt, 'Content-Encoding: nonce\0', 12);
  const d = createDecipheriv('aes-128-gcm', Buffer.from(cek), Buffer.from(nonce));
  d.setAuthTag(Buffer.from(ct.slice(-16)));
  const plain = Buffer.concat([d.update(ct.slice(0, -16)), d.final()]);
  expect(plain.at(-1)).toBe(2); // last-record delimiter
  return plain.subarray(0, -1).toString('utf8');
}

describe('encryptPayload (RFC 8291 aes128gcm)', () => {
  it('reproduces the RFC 8291 Appendix A example exactly', async () => {
    const body = await encryptPayload(
      { p256dh: RFC8291.uaPublic, auth: RFC8291.authSecret },
      RFC8291.plaintext,
      {
        senderKeys: {
          publicKey: b64urlDecode(RFC8291.asPublic),
          privateKey: b64urlDecode(RFC8291.asPrivate),
        },
        salt: b64urlDecode(RFC8291.salt),
      },
    );
    expect(b64urlEncode(body)).toBe(RFC8291.body);
  });

  it('produces bodies an independent decrypter reads, with a fresh key and salt each time', async () => {
    const keys = { p256dh: RFC8291.uaPublic, auth: RFC8291.authSecret };
    const a = await encryptPayload(keys, '{"title":"Hoseidon"}');
    const b = await encryptPayload(keys, '{"title":"Hoseidon"}');
    expect(b64urlEncode(a)).not.toBe(b64urlEncode(b));
    expect(decrypt(a, RFC8291.uaPrivate, RFC8291.authSecret)).toBe('{"title":"Hoseidon"}');
    expect(decrypt(b, RFC8291.uaPrivate, RFC8291.authSecret)).toBe('{"title":"Hoseidon"}');
  });

  it('refuses payloads that do not fit one record', async () => {
    await expect(
      encryptPayload({ p256dh: RFC8291.uaPublic, auth: RFC8291.authSecret }, 'x'.repeat(5000)),
    ).rejects.toThrow(/too large/);
  });
});

describe('VAPID (RFC 8292)', () => {
  const endpoint = 'https://push.example.net/send/abc';

  async function checkJwt(header: string, publicKey: string) {
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    expect(m).not.toBeNull();
    const [h, p, s] = m![1]!.split('.');
    expect(m![2]).toBe(publicKey);
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({
      typ: 'JWT',
      alg: 'ES256',
    });
    const claims = JSON.parse(Buffer.from(p!, 'base64url').toString());
    expect(claims.aud).toBe('https://push.example.net');
    expect(claims.sub).toBe('mailto:admin@hoseidon.invalid');
    const raw = b64urlDecode(publicKey);
    const key = await crypto.subtle.importKey(
      'jwk',
      {
        kty: 'EC',
        crv: 'P-256',
        x: b64urlEncode(raw.slice(1, 33)),
        y: b64urlEncode(raw.slice(33)),
      },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      b64urlDecode(s!),
      new TextEncoder().encode(`${h}.${p}`),
    );
    expect(ok).toBe(true);
    return claims as { exp: number };
  }

  it('signs a JWT the public key verifies, expiring in 12 h', async () => {
    const keys = await generateVapidKeys();
    expect(b64urlDecode(keys.publicKey)).toHaveLength(65);
    expect(b64urlDecode(keys.privateKey)).toHaveLength(32);
    const now = Date.UTC(2026, 10, 22);
    const header = await vapidAuthorization(
      endpoint,
      { ...keys, subject: 'mailto:admin@hoseidon.invalid' },
      now,
    );
    const claims = await checkJwt(header, keys.publicKey);
    expect(claims.exp).toBe(now / 1000 + 12 * 3600);
  });

  it('accepts keys made by the web-push package (existing installs keep their subscriptions)', async () => {
    const keys = generateVAPIDKeys();
    const header = await vapidAuthorization(endpoint, {
      ...keys,
      subject: 'mailto:admin@hoseidon.invalid',
    });
    await checkJwt(header, keys.publicKey);
  });
});

describe('sendWebPush', () => {
  it('POSTs an aes128gcm body with VAPID auth, and maps refusals to PushError', async () => {
    const vapid = { ...(await generateVapidKeys()), subject: 'mailto:admin@hoseidon.invalid' };
    const target = {
      endpoint: 'https://push.example.net/send/abc',
      keys: { p256dh: RFC8291.uaPublic, auth: RFC8291.authSecret },
    };
    let seen: { headers: Headers; body: Uint8Array } | undefined;
    const ok: typeof fetch = async (_url, init) => {
      seen = {
        headers: new Headers(init!.headers),
        body: new Uint8Array(init!.body as Uint8Array),
      };
      return new Response(null, { status: 201 });
    };
    await sendWebPush(target, 'hello', vapid, { fetch: ok });
    expect(seen!.headers.get('content-encoding')).toBe('aes128gcm');
    expect(seen!.headers.get('ttl')).toBe('3600');
    expect(seen!.headers.get('authorization')).toMatch(/^vapid t=.+, k=/);
    expect(decrypt(seen!.body, RFC8291.uaPrivate, RFC8291.authSecret)).toBe('hello');

    const gone: typeof fetch = async () => new Response('gone', { status: 410 });
    const err = await sendWebPush(target, 'hello', vapid, { fetch: gone }).catch((e) => e);
    expect(err).toBeInstanceOf(PushError);
    expect((err as PushError).statusCode).toBe(410);
  });
});
