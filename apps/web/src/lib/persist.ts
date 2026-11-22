import type { PersistedClient, Persister } from '@tanstack/react-query-persist-client';
import { del, get, set } from 'idb-keyval';

const KEY = 'hoseidon.query-cache';

/** Last API state survives reloads and offline starts for a week. */
export const CACHE_MAX_AGE_MS = 7 * 24 * 3600_000;
/** Bump to throw away caches whose shape no longer matches the app. */
export const CACHE_BUSTER = '1';

/**
 * Saves the TanStack Query cache to IndexedDB. Writes are collapsed to one per second, and every
 * storage call is guarded: private windows and blocked storage just mean "no offline cache".
 */
export function createIdbPersister(delayMs = 1000): Persister {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest: PersistedClient | undefined;
  return {
    persistClient(client) {
      latest = client;
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (latest) void set(KEY, latest).catch(() => undefined);
      }, delayMs);
    },
    async restoreClient() {
      try {
        return await get<PersistedClient>(KEY);
      } catch {
        return undefined;
      }
    },
    async removeClient() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      latest = undefined;
      try {
        await del(KEY);
      } catch {
        // nothing to remove
      }
    },
  };
}
