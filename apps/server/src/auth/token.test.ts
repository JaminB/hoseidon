import { describe, expect, it } from 'vitest';
import { clientKey, cookieValue, hasValidSignature, safeEqual, signToken } from './token';

describe('signed tokens', () => {
  it('accept only their own secret and an untouched body', () => {
    const t = signToken('abc', 'secret-one');
    expect(hasValidSignature(t, 'secret-one')).toBe(true);
    expect(hasValidSignature(t, 'secret-two')).toBe(false);
    expect(hasValidSignature('x' + t, 'secret-one')).toBe(false);
    expect(hasValidSignature('abc', 'secret-one')).toBe(false);
    expect(hasValidSignature(undefined, 'secret-one')).toBe(false);
    expect(hasValidSignature(t, '')).toBe(false);
  });

  it('compare in constant time without caring about length', () => {
    expect(safeEqual('a', 'a')).toBe(true);
    expect(safeEqual('a', 'ab')).toBe(false);
  });

  it('are read out of a Cookie header', () => {
    expect(cookieValue('a=1; hoseidon_session=tok.en; b=2', 'hoseidon_session')).toBe('tok.en');
    expect(cookieValue(null, 'x')).toBeUndefined();
  });
});

describe('clientKey', () => {
  it('groups IPv6 addresses by /64 and leaves IPv4 alone', () => {
    expect(clientKey('203.0.113.7')).toBe('203.0.113.7');
    const a = clientKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
    expect(a).toBe(clientKey('2001:DB8:1:2::1'));
    expect(a).not.toBe(clientKey('2001:db8:1:3::1'));
    expect(clientKey('::1')).toBe('0000:0000:0000:0000::/64');
  });
});
