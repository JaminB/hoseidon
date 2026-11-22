import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Hono } from 'hono';
import { createApp } from './app';
import { insecureConfig, loadConfig } from './config';
import { openDb } from './db';
import { settingsLastCallStore } from './db/kv';
import { resolveTimeZone } from './api/settings';
import { createServices } from './services';

/** Node/Docker host. The Cloudflare host is apps/worker (see docs/cloudflare.md). */

const config = loadConfig();
if (!config.LINKTAP_MOCK) {
  const problems = insecureConfig(config);
  if (problems.length) {
    console.error(
      ['Refusing to start with real taps and weak secrets:', ...problems].join('\n - '),
    );
    process.exit(1);
  }
}
const log = (msg: string) => console.warn(msg);
const { db } = openDb(config.DATABASE_PATH);
// A zone saved from Settings wins over TZ; changing it takes effect on the next start.
const timeZone = resolveTimeZone(
  db,
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
);
const services = createServices({
  config,
  db,
  timeZone,
  log,
  timers: 'node',
  // Real API only: remember call times across restarts so a crash loop can't blow the limits.
  lastCallStore: config.LINKTAP_MOCK ? undefined : settingsLastCallStore(db),
});
const { poller, scheduler, gcal, push } = services;
const app = createApp({
  config,
  db,
  ...services,
  timeZone,
  clientIp: (c) => getConnInfo(c).remote.address,
});
serveWeb(app, config.WEB_DIST);

/** Serve the built PWA, with SPA fallback to index.html (after the API routes). */
function serveWeb(app: Hono, webDist: string) {
  const webRoot = resolve(webDist);
  const indexPath = resolve(webRoot, 'index.html');
  if (!existsSync(indexPath)) return;
  const index = readFileSync(indexPath, 'utf8');
  // serveStatic wants a root relative to the cwd.
  const root = relative(process.cwd(), webRoot).replace(/\\/g, '/') || '.';
  app.use('*', serveStatic({ root }));
  app.get('*', (c) => c.html(index));
}

serve({ fetch: app.fetch, port: config.PORT }, ({ port }) => {
  console.log(`🔱 Hoseidon listening on http://localhost:${port} (mock=${config.LINKTAP_MOCK})`);
  poller.start();
  scheduler.start();
  gcal.start();
  push.start();
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    poller.stop();
    scheduler.stop();
    gcal.stop();
    push.stop();
    process.exit(0);
  });
}
