/**
 * Cloudflare Durable Object SQLite allows at most 100 bound parameters per statement (Node's
 * SQLite allows far more, so tests on Node never notice). Split multi-row inserts and long IN
 * lists so each statement stays under it.
 */
export const MAX_SQL_VARS = 100;

/** Split rows so rows-per-chunk x columns stays under MAX_SQL_VARS (with one spare). */
export function chunkRows<T extends object>(rows: T[]): T[][] {
  if (!rows.length) return [];
  const cols = Math.max(1, ...rows.map((r) => Object.keys(r).length));
  return chunk(rows, Math.max(1, Math.floor((MAX_SQL_VARS - 1) / cols)));
}

/** Split a list of IN (...) values; leaves room for a few other parameters in the statement. */
export function chunkIds<T>(ids: T[], size = MAX_SQL_VARS - 10): T[][] {
  return chunk(ids, size);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
