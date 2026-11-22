import { serve } from '@hono/node-server';
import { createApp } from './app';
import { loadConfig } from './config';
import { openDb } from './db';
import { linktapFromConfig } from './linktap';
import { Poller } from './poller';
import { SchedulerEngine } from './schedule/engine';
import { CloudExecutor } from './schedule/executor';

const config = loadConfig();
const timeZone = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
const log = (msg: string) => console.warn(msg);
const { db } = openDb(config.DATABASE_PATH);
const { client: linktap } = linktapFromConfig(config);
const poller = new Poller({ db, client: linktap, timeZone, log });
const executor = new CloudExecutor({ client: linktap });
const scheduler = new SchedulerEngine({ db, executor, log });
const app = createApp({ config, db, linktap, poller, scheduler, executor, timeZone });

serve({ fetch: app.fetch, port: config.PORT }, ({ port }) => {
  console.log(`🔱 Hoseidon listening on http://localhost:${port} (mock=${config.LINKTAP_MOCK})`);
  poller.start();
  scheduler.start();
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    poller.stop();
    scheduler.stop();
    process.exit(0);
  });
}
