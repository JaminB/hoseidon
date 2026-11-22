import { describe, expect, it } from 'vitest';
import type { GcalEventRow } from '../db/schema';
import { diffSync, type Desired } from './sync';

const NOW = new Date('2026-06-20T12:00:00Z');
const windowStart = new Date('2026-06-06T12:00:00Z');
const old = new Date('2026-06-01T06:00:00Z');
const recent = new Date('2026-06-19T06:00:00Z');

const want = (
  key: string,
  kind: Desired['kind'],
  hash: string,
  at: Date | null = null,
): Desired => ({
  key,
  kind,
  hash,
  at,
});
const row = (
  key: string,
  kind: GcalEventRow['kind'],
  hash: string,
  at: Date | null = null,
): GcalEventRow => ({
  key,
  kind,
  hash,
  at,
  eventId: `ev-${key}`,
  syncedAt: NOW,
});

const summary = (ops: ReturnType<typeof diffSync>) =>
  ops.map((o) => `${o.type} ${o.type === 'delete' ? o.row.key : o.item.key}`);

describe('diffSync', () => {
  it('inserts new items, updates changed ones and leaves the rest', () => {
    const ops = diffSync(
      [
        want('schedule:1', 'schedule', 'h1'),
        want('schedule:2', 'schedule', 'h2b'),
        want('schedule:3', 'schedule', 'h3'),
      ],
      [row('schedule:2', 'schedule', 'h2'), row('schedule:3', 'schedule', 'h3')],
      { windowStart, logRuns: true },
    );
    expect(summary(ops)).toEqual(['insert schedule:1', 'update schedule:2']);
  });

  it('deletes schedules that are gone, always', () => {
    const ops = diffSync([], [row('schedule:1', 'schedule', 'h')], { windowStart, logRuns: true });
    expect(summary(ops)).toEqual(['delete schedule:1']);
  });

  it('leaves skips and logs that fell out of the window alone', () => {
    const ops = diffSync(
      [want('schedule:1', 'schedule', 'h')],
      [
        row('schedule:1', 'schedule', 'h'),
        row('skip:1:old', 'skip', 'h', old),
        row('occ:1:old', 'log', 'h', old),
        row('skip:1:recent', 'skip', 'h', recent),
        row('run:5', 'log', 'h', recent),
      ],
      { windowStart, logRuns: true },
    );
    expect(summary(ops)).toEqual(['delete skip:1:recent', 'delete run:5']);
  });

  it('removes all logs when logging is turned off, and skips whose series is gone', () => {
    const ops = diffSync(
      [],
      [
        row('occ:1:old', 'log', 'h', old),
        row('skip:2:old', 'skip', 'h', old),
        row('schedule:2', 'schedule', 'h'),
      ],
      { windowStart, logRuns: false },
    );
    expect(summary(ops)).toEqual(['delete schedule:2', 'delete skip:2:old', 'delete occ:1:old']);
  });

  it('orders series before skips before logs, deletes last within a kind', () => {
    const ops = diffSync(
      [
        want('run:1', 'log', 'h', recent),
        want('skip:1:x', 'skip', 'h', recent),
        want('schedule:1', 'schedule', 'h'),
      ],
      [row('schedule:9', 'schedule', 'h')],
      { windowStart, logRuns: true },
    );
    expect(summary(ops)).toEqual([
      'insert schedule:1',
      'delete schedule:9',
      'insert skip:1:x',
      'insert run:1',
    ]);
  });
});
