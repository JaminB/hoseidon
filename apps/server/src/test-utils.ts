import { createApp } from './app';
import { loadConfig } from './config';
import { openDb } from './db';
import { createLinkTapClient, type Bucket } from './linktap/client';
import { LinkTapMock, type MockOptions } from './linktap/mock';
import { Poller } from './poller';

const NO_LIMITS: Record<Bucket, { intervalMs: number }> = {
  devices: { intervalMs: 0 },
  status: { intervalMs: 0 },
  history: { intervalMs: 0 },
  command: { intervalMs: 0 },
};

/**
 * In-memory DB + LinkTap mock + client + poller + app. Rate limits are off on both sides unless
 * `realLimits` is set, so tests don't have to wait out 5-minute windows.
 */
export function harness(
  opts: { realLimits?: boolean; mock?: MockOptions; env?: NodeJS.ProcessEnv } = {},
) {
  const { db, sqlite } = openDb(':memory:');
  const mock = new LinkTapMock({
    enforceRateLimits: opts.realLimits ?? false,
    timeZone: 'UTC',
    ...opts.mock,
  });
  const client = createLinkTapClient({
    username: 'tester',
    apiKey: 'key',
    transport: mock.transport(),
    limits: opts.realLimits ? undefined : NO_LIMITS,
  });
  const poller = new Poller({ db, client, timeZone: 'UTC' });
  const config = loadConfig({
    LINKTAP_MOCK: 'true',
    WEB_DIST: './nonexistent',
    WEBHOOK_SECRET: 's3cret',
    ...opts.env,
  });
  const app = createApp({ config, db, linktap: client, poller });
  return { db, sqlite, mock, client, poller, app, config };
}
