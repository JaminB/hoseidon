import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  appSettingsPatchSchema,
  isValidTimeZone,
  pushPrefsSchema,
  pushSubscriptionInputSchema,
  type AppSettings,
  type LinkTapTest,
  type WebhookInfo,
} from '@hoseidon/shared';
import type { Config } from '../config';
import type { Db } from '../db';
import { getSetting, setSetting } from '../db/kv';
import { devices, gateways } from '../db/schema';
import type { LinkTapClient } from '../linktap/client';
import type { Poller } from '../poller';
import type { PushService } from '../push/service';
import { body, HttpError, onApiError } from './http';

export const TIME_ZONE_KEY = 'app.timeZone';

/** The zone to run in: the saved setting if valid, else the TZ env / system zone. */
export function resolveTimeZone(db: Pick<Db, 'select'>, fallback: string): string {
  const saved = getSetting(db, TIME_ZONE_KEY);
  return saved && isValidTimeZone(saved) ? saved : fallback;
}

export interface SettingsApiDeps {
  db: Db;
  config: Config;
  linktap: LinkTapClient;
  poller?: Poller;
  push: PushService;
  /** The zone the running server was started with. */
  activeTimeZone: string;
  now?: () => number;
}

/** Everything the Settings page edits: time zone, push, and the LinkTap connection. */
export function settingsRoutes({
  db,
  config,
  linktap,
  poller,
  push,
  activeTimeZone,
  now = Date.now,
}: SettingsApiDeps) {
  const api = new Hono();
  api.onError(onApiError);

  // ---- time zone ------------------------------------------------------------------------------

  const appSettings = (): AppSettings => ({
    timeZone: resolveTimeZone(db, activeTimeZone),
    activeTimeZone,
  });
  api.get('/settings', (c) => c.json(appSettings()));
  api.patch('/settings', async (c) => {
    const { timeZone } = await body(c, appSettingsPatchSchema);
    if (!isValidTimeZone(timeZone)) throw new HttpError(400, `unknown time zone: ${timeZone}`);
    setSetting(db, TIME_ZONE_KEY, timeZone);
    return c.json(appSettings());
  });

  // ---- push -----------------------------------------------------------------------------------

  api.get('/push', (c) => c.json(push.status()));
  api.patch('/push/prefs', async (c) => {
    push.setPrefs(await body(c, pushPrefsSchema.partial()));
    return c.json(push.status());
  });
  api.post('/push/subscribe', async (c) => {
    push.subscribe(await body(c, pushSubscriptionInputSchema));
    return c.json(push.status());
  });
  api.post('/push/unsubscribe', async (c) => {
    push.unsubscribe((await body(c, z.object({ endpoint: z.string().min(1) }))).endpoint);
    return c.json(push.status());
  });
  api.post('/push/test', async (c) => {
    if (!push.status().subscriptions) throw new HttpError(409, 'no device is subscribed yet');
    return c.json(await push.sendTest());
  });

  // ---- LinkTap connection ---------------------------------------------------------------------

  const counts = () => ({
    gateways: db
      .select({ n: sql<number>`count(*)` })
      .from(gateways)
      .get()!.n,
    devices: db
      .select({ n: sql<number>`count(*)` })
      .from(devices)
      .get()!.n,
  });

  /**
   * getAllDevices is the cheapest call that proves the account works (getWateringStatus says
   * "null" even for bad credentials). It is limited to one per 5 minutes, so when the poller has
   * used the slot we report its last result rather than queue behind it.
   */
  api.post('/linktap/test', async (c) => {
    const mock = config.LINKTAP_MOCK;
    const wait = linktap.nextAvailableAt('devices').getTime() - now();
    if (wait > 5_000) {
      const last = poller?.status().last.devices;
      const result: LinkTapTest = {
        ok: !!last?.at && !last.error,
        mock,
        message: last?.error
          ? `Last poll failed: ${last.error}`
          : last?.at
            ? 'Connected. Reusing the last poll, since LinkTap allows one every 5 minutes.'
            : 'No poll has finished yet. Try again in a minute.',
        ...counts(),
        cached: true,
      };
      return c.json(result);
    }
    try {
      const polled = await linktap.getAllDevices();
      const result: LinkTapTest = {
        ok: true,
        mock,
        message: mock
          ? 'Mock LinkTap answered. Nothing real was contacted.'
          : 'Connected to the LinkTap cloud.',
        gateways: polled.length,
        devices: polled.reduce((n, g) => n + g.taplinkers.length, 0),
        cached: false,
      };
      return c.json(result);
    } catch (e) {
      const result: LinkTapTest = {
        ok: false,
        mock,
        message: e instanceof Error ? e.message : String(e),
        ...counts(),
        cached: false,
      };
      return c.json(result);
    }
  });

  // ---- webhook --------------------------------------------------------------------------------

  const webhook = (): WebhookInfo => {
    const base = config.PUBLIC_URL.replace(/\/+$/, '');
    let blockedReason: string | null = null;
    if (config.LINKTAP_MOCK)
      blockedReason = 'Mock mode is on, so there is no LinkTap account to tell.';
    else if (!config.WEBHOOK_SECRET) blockedReason = 'Set WEBHOOK_SECRET first.';
    else if (!/^https:\/\//.test(base) || /\/\/(localhost|127\.|\[::1\])/.test(base)) {
      blockedReason = 'Set PUBLIC_URL to the public https address (a Cloudflare Tunnel works).';
    }
    return {
      url: config.WEBHOOK_SECRET ? `${base}/hooks/linktap/${config.WEBHOOK_SECRET}` : null,
      blockedReason,
    };
  };
  api.get('/linktap/webhook', (c) => c.json(webhook()));
  api.post('/linktap/webhook/register', async (c) => {
    await body(c, z.object({ confirm: z.literal(true) }));
    const info = webhook();
    if (info.blockedReason || !info.url) throw new HttpError(409, info.blockedReason ?? 'blocked');
    await linktap.setWebHookUrl(info.url);
    return c.json(info);
  });

  return api;
}
