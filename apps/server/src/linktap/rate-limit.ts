/**
 * Per-bucket rate limiter for the LinkTap cloud API.
 *
 * - Calls in the same bucket lane run one at a time, at least `intervalMs` apart (measured from
 *   the end of the previous call, which is the conservative reading of LinkTap's limits).
 * - Calls with the same coalesce key that are already queued or in flight share one promise, so
 *   five components asking for getAllDevices at once cost one API call.
 * - A `priority` call goes ahead of every queued non-priority call in its lane (used for the
 *   scheduler's start check, so background polling can't starve it).
 * - A failed call still consumes its slot: LinkTap counts it too.
 * - With a store, the lane's time is written BEFORE the call goes out (as "now + inflightMs", the
 *   longest a call can take) and again with the real finish time after. A process killed
 *   mid-call (a crash, or a Cloudflare deploy evicting the Durable Object) therefore still
 *   counts that call when it comes back, instead of firing a second one too early.
 */

export interface BucketSpec {
  intervalMs: number;
}

export interface ScheduleOptions {
  /** Splits a bucket into independent lanes (e.g. per device). */
  scope?: string;
  /** Identical queued/in-flight calls with this key share one result. */
  coalesceKey?: string;
  /** Jump ahead of queued non-priority calls in this lane. */
  priority?: boolean;
}

interface Job {
  priority: boolean;
  coalesceKey?: string;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

interface Lane {
  spec: BucketSpec;
  /** Time the last call finished (ms epoch), or -Infinity if none yet. */
  lastDoneAt: number;
  queue: Job[];
  /** Queued + in flight. */
  pending: number;
  draining: boolean;
  /** In-flight or queued calls keyed for coalescing. */
  inflight: Map<string, { promise: Promise<unknown>; job: Job }>;
}

/** Remembers when each lane last finished a call, so limits survive a restart. */
export interface LastCallStore {
  get(lane: string): number | undefined;
  set(lane: string, at: number): void;
}

export class RateLimiter<B extends string = string> {
  private readonly lanes = new Map<string, Lane>();

  constructor(
    private readonly specs: Record<B, BucketSpec>,
    private readonly now: () => number = Date.now,
    private readonly store?: LastCallStore,
    /** Upper bound on one call's duration, for the pre-call mark (0 = no pre-call write). */
    private readonly inflightMs = 0,
  ) {}

  /** Queue `fn` in `bucket` (see ScheduleOptions). */
  schedule<T>(bucket: B, fn: () => Promise<T>, opts: ScheduleOptions = {}): Promise<T> {
    const lane = this.lane(bucket, opts.scope);
    if (opts.coalesceKey !== undefined) {
      const existing = lane.inflight.get(opts.coalesceKey);
      if (existing) {
        if (opts.priority) this.promote(lane, existing.job);
        return existing.promise as Promise<T>;
      }
    }

    let job!: Job;
    const promise = new Promise<T>((resolve, reject) => {
      job = {
        priority: opts.priority ?? false,
        coalesceKey: opts.coalesceKey,
        run: fn,
        resolve: resolve as (value: unknown) => void,
        reject,
      };
    });
    lane.pending++;
    this.enqueue(lane, job);
    if (opts.coalesceKey !== undefined) lane.inflight.set(opts.coalesceKey, { promise, job });
    void this.drain(lane, key(bucket, opts.scope));
    return promise;
  }

  /**
   * Earliest time a newly scheduled call in this lane could start. Accounts for calls already
   * queued (each needs its own interval), so it's an estimate when calls are in flight.
   */
  nextAvailableAt(bucket: B, scope?: string): Date {
    const lane = this.lane(bucket, scope);
    const base = Math.max(this.now(), lane.lastDoneAt + lane.spec.intervalMs);
    return new Date(base + lane.pending * lane.spec.intervalMs);
  }

  /** Earliest nextAvailableAt over every scoped lane of `bucket` seen so far (now if none). */
  earliestAvailableAt(bucket: B): Date {
    let best: number | null = null;
    for (const k of this.lanes.keys()) {
      if (!k.startsWith(`${bucket}:`)) continue;
      const t = this.nextAvailableAt(bucket, k.slice(bucket.length + 1)).getTime();
      best = best === null ? t : Math.min(best, t);
    }
    return new Date(best ?? this.now());
  }

  /** Number of calls queued or in flight for this bucket lane. */
  pendingCount(bucket: B, scope?: string): number {
    return this.lanes.get(key(bucket, scope))?.pending ?? 0;
  }

  private enqueue(lane: Lane, job: Job) {
    if (!job.priority) {
      lane.queue.push(job);
      return;
    }
    // After the priority jobs already waiting, before everything else.
    const at = lane.queue.findIndex((j) => !j.priority);
    if (at === -1) lane.queue.push(job);
    else lane.queue.splice(at, 0, job);
  }

  private promote(lane: Lane, job: Job) {
    const i = lane.queue.indexOf(job);
    if (i === -1 || job.priority) return; // already running, or already priority
    lane.queue.splice(i, 1);
    job.priority = true;
    this.enqueue(lane, job);
  }

  private async drain(lane: Lane, laneKey: string) {
    if (lane.draining) return;
    lane.draining = true;
    // Let the caller's synchronous code (e.g. queueing more calls) finish first.
    await Promise.resolve();
    try {
      while (lane.queue.length) {
        const wait = lane.lastDoneAt + lane.spec.intervalMs - this.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        // Pick after waiting, so a priority call that arrived meanwhile goes first.
        const job = lane.queue.shift();
        if (!job) break;
        let ok = true;
        let value: unknown;
        if (this.store && this.inflightMs > 0) {
          this.store.set(laneKey, this.now() + this.inflightMs);
        }
        try {
          value = await job.run();
        } catch (err) {
          ok = false;
          value = err;
        }
        // Book-keep before the caller sees the result, so it observes the updated lane.
        lane.lastDoneAt = this.now();
        this.store?.set(laneKey, lane.lastDoneAt);
        lane.pending--;
        if (job.coalesceKey !== undefined) lane.inflight.delete(job.coalesceKey);
        if (ok) job.resolve(value);
        else job.reject(value);
      }
    } finally {
      lane.draining = false;
    }
  }

  private lane(name: B, scope?: string): Lane {
    const k = key(name, scope);
    let lane = this.lanes.get(k);
    if (!lane) {
      lane = {
        spec: this.specs[name],
        lastDoneAt: this.store?.get(k) ?? Number.NEGATIVE_INFINITY,
        queue: [],
        pending: 0,
        draining: false,
        inflight: new Map(),
      };
      this.lanes.set(k, lane);
    }
    return lane;
  }
}

function key(bucket: string, scope?: string) {
  return scope === undefined ? bucket : `${bucket}:${scope}`;
}
