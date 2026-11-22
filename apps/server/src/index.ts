import { serve } from '@hono/node-server';
import { createApp } from './app';
import { loadConfig } from './config';
import { openDb } from './db';

const config = loadConfig();
openDb(config.DATABASE_PATH);
const app = createApp(config);

serve({ fetch: app.fetch, port: config.PORT }, ({ port }) => {
  console.log(`🔱 Hoseidon listening on http://localhost:${port} (mock=${config.LINKTAP_MOCK})`);
});
