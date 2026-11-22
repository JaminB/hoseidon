import type { Config } from './config';
import type { Db } from './db/types';
import { linktapFromConfig, type LinkTapClient, type LinkTapMock } from './linktap';
import { mockGeocodeFetch } from './linktap/location';
import type { LastCallStore } from './linktap/rate-limit';
import { Poller } from './poller';
import { gatewayTimeZone, hasStartEvidence } from './poller/ingest';
import { SchedulerEngine } from './schedule/engine';
import { CloudExecutor } from './schedule/executor';
import { AuthService } from './auth/service';
import type { PasswordScheme } from './auth/password';
import { PushService } from './push/service';
import { GcalService } from './gcal/service';
import { mockOpenMeteoFetch } from './weather/mock';
import { OpenMeteoProvider } from './weather/open-meteo';

export interface ServiceOptions {
  config: Config;
  db: Db;
  /** Default zone for schedules and history when a gateway has none. */
  timeZone: string;
  log?: (msg: string) => void;
  /**
   * 'node': each service runs its own setInterval/setTimeout once started.
   * 'external': nothing runs by itself; the host drives the tasks (the Cloudflare alarm wheel).
   */
  timers: 'node' | 'external';
  /** Persisted LinkTap call times. */
  lastCallStore?: LastCallStore;
  passwordScheme?: PasswordScheme;
  /** External timers: persist the post-run history reconcile. */
  scheduleReconcile?: (deviceId: string, at: Date) => void;
  /** Replaces the LinkTap mock / real client (tests). */
  linktap?: LinkTapClient;
}

export interface Services {
  linktap: LinkTapClient;
  mock?: LinkTapMock;
  poller: Poller;
  executor: CloudExecutor;
  weather: OpenMeteoProvider;
  scheduler: SchedulerEngine;
  gcal: GcalService;
  auth: AuthService;
  push: PushService;
}

/** The object graph both hosts share (Node: index.ts, Cloudflare: runtime/brain.ts). */
export function createServices(o: ServiceOptions): Services {
  const { config, db, timeZone, log } = o;
  const external = o.timers === 'external';
  const built = o.linktap ? { client: o.linktap } : linktapFromConfig(config, o.lastCallStore);
  const linktap = built.client;
  const poller = new Poller({
    db,
    client: linktap,
    timeZone,
    log,
    fetch: config.LINKTAP_MOCK ? mockGeocodeFetch : undefined,
    scheduleReconcile: o.scheduleReconcile,
    external,
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
  const scheduler = new SchedulerEngine({ db, executor, weather, log, external });
  const gcal = new GcalService({
    db,
    config,
    timeZone,
    log,
    executor,
    timers: o.timers,
  });
  const auth = new AuthService({ db, config, log, passwordScheme: o.passwordScheme });
  const push = new PushService({ db, config, log });
  return {
    linktap,
    mock: 'mock' in built ? built.mock : undefined,
    poller,
    executor,
    weather,
    scheduler,
    gcal,
    auth,
    push,
  };
}
