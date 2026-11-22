import { and, eq, gt, like, lt } from 'drizzle-orm';
import type { Db } from './types';
import { ephemeral } from './schema';

/**
 * Short-lived values with an expiry (the `ephemeral` table). Expired rows read as missing and are
 * pruned lazily, so nothing has to run on a timer.
 */
export function putEphemeral(db: Db, key: string, value: string, expiresAt: Date): void {
  db.insert(ephemeral)
    .values({ key, value, expiresAt })
    .onConflictDoUpdate({ target: ephemeral.key, set: { value, expiresAt } })
    .run();
}

export function getEphemeral(db: Db, key: string, now: Date): string | undefined {
  return db
    .select({ value: ephemeral.value })
    .from(ephemeral)
    .where(and(eq(ephemeral.key, key), gt(ephemeral.expiresAt, now)))
    .get()?.value;
}

/** Read and delete in one go: a value that was taken once can't be taken again. */
export function takeEphemeral(db: Db, key: string, now: Date): string | undefined {
  const row = db
    .delete(ephemeral)
    .where(eq(ephemeral.key, key))
    .returning({ value: ephemeral.value, expiresAt: ephemeral.expiresAt })
    .get();
  return row && row.expiresAt > now ? row.value : undefined;
}

export function deleteEphemeral(db: Db, key: string): void {
  db.delete(ephemeral).where(eq(ephemeral.key, key)).run();
}

/** Live entries whose key starts with `prefix`. */
export function listEphemeral(db: Db, prefix: string, now: Date): { key: string; value: string }[] {
  return db
    .select({ key: ephemeral.key, value: ephemeral.value })
    .from(ephemeral)
    .where(
      and(like(ephemeral.key, `${prefix.replace(/[%_]/g, '')}%`), gt(ephemeral.expiresAt, now)),
    )
    .all();
}

export function pruneEphemeral(db: Db, now: Date): void {
  db.delete(ephemeral).where(lt(ephemeral.expiresAt, now)).run();
}
