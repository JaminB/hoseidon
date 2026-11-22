import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Health } from '@hoseidon/shared';
import type { Config } from './config';

const VERSION = '0.1.0';

export function createApp(config: Config) {
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
  api.all('*', (c) => c.json({ error: 'not found' }, 404));
  app.route('/api', api);

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
