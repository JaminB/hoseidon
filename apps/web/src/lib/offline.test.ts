import { describe, expect, it } from 'vitest';
import { ago, lastUpdatedAt, offlineMessage } from './offline';

const NOW = Date.parse('2026-06-01T12:00:00Z');
const MIN = 60_000;

describe('lastUpdatedAt', () => {
  it('picks the newest fetch and ignores queries that never loaded', () => {
    const q = (dataUpdatedAt: number) => ({ state: { dataUpdatedAt } });
    expect(lastUpdatedAt([q(0), q(NOW - 5 * MIN), q(NOW - 90 * MIN)])).toBe(NOW - 5 * MIN);
    expect(lastUpdatedAt([q(0)])).toBeNull();
    expect(lastUpdatedAt([])).toBeNull();
  });
});

describe('ago', () => {
  it('rounds to the biggest sensible unit', () => {
    expect(ago(NOW - 20_000, NOW)).toBe('just now');
    expect(ago(NOW - 12 * MIN, NOW)).toBe('12 min ago');
    expect(ago(NOW - 3 * 60 * MIN, NOW)).toBe('3 h ago');
    expect(ago(NOW - 48 * 60 * MIN, NOW)).toBe('2 d ago');
  });
});

describe('offlineMessage', () => {
  it('stays quiet while live', () => {
    expect(offlineMessage({ online: true, serverUp: true, lastUpdated: NOW }, NOW)).toBeNull();
  });
  it('says how old the cached view is', () => {
    expect(
      offlineMessage({ online: false, serverUp: true, lastUpdated: NOW - 12 * MIN }, NOW),
    ).toBe('You’re offline · showing data from 12 min ago');
    expect(offlineMessage({ online: true, serverUp: false, lastUpdated: NOW - MIN }, NOW)).toMatch(
      /^Can’t reach Hoseidon · showing data from 1 min ago$/,
    );
  });
  it('admits when there is nothing cached', () => {
    expect(offlineMessage({ online: false, serverUp: true, lastUpdated: null }, NOW)).toMatch(
      /nothing saved/,
    );
  });
});
