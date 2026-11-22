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

const VERSION = '0.1.0';

export interface AppDeps {
  config: Config;
  db: Db;
  linktap: LinkTapClient;
  poller?: Poller;
}

export function createApp({ config, db, linktap, poller }: AppDeps) {
  const app = new Hono();
  if (process.env.NODE_ENV !== 'test') app.use(logger());

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
