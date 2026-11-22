import { describe, expect, it } from 'vitest';
import { SecretBox } from './crypto';

describe('SecretBox', () => {
  const box = new SecretBox('a-long-session-secret-for-tests');

  it('round-trips and never repeats a ciphertext', () => {
    const a = box.encrypt('1//refresh-token');
    const b = box.encrypt('1//refresh-token');
    expect(a).not.toBe(b);
    expect(a).not.toContain('refresh');
    expect(box.decrypt(a)).toBe('1//refresh-token');
    expect(box.decrypt(b)).toBe('1//refresh-token');
  });

  it('rejects another key, tampering and junk', () => {
    const sealed = box.encrypt('secret');
    expect(() => new SecretBox('some-other-session-secret').decrypt(sealed)).toThrow();
    const parts = sealed.split('.');
    const ct = Buffer.from(parts[3]!, 'base64url');
    ct[0]! ^= 1;
    parts[3] = ct.toString('base64url');
    expect(() => box.decrypt(parts.join('.'))).toThrow();
    expect(() => box.decrypt('nope')).toThrow();
  });
});
