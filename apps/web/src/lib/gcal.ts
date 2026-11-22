import type { GcalStatus } from '@hoseidon/shared';
import { formatRelative } from './format';

/** What the OAuth callback's `?gcal=error&reason=` means, in words. */
export const CONNECT_ERRORS: Record<string, string> = {
  denied: 'Google access was declined.',
  state: 'The sign-in link expired or was already used. Try again.',
  exchange: 'Google rejected the sign-in. Check the client ID, secret and redirect URI.',
  scope: 'Calendar access was unticked on the consent screen. Connect again and leave it on.',
  no_refresh_token:
    'Google didn’t return a refresh token. Remove Hoseidon’s access in your Google account and connect again.',
  calendar: 'Connected, but the Hoseidon calendar couldn’t be created. Try again.',
  not_configured: 'Google Calendar isn’t set up on the server yet.',
};

export type GcalPhase = 'unconfigured' | 'disconnected' | 'reconnect' | 'connected';

export function gcalPhase(s: GcalStatus): GcalPhase {
  if (!s.configured) return 'unconfigured';
  if (!s.connected) return 'disconnected';
  return s.needsReconnect ? 'reconnect' : 'connected';
}

/** "Synced 4 min ago", "Syncing…", "Retrying in 2 min". */
export function syncLabel(s: GcalStatus, now = Date.now()): string {
  const { state, nextRunAt } = s.sync;
  if (state === 'running' || state === 'pending') return 'Syncing…';
  if (state === 'backoff' && nextRunAt) {
    const when = formatRelative(nextRunAt, now);
    return when === 'now' ? 'Retrying now' : `Retrying ${when}`;
  }
  if (!s.lastSyncAt) return 'Not synced yet';
  const ago = formatRelative(s.lastSyncAt, now);
  return ago === 'now' ? 'Synced just now' : `Synced ${ago}`;
}

/**
 * Google expires a Testing-mode app's grant after 7 days. Null when it's far off; otherwise a
 * nudge to reconnect before sync stops.
 */
export function reconnectHint(s: GcalStatus, now = Date.now()): string | null {
  if (!s.reconnectDueAt || s.needsReconnect) return null;
  const left = Date.parse(s.reconnectDueAt) - now;
  if (left > 2 * 86_400_000) return null;
  if (left <= 0) return 'Testing-mode access may have expired. Reconnect if sync stops.';
  return `Testing-mode access expires ${formatRelative(s.reconnectDueAt, now)}. Reconnect to reset it.`;
}

export const eventCounts = (s: GcalStatus) => {
  const parts = [`${s.events.schedules} schedule${s.events.schedules === 1 ? '' : 's'}`];
  if (s.events.skips) parts.push(`${s.events.skips} skipped`);
  if (s.events.logs) parts.push(`${s.events.logs} logged run${s.events.logs === 1 ? '' : 's'}`);
  return parts.join(' · ');
};
