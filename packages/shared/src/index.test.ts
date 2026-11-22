import { describe, expect, it } from 'vitest';
import { healthSchema, parsePercent } from './index';

describe('parsePercent', () => {
  it('parses LinkTap percent strings', () => {
    expect(parsePercent('66%')).toBe(66);
    expect(parsePercent(80)).toBe(80);
  });
  it('returns null for junk', () => {
    expect(parsePercent(undefined)).toBeNull();
    expect(parsePercent('n/a')).toBeNull();
  });
});

describe('healthSchema', () => {
  it('accepts a valid payload', () => {
    expect(
      healthSchema.safeParse({ ok: true, name: 'hoseidon', version: '1', mock: true }).success,
    ).toBe(true);
  });
});
