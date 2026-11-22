import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Health } from '@hoseidon/shared';
import type { Config } from './config';
import type { Db } from './db';
import type { LinkTapClient } from './linktap/client';
import type { Poller } from './poller';
import { apiRoutes } from './api/routes';
import { hookRoutes } from './api/hooks';
import { analyticsRoutes } from './api/analytics';
import { networkRoutes } from './api/network';
import { scheduleRoutes } from './api/schedules';
import type { OpenMeteoProvider } from './weather/open-meteo';
import type { SchedulerEngine } from './schedule/engine';
import type { Executor } from './schedule/executor';

const VERSION = '0.1.0';

export const redactSecrets = (line: string) =>
  line.replace(/(\/hooks\/linktap\/)[^\s?#]+/g, '$1***');

export interface AppDeps {
  config: Config;
  db: Db;
  linktap: LinkTapClient;
  poller?: Poller;
  scheduler?: SchedulerEngine;
  executor?: Executor;
  weather?: OpenMeteoProvider;
  /** Default schedule time zone when a gateway has none. Default: the server's. */
  timeZone?: string;
}

export function createApp({
  config,
  db,
  linktap,
  poller,
  scheduler,
  executor,
  weather,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
}: AppDeps) {
  const app = new Hono();
  if (process.env.NODE_ENV !== 'test') {
    // The webhook secret lives in the path; keep it out of the logs.
    app.use(logger((msg, ...rest) => console.log(redactSecrets(msg), ...rest)));
  }

  const api = new Hono();
  api.get('/health', (c) => {
    const body: Health = {
      ok: true,
      name: 'hoseidon',
      version: VERSION,
      mock: config.LINKTAP_MOCK,
    };
    return c.json(body);
  });
  api.route('/', apiRoutes({ db, linktap, poller, mock: config.LINKTAP_MOCK }));
  api.route('/', scheduleRoutes({ db, scheduler, executor, timeZone }));
  api.route('/', analyticsRoutes({ db, weather, timeZone }));
  api.route(
    '/',
    networkRoutes({
      db,
      linktap,
      poller,
      mock: config.LINKTAP_MOCK,
      webhookConfigured: !!config.WEBHOOK_SECRET,
    }),
  );
  api.all('*', (c) => c.json({ error: 'not found' }, 404));
  app.route('/api', api);

  app.route(
    '/hooks',
    hookRoutes({
      db,
      secret: config.WEBHOOK_SECRET,
      username: config.LINKTAP_USERNAME || undefined,
      onEvent: () => void poller?.pollRunning(),
    }),
  );

  // Production: serve the built PWA, with SPA fallback to index.html.
  const webRoot = resolve(config.WEB_DIST);
  const indexPath = resolve(webRoot, 'index.html');
  if (existsSync(indexPath)) {
    const index = readFileSync(indexPath, 'utf8');
    // serveStatic wants a root relative to the cwd.
    const root = relative(process.cwd(), webRoot).replace(/\\/g, '/') || '.';
    app.use('*', serveStatic({ root }));
    app.get('*', (c) => c.html(index));
  }

  return app;
}
