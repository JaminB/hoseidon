import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimiter } from './rate-limit';

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  const make = () => new RateLimiter({ slow: { intervalMs: 10_000 }, fast: { intervalMs: 1_000 } });

  it('runs the first call immediately and spaces later ones by the interval', async () => {
    const limiter = make();
    const starts: number[] = [];
    const t0 = Date.now();
    const job = () => limiter.schedule('slow', async () => void starts.push(Date.now() - t0));

    const all = Promise.all([job(), job(), job()]);
    await vi.runAllTimersAsync();
    await all;
    expect(starts).toEqual([0, 10_000, 20_000]);
  });

  it('serializes calls: the next one waits for the previous to finish', async () => {
    const limiter = make();
    const log: string[] = [];
    const a = limiter.schedule('fast', async () => {
      log.push('a start');
      await new Promise((r) => setTimeout(r, 5_000));
      log.push('a end');
    });
    const b = limiter.schedule('fast', async () => void log.push('b start'));
    await vi.runAllTimersAsync();
    await Promise.all([a, b]);
    expect(log).toEqual(['a start', 'a end', 'b start']);
  });

  it('keeps buckets and scopes independent', async () => {
    const limiter = make();
    const starts: string[] = [];
    const t0 = Date.now();
    const mark = (name: string) => async () => void starts.push(`${name}@${Date.now() - t0}`);
    const all = Promise.all([
      limiter.schedule('slow', mark('slow1')),
      limiter.schedule('slow', mark('slowA'), { scope: 'a' }),
      limiter.schedule('fast', mark('fast1')),
      limiter.schedule('slow', mark('slow2')),
    ]);
    await vi.runAllTimersAsync();
    await all;
    expect(starts.sort()).toEqual(['fast1@0', 'slow1@0', 'slow2@10000', 'slowA@0']);
  });

  it('coalesces identical queued reads into one call', async () => {
    const limiter = make();
    const fn = vi.fn(async () => 'devices');
    // Occupy the bucket so the next ones queue.
    const first = limiter.schedule('slow', async () => 'x');
    const a = limiter.schedule('slow', fn, { coalesceKey: 'all' });
    const b = limiter.schedule('slow', fn, { coalesceKey: 'all' });
    expect(a).toBe(b);
    await vi.runAllTimersAsync();
    expect(await Promise.all([first, a, b])).toEqual(['x', 'devices', 'devices']);
    expect(fn).toHaveBeenCalledTimes(1);

    // After it settles, a new call makes a fresh request.
    const c = limiter.schedule('slow', fn, { coalesceKey: 'all' });
    await vi.runAllTimersAsync();
    await c;
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('a failure rejects its caller, still consumes the slot, and does not jam the queue', async () => {
    const limiter = make();
    const t0 = Date.now();
    const failing = limiter.schedule('slow', async () => {
      throw new Error('boom');
    });
    const next = limiter.schedule('slow', async () => Date.now() - t0);
    const failed = expect(failing).rejects.toThrow('boom');
    await vi.runAllTimersAsync();
    await failed;
    expect(await next).toBe(10_000);
  });

  it('reports when the next call could start', async () => {
    const limiter = make();
    const t0 = Date.now();
    expect(limiter.nextAvailableAt('slow').getTime()).toBe(t0);
    await limiter.schedule('slow', async () => {});
    expect(limiter.nextAvailableAt('slow').getTime()).toBe(t0 + 10_000);
    expect(limiter.nextAvailableAt('slow', 'other').getTime()).toBe(t0);

    void limiter.schedule('slow', async () => {});
    expect(limiter.pendingCount('slow')).toBe(1);
    expect(limiter.nextAvailableAt('slow').getTime()).toBe(t0 + 20_000);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(limiter.pendingCount('slow')).toBe(0);
    expect(limiter.nextAvailableAt('slow').getTime()).toBe(t0 + 20_000);
  });

  it('remembers the last call across restarts through a store', async () => {
    const saved = new Map<string, number>();
    const store = {
      get: (k: string) => saved.get(k),
      set: (k: string, t: number) => void saved.set(k, t),
    };
    const specs = { slow: { intervalMs: 10_000 } };
    const t0 = Date.now();
    await new RateLimiter(specs, Date.now, store).schedule('slow', async () => {});
    expect(saved.get('slow')).toBe(t0);

    // A "restarted" limiter shares the store, so its first call still has to wait.
    const again = new RateLimiter(specs, Date.now, store);
    expect(again.nextAvailableAt('slow').getTime()).toBe(t0 + 10_000);
    const starts: number[] = [];
    const call = again.schedule('slow', async () => void starts.push(Date.now() - t0));
    await vi.runAllTimersAsync();
    await call;
    expect(starts).toEqual([10_000]);
  });

  it('persists the lane before the call goes out, so a call killed mid-flight still counts', async () => {
    const saved = new Map<string, number>();
    const store = {
      get: (k: string) => saved.get(k),
      set: (k: string, t: number) => void saved.set(k, t),
    };
    const specs = { slow: { intervalMs: 10_000 } };
    const t0 = Date.now();
    let seenDuringCall: number | undefined;
    // The process "dies" during the call: the promise never settles.
    void new RateLimiter(specs, Date.now, store, 20_000).schedule('slow', () => {
      seenDuringCall = saved.get('slow');
      return new Promise<void>(() => {});
    });
    await vi.advanceTimersByTimeAsync(0);
    // Written before the call ran: now + the longest a call can take.
    expect(seenDuringCall).toBe(t0 + 20_000);

    // After the "eviction", a new limiter waits interval past that conservative mark.
    vi.setSystemTime(t0 + 5_000);
    const revived = new RateLimiter(specs, Date.now, store, 20_000);
    expect(revived.nextAvailableAt('slow').getTime()).toBe(t0 + 30_000);
    const starts: number[] = [];
    const call = revived.schedule('slow', async () => void starts.push(Date.now() - t0));
    await vi.runAllTimersAsync();
    await call;
    expect(starts).toEqual([30_000]);
    // And the real finish time replaces the mark afterwards.
    expect(saved.get('slow')).toBe(t0 + 30_000);
  });

  it('runs a priority call ahead of queued background calls', async () => {
    const limiter = make();
    const order: string[] = [];
    const mark = (name: string) => async () => void order.push(name);
    const all = Promise.all([
      limiter.schedule('slow', mark('poll-a')),
      limiter.schedule('slow', mark('poll-b')),
      limiter.schedule('slow', mark('poll-c')),
    ]);
    // Arrives while poll-a holds the slot and b, c are waiting.
    await vi.advanceTimersByTimeAsync(1_000);
    const verify = limiter.schedule('slow', mark('verify'), { priority: true });
    await vi.runAllTimersAsync();
    await Promise.all([all, verify]);
    expect(order).toEqual(['poll-a', 'verify', 'poll-b', 'poll-c']);
  });

  it('a priority caller promotes a queued call it coalesces with', async () => {
    const limiter = make();
    const order: string[] = [];
    const mark = (name: string) => async () => void order.push(name);
    void limiter.schedule('slow', mark('first'));
    await vi.advanceTimersByTimeAsync(1);
    void limiter.schedule('slow', mark('other'));
    const queued = limiter.schedule('slow', mark('lawn'), { coalesceKey: 'lawn' });
    const promoted = limiter.schedule('slow', mark('never'), {
      coalesceKey: 'lawn',
      priority: true,
    });
    expect(promoted).toBe(queued);
    await vi.runAllTimersAsync();
    expect(order).toEqual(['first', 'lawn', 'other']);
  });

  it('reports the earliest scoped lane', async () => {
    const limiter = make();
    const t0 = Date.now();
    expect(limiter.earliestAvailableAt('slow').getTime()).toBe(t0);
    await limiter.schedule('slow', async () => {}, { scope: 'a' });
    expect(limiter.earliestAvailableAt('slow').getTime()).toBe(t0 + 10_000);
    vi.advanceTimersByTime(4_000);
    await limiter.schedule('slow', async () => {}, { scope: 'b' });
    expect(limiter.earliestAvailableAt('slow').getTime()).toBe(t0 + 10_000);
  });
});
