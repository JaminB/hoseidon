import { eq } from 'drizzle-orm';
import type { Db } from './index';
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

export function getJson<T>(db: Pick<Db, 'select'>, key: string): T | undefined {
  const raw = getSetting(db, key);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}
