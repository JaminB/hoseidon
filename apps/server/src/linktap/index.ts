import type { Config } from '../config';
import { createLinkTapClient, httpTransport, type LinkTapClient } from './client';
import type { LastCallStore } from './rate-limit';
import { LinkTapMock } from './mock';

export * from './client';
export { LinkTapMock } from './mock';

/**
 * The LinkTap client for this config: the in-process mock when LINKTAP_MOCK=true, otherwise the
 * real cloud API (which moves real water).
 */
export function linktapFromConfig(
  config: Config,
  store?: LastCallStore,
): { client: LinkTapClient; mock?: LinkTapMock } {
  if (config.LINKTAP_MOCK) {
    const mock = new LinkTapMock();
    const client = createLinkTapClient({
      username: config.LINKTAP_USERNAME || 'mock',
      apiKey: config.LINKTAP_API_KEY || 'mock',
      transport: mock.transport(),
      store,
    });
    return { client, mock };
  }
  if (!config.LINKTAP_USERNAME || !config.LINKTAP_API_KEY) {
    throw new Error('LINKTAP_USERNAME and LINKTAP_API_KEY are required when LINKTAP_MOCK=false');
  }
  return {
    client: createLinkTapClient({
      username: config.LINKTAP_USERNAME,
      apiKey: config.LINKTAP_API_KEY,
      transport: httpTransport(),
      store,
    }),
  };
}
