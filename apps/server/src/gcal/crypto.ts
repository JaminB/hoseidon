import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM for secrets at rest (the Google refresh token). The key is derived from
 * SESSION_SECRET with HKDF, so rotating SESSION_SECRET makes stored tokens unreadable and the user
 * reconnects. Format: "v1.<iv>.<tag>.<ciphertext>", each base64url.
 */

const VERSION = 'v1';

export class SecretBox {
  readonly #key: Buffer;

  constructor(secret: string, purpose = 'gcal-token') {
    if (!secret) throw new Error('SecretBox needs a secret');
    this.#key = Buffer.from(hkdfSync('sha256', secret, 'hoseidon', purpose, 32));
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv, tag, ct]
      .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
      .join('.');
  }

  /** Throws when the value was sealed with another key or has been tampered with. */
  decrypt(sealed: string): string {
    const [version, iv, tag, ct] = sealed.split('.');
    if (version !== VERSION || !iv || !tag || ct === undefined) throw new Error('bad ciphertext');
    const decipher = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ct, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}
