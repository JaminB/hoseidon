import { DurableObject } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import * as schema from '@hoseidon/server/db/schema';
import type { Db } from '@hoseidon/server/db/types';
import { BrainCore } from '@hoseidon/server/runtime/brain';
import { edgeCheck, type EdgeEnv } from './edge';
import migrations from './migrations.gen';

/**
 * Hoseidon on Cloudflare Workers (Free plan). See docs/cloudflare.md.
 *
 * - The Worker serves the PWA from static assets (free, never runs this code) and runs only for
 *   /api/* and /hooks/*: a few edge checks, then on to the one Durable Object.
 * - `Brain` (SQLite-backed) owns every table and all logic: the Hono API, the poller, the
 *   scheduler, push and Google sync, driven by a single alarm (runtime/wheel.ts).
 * - A cron every 10 minutes re-arms the alarm if it ever dies.
 */

/** Always the same object: duration only fits the Free plan with exactly one. */
const BRAIN_NAME = 'brain';
const brain = (env: Env) => env.BRAIN.get(env.BRAIN.idFromName(BRAIN_NAME));

export class Brain extends DurableObject<Env> {
  private core!: BrainCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Nothing else runs until the schema is current and the core is built.
    void ctx.blockConcurrencyWhile(async () => {
      const db = drizzle(ctx.storage, { schema });
      await migrate(db, migrations);
      this.core = new BrainCore({
        db: db as unknown as Db,
        env: env as unknown as Record<string, unknown>,
        alarm: {
          get: () => ctx.storage.getAlarm(),
          set: (at) => ctx.storage.setAlarm(at),
        },
      });
    });
  }

  override fetch(request: Request): Promise<Response> {
    return this.core.fetch(request);
  }

  override alarm(): Promise<void> {
    return this.core.alarm();
  }

  /** Cron watchdog (RPC). */
  ensureAlarm(): Promise<{ alarmAt: number | null; rearmed: boolean }> {
    return this.core.ensureAlarm();
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    // Only /api/* and /hooks/* reach here (run_worker_first); anything else is a static asset.
    if (!pathname.startsWith('/api/') && !pathname.startsWith('/hooks/')) {
      return env.ASSETS.fetch(request);
    }
    return (await edgeCheck(request, env as unknown as EdgeEnv)) ?? brain(env).fetch(request);
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      brain(env)
        .ensureAlarm()
        .then(({ alarmAt, rearmed }) =>
          console.log(
            `watchdog: alarm at ${alarmAt === null ? 'none' : new Date(alarmAt).toISOString()}${rearmed ? ' (re-armed)' : ''}`,
          ),
        ),
    );
  },
} satisfies ExportedHandler<Env>;
