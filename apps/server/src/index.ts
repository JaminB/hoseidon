import { serve } from '@hono/node-server';
import { createApp } from './app';
import { insecureConfig, loadConfig } from './config';
import { openDb } from './db';
import { settingsLastCallStore } from './db/kv';
import { linktapFromConfig } from './linktap';
import { mockGeocodeFetch } from './linktap/location';
import { Poller } from './poller';
import { gatewayTimeZone, hasStartEvidence } from './poller/ingest';
import { SchedulerEngine } from './schedule/engine';
import { CloudExecutor } from './schedule/executor';
import { resolveTimeZone } from './api/settings';
import { AuthService } from './auth/service';
import { PushService } from './push/service';
import { GcalService } from './gcal/service';
import { mockOpenMeteoFetch } from './weather/mock';
import { OpenMeteoProvider } from './weather/open-meteo';

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
// Real API only: remember call times across restarts so a crash loop can't blow the rate limits.
const { client: linktap } = linktapFromConfig(
  config,
  config.LINKTAP_MOCK ? undefined : settingsLastCallStore(db),
);
const poller = new Poller({
  db,
  client: linktap,
  timeZone,
  log,
  fetch: config.LINKTAP_MOCK ? mockGeocodeFetch : undefined,
});
const executor = new CloudExecutor({
  client: linktap,
  // Before calling a start failed, look at what the poller/webhooks already saw, then history.
  evidence: (d, since) => hasStartEvidence(db, d.id, since),
  historyTimeZone: (d) => gatewayTimeZone(db, d.gatewayId, timeZone),
});
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
