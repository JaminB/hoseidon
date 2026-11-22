import { eq } from 'drizzle-orm';
import type { Db } from './types';
import { settings } from './schema';

export function getSetting(db: Pick<Db, 'select'>, key: string): string | undefined {
  return db.select().from(settings).where(eq(settings.key, key)).get()?.value;
}

export function setSetting(db: Pick<Db, 'insert'>, key: string, value: string): void {
  db.insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
}

const LAST_CALL_KEY = 'linktap.lastCall';

/** Every persisted lane time (lane -> epoch ms), e.g. to find the newest history call. */
export function lastCalls(db: Pick<Db, 'select'>): Record<string, number> {
  return getJson<Record<string, number>>(db, LAST_CALL_KEY) ?? {};
}

/** Rate-limit memory backed by the settings table (one JSON object, lane -> epoch ms). */
export function settingsLastCallStore(db: Db): {
  get(lane: string): number | undefined;
  set(lane: string, at: number): void;
} {
  return {
    get: (lane) => getJson<Record<string, number>>(db, LAST_CALL_KEY)?.[lane],
    set: (lane, at) =>
      setSetting(
        db,
        LAST_CALL_KEY,
        JSON.stringify({ ...getJson<Record<string, number>>(db, LAST_CALL_KEY), [lane]: at }),
      ),
  };
}

export function deleteSetting(db: Pick<Db, 'delete'>, key: string): void {
  db.delete(settings).where(eq(settings.key, key)).run();
}

export function getJson<T>(db: Pick<Db, 'select'>, key: string): T | undefined {
  const raw = getSetting(db, key);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}
