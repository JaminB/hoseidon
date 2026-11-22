import { describe, expect, it } from 'vitest';
import { CallStats } from './stats';

describe('CallStats', () => {
  it('tracks totals, last success and last failure per endpoint', () => {
    let t = 1000;
    const s = new CallStats(() => t);
    s.record('getAllDevices');
    t = 2000;
    s.record('getAllDevices', 'HTTP 500');
    const [e] = s.snapshot().endpoints;
    expect(e).toMatchObject({
      endpoint: 'getAllDevices',
      calls: 2,
      errors: 1,
      lastError: 'HTTP 500',
    });
    expect(e?.lastOkAt?.getTime()).toBe(1000);
    expect(e?.lastErrorAt?.getTime()).toBe(2000);
    expect(s.snapshot().since.getTime()).toBe(1000);
  });

  it('keeps the error rate to the last 50 calls', () => {
    const s = new CallStats();
    for (let i = 0; i < 20; i++) s.record('x', 'boom');
    for (let i = 0; i < 50; i++) s.record('x');
    const [e] = s.snapshot().endpoints;
    expect(e).toMatchObject({ calls: 70, errors: 20, recentCalls: 50, recentErrors: 0 });
  });

  it('sums queue waits and remembers the longest', () => {
    const s = new CallStats();
    s.wait('x', 100);
    s.wait('x', 500);
    s.wait('x', -5);
    expect(s.snapshot().endpoints[0]).toMatchObject({ waits: 3, totalWaitMs: 600, maxWaitMs: 500 });
  });
});
