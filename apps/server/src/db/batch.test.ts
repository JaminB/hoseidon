import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { MAX_SQL_VARS, chunkIds, chunkRows } from './batch';
import { plannedRuns } from './schema';

describe('chunkRows', () => {
  it('keeps every chunk under the Durable Object parameter limit', () => {
    const rows = Array.from({ length: 150 }, (_, i) => ({
      a: i,
      b: i,
      c: i,
      d: i,
      e: i,
      f: i,
      g: i,
      h: i,
      i: i,
      j: i,
      k: i,
    }));
    const chunks = chunkRows(rows);
    expect(chunks.flat()).toEqual(rows);
    for (const c of chunks) expect(c.length * 11).toBeLessThan(MAX_SQL_VARS);
  });

  it('counts every table column, not just the fields given', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ deviceId: `d${i}` }));
    const cols = Object.keys(getTableColumns(plannedRuns)).length;
    for (const c of chunkRows(rows, plannedRuns))
      expect(c.length * cols).toBeLessThan(MAX_SQL_VARS);
  });

  it('handles empty and tiny inputs', () => {
    expect(chunkRows([])).toEqual([]);
    expect(chunkRows([{ a: 1 }])).toEqual([[{ a: 1 }]]);
  });
});

describe('chunkIds', () => {
  it('splits long IN lists', () => {
    const ids = Array.from({ length: 250 }, (_, i) => i);
    const chunks = chunkIds(ids);
    expect(chunks.flat()).toEqual(ids);
    for (const c of chunks) expect(c.length).toBeLessThan(MAX_SQL_VARS);
  });
});
