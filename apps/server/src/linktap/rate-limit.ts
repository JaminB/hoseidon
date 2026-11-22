/**
 * Per-bucket rate limiter for the LinkTap cloud API.
 *
 * - Calls in the same bucket run one at a time, at least `intervalMs` apart (measured from the end
 *   of the previous call, which is the conservative reading of LinkTap's limits).
 * - Calls with the same coalesce key that are already queued or in flight share one promise, so
 *   five components asking for getAllDevices at once cost one API call.
 * - A failed call still consumes its slot: LinkTap counts it too.
 */

export interface BucketSpec {
  intervalMs: number;
}

interface Bucket {
  spec: BucketSpec;
  /** Time the last call finished (ms epoch), or -Infinity if none yet. */
  lastDoneAt: number;
  /** Tail of the serialized queue. */
  tail: Promise<void>;
  pending: number;
  /** In-flight or queued calls keyed for coalescing. */
  inflight: Map<string, Promise<unknown>>;
}

/** Remembers when each lane last finished a call, so limits survive a restart. */
export interface LastCallStore {
  get(lane: string): number | undefined;
  set(lane: string, at: number): void;
}

export class RateLimiter<B extends string = string> {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly specs: Record<B, BucketSpec>,
    private readonly now: () => number = Date.now,
    private readonly store?: LastCallStore,
  ) {}

  /**
   * Queue `fn` in `bucket`. `scope` splits a bucket into independent lanes (e.g. per device).
   * When `coalesceKey` is given, identical queued/in-flight calls share one result.
   */
  schedule<T>(
    bucket: B,
    fn: () => Promise<T>,
    opts: { scope?: string; coalesceKey?: string } = {},
  ): Promise<T> {
    const b = this.bucket(bucket, opts.scope);
    if (opts.coalesceKey !== undefined) {
      const existing = b.inflight.get(opts.coalesceKey);
      if (existing) return existing as Promise<T>;
    }

    b.pending++;
    const run = b.tail.then(async () => {
      const wait = b.lastDoneAt + b.spec.intervalMs - this.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        return await fn();
      } finally {
        b.lastDoneAt = this.now();
        this.store?.set(key(bucket, opts.scope), b.lastDoneAt);
        b.pending--;
        if (opts.coalesceKey !== undefined) b.inflight.delete(opts.coalesceKey);
      }
    });
    // Keep the chain alive regardless of this call's outcome.
    b.tail = run.then(
      () => undefined,
      () => undefined,
    );
    if (opts.coalesceKey !== undefined) b.inflight.set(opts.coalesceKey, run);
    return run;
  }

  /**
   * Earliest time a newly scheduled call in this bucket could start. Accounts for calls already
   * queued (each needs its own interval), so it's an estimate when calls are in flight.
   */
  nextAvailableAt(bucket: B, scope?: string): Date {
    const b = this.bucket(bucket, scope);
    const base = Math.max(this.now(), b.lastDoneAt + b.spec.intervalMs);
    return new Date(base + b.pending * b.spec.intervalMs);
  }

  /** Number of calls queued or in flight for this bucket lane. */
  pendingCount(bucket: B, scope?: string): number {
    return this.buckets.get(key(bucket, scope))?.pending ?? 0;
  }

  private bucket(name: B, scope?: string): Bucket {
    const k = key(name, scope);
    let b = this.buckets.get(k);
    if (!b) {
      b = {
        spec: this.specs[name],
        lastDoneAt: this.store?.get(k) ?? Number.NEGATIVE_INFINITY,
        tail: Promise.resolve(),
        pending: 0,
        inflight: new Map(),
      };
      this.buckets.set(k, b);
    }
    return b;
  }
}

function key(bucket: string, scope?: string) {
  return scope === undefined ? bucket : `${bucket}:${scope}`;
}
