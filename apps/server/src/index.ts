import { serve } from '@hono/node-server';
import { createApp } from './app';
import { loadConfig } from './config';
import { openDb } from './db';
import { linktapFromConfig } from './linktap';
import { Poller } from './poller';

const config = loadConfig();
const { db } = openDb(config.DATABASE_PATH);
const { client: linktap } = linktapFromConfig(config);
const poller = new Poller({
  db,
  client: linktap,
  timeZone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
  log: (msg) => console.warn(msg),
});
const app = createApp({ config, db, linktap, poller });

serve({ fetch: app.fetch, port: config.PORT }, ({ port }) => {
  console.log(`🔱 Hoseidon listening on http://localhost:${port} (mock=${config.LINKTAP_MOCK})`);
  poller.start();
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    poller.stop();
    process.exit(0);
  });
}
