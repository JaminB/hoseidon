import { eq } from 'drizzle-orm';
import { DEFAULT_WEAK_SIGNAL_PCT } from '@hoseidon/shared';
import type { Db } from '../db/types';
import { settings } from '../db/schema';

const WEAK_SIGNAL_KEY = 'network.weakSignalPct';

export function readWeakSignalPct(db: Pick<Db, 'select'>): number {
  const row = db.select().from(settings).where(eq(settings.key, WEAK_SIGNAL_KEY)).get();
  const n = row ? Number(row.value) : NaN;
  return Number.isFinite(n) ? n : DEFAULT_WEAK_SIGNAL_PCT;
}

export function writeWeakSignalPct(db: Pick<Db, 'insert'>, pct: number): void {
  const value = String(pct);
  db.insert(settings)
    .values({ key: WEAK_SIGNAL_KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
}
