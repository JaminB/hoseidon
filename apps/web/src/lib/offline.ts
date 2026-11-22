import { useSyncExternalStore } from 'react';

/** The newest successful fetch among `queries`, as epoch ms, or null if none has landed yet. */
export function lastUpdatedAt(queries: { state: { dataUpdatedAt: number } }[]): number | null {
  let latest = 0;
  for (const q of queries) latest = Math.max(latest, q.state.dataUpdatedAt);
  return latest > 0 ? latest : null;
}

/** "just now", "12 min ago", "3 h ago", "2 d ago". */
export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

/** The banner text, or null when everything is live. */
export function offlineMessage(
  state: { online: boolean; serverUp: boolean; lastUpdated: number | null },
  now = Date.now(),
): string | null {
  if (state.online && state.serverUp) return null;
  const why = state.online ? 'Can’t reach Hoseidon' : 'You’re offline';
  return state.lastUpdated
    ? `${why} · showing data from ${ago(state.lastUpdated, now)}`
    : `${why} · nothing saved to show yet`;
}

function subscribe(cb: () => void) {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
}

export const useOnline = () =>
  useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
