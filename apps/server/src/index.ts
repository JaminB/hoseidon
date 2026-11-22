import { serve } from '@hono/node-server';
import { createApp } from './app';
import { loadConfig } from './config';
import { openDb } from './db';
import { linktapFromConfig } from './linktap';
import { Poller } from './poller';
import { SchedulerEngine } from './schedule/engine';
import { CloudExecutor } from './schedule/executor';
import { resolveTimeZone } from './api/settings';
import { AuthService } from './auth/service';
import { PushService } from './push/service';
import { GcalService } from './gcal/service';
import { mockOpenMeteoFetch } from './weather/mock';
import { OpenMeteoProvider } from './weather/open-meteo';

const config = loadConfig();
const log = (msg: string) => console.warn(msg);
const { db } = openDb(config.DATABASE_PATH);
// A zone saved from Settings wins over TZ; changing it takes effect on the next start.
const timeZone = resolveTimeZone(
  db,
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
);
const { client: linktap } = linktapFromConfig(config);
const poller = new Poller({ db, client: linktap, timeZone, log });
const executor = new CloudExecutor({ client: linktap });
// Offline demo: the mock serves Open-Meteo-shaped weather so the real cache code runs too.
const weather = new OpenMeteoProvider({
  db,
  log,
  fetch: config.LINKTAP_MOCK ? mockOpenMeteoFetch : undefined,
});
const scheduler = new SchedulerEngine({ db, executor, weather, log });
const gcal = new GcalService({
  db,
  config,
  timeZone,
  log,
  executor,
});
const auth = new AuthService({ db, config, log });
const push = new PushService({ db, config, log });
const app = createApp({
  config,
  db,
  linktap,
  poller,
  scheduler,
  executor,
  weather,
  timeZone,
  gcal,
  auth,
  push,
});

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
