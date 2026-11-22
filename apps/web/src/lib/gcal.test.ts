import { describe, expect, it } from 'vitest';
import type { GcalStatus } from '@hoseidon/shared';
import { eventCounts, gcalPhase, reconnectHint, syncLabel } from './gcal';

const NOW = Date.parse('2026-06-10T12:00:00Z');
const status = (over: Partial<GcalStatus> = {}): GcalStatus => ({
  configured: true,
  missing: [],
  redirectUri: 'http://localhost:8787/api/gcal/callback',
  connected: true,
  needsReconnect: false,
  calendarId: 'cal@group.calendar.google.com',
  calendarUrl: 'https://calendar.google.com/calendar/u/0/r?cid=cal',
  connectedAt: '2026-06-08T12:00:00Z',
  reconnectDueAt: '2026-06-15T12:00:00Z',
  lastSyncAt: '2026-06-10T11:56:00Z',
  lastError: null,
  sync: { state: 'idle', nextRunAt: null, failures: 0 },
  events: { schedules: 3, skips: 0, logs: 0 },
  logRuns: false,
  ...over,
});

describe('gcalPhase', () => {
  it('walks through the setup states', () => {
    expect(gcalPhase(status({ configured: false, connected: false }))).toBe('unconfigured');
    expect(gcalPhase(status({ connected: false }))).toBe('disconnected');
    expect(gcalPhase(status({ needsReconnect: true }))).toBe('reconnect');
    expect(gcalPhase(status())).toBe('connected');
  });
});

describe('syncLabel', () => {
  it('describes the queue state', () => {
    expect(syncLabel(status(), NOW)).toBe('Synced 4 min ago');
    expect(syncLabel(status({ lastSyncAt: '2026-06-10T11:59:50Z' }), NOW)).toBe('Synced just now');
    expect(syncLabel(status({ lastSyncAt: null }), NOW)).toBe('Not synced yet');
    expect(
      syncLabel(status({ sync: { state: 'running', nextRunAt: null, failures: 0 } }), NOW),
    ).toBe('Syncing…');
    expect(
      syncLabel(
        status({ sync: { state: 'backoff', nextRunAt: '2026-06-10T12:02:00Z', failures: 2 } }),
        NOW,
      ),
    ).toBe('Retrying in 2 min');
  });
});

describe('reconnectHint', () => {
  it('only nudges near the 7-day Testing-mode expiry', () => {
    expect(reconnectHint(status(), NOW)).toBeNull();
    expect(reconnectHint(status(), Date.parse('2026-06-14T12:00:00Z'))).toBe(
      'Testing-mode access expires in 1 d. Reconnect to reset it.',
    );
    expect(reconnectHint(status(), Date.parse('2026-06-16T00:00:00Z'))).toMatch(/may have expired/);
    expect(
      reconnectHint(status({ needsReconnect: true }), Date.parse('2026-06-16T00:00:00Z')),
    ).toBeNull();
  });
});

describe('eventCounts', () => {
  it('pluralizes and hides zero extras', () => {
    expect(eventCounts(status())).toBe('3 schedules');
    expect(eventCounts(status({ events: { schedules: 1, skips: 2, logs: 1 } }))).toBe(
      '1 schedule · 2 skipped · 1 logged run',
    );
  });
});
