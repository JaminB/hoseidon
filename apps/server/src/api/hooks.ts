import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../db';
import { ingestWebhook } from '../poller/ingest';

/** LinkTap webhook body: {username, event, title, content, gatewayId, deviceId, workMode?}. */
const webhookSchema = z.looseObject({
  username: z.string().nullish(),
  event: z.string().min(1),
  title: z.string().nullish(),
  content: z.string().nullish(),
  gatewayId: z.string().nullish(),
  deviceId: z.string().nullish(),
  workMode: z.string().nullish(),
});

function safeEqual(a: string, b: string): boolean {
  const h = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(h(a), h(b));
}

export interface HookDeps {
  db: Db;
  /** Empty disables the endpoint. */
  secret: string;
  /** When set, deliveries for a different LinkTap account are rejected. */
  username?: string;
  onEvent?: () => void;
}

/** POST /hooks/linktap/:secret. Register `${PUBLIC_URL}/hooks/linktap/${WEBHOOK_SECRET}`. */
export function hookRoutes({ db, secret, username, onEvent }: HookDeps) {
  const hooks = new Hono();

  hooks.post('/linktap/:secret', async (c) => {
    // Same 404 for "disabled" and "wrong secret": don't advertise the endpoint.
    if (!secret || !safeEqual(c.req.param('secret'), secret)) {
      return c.json({ error: 'not found' }, 404);
    }
    const parsed = webhookSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: 'invalid payload' }, 400);
    if (username && parsed.data.username && parsed.data.username !== username) {
      return c.json({ error: 'unknown account' }, 403);
    }
    ingestWebhook(db, parsed.data, new Date());
    onEvent?.();
    return c.json({ ok: true });
  });

  return hooks;
}
