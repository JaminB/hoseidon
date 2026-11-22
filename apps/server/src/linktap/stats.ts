/**
 * In-memory health counters for LinkTap cloud calls, per endpoint. They reset on restart; the
 * Network page shows `since` so that's visible. The recent window keeps the error rate responsive:
 * one bad hour last month shouldn't colour today.
 */

const RECENT = 50;

export interface EndpointStats {
  endpoint: string;
  calls: number;
  errors: number;
  /** Outcomes of the last RECENT calls (true = failed). */
  recentCalls: number;
  recentErrors: number;
  lastOkAt: Date | null;
  lastErrorAt: Date | null;
  lastError: string | null;
  /** Time spent queued behind the rate limiter, summed over `waits` calls. */
  totalWaitMs: number;
  waits: number;
  maxWaitMs: number;
}

export interface ApiStats {
  since: Date;
  endpoints: EndpointStats[];
}

interface Entry extends EndpointStats {
  window: boolean[];
}

export class CallStats {
  private readonly entries = new Map<string, Entry>();
  private readonly since: Date;

  constructor(private readonly now: () => number = Date.now) {
    this.since = new Date(now());
  }

  private entry(endpoint: string): Entry {
    let e = this.entries.get(endpoint);
    if (!e) {
      e = {
        endpoint,
        calls: 0,
        errors: 0,
        recentCalls: 0,
        recentErrors: 0,
        lastOkAt: null,
        lastErrorAt: null,
        lastError: null,
        totalWaitMs: 0,
        waits: 0,
        maxWaitMs: 0,
        window: [],
      };
      this.entries.set(endpoint, e);
    }
    return e;
  }

  /** A call finished. `error` is the failure message, or undefined on success. */
  record(endpoint: string, error?: string): void {
    const e = this.entry(endpoint);
    const at = new Date(this.now());
    e.calls++;
    e.window.push(error !== undefined);
    if (e.window.length > RECENT) e.window.shift();
    if (error === undefined) {
      e.lastOkAt = at;
    } else {
      e.errors++;
      e.lastErrorAt = at;
      e.lastError = error;
    }
    e.recentCalls = e.window.length;
    e.recentErrors = e.window.filter(Boolean).length;
  }

  /** How long a call sat in the rate-limit queue before it was sent. */
  wait(endpoint: string, ms: number): void {
    const e = this.entry(endpoint);
    const w = Math.max(0, ms);
    e.waits++;
    e.totalWaitMs += w;
    e.maxWaitMs = Math.max(e.maxWaitMs, w);
  }

  snapshot(): ApiStats {
    return {
      since: this.since,
      endpoints: [...this.entries.values()]
        .map(({ window: _window, ...rest }) => rest)
        .sort((a, b) => a.endpoint.localeCompare(b.endpoint)),
    };
  }
}
