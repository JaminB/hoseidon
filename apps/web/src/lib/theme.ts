import { useSyncExternalStore } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'hoseidon.theme';
const media = () => window.matchMedia('(prefers-color-scheme: dark)');

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

let pref: ThemePref = typeof window === 'undefined' ? 'system' : readPref();
const listeners = new Set<() => void>();

function apply() {
  const dark = pref === 'dark' || (pref === 'system' && media().matches);
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? '#111518' : '#fafbfc');
}

/** Call once at startup: applies the theme and follows the OS while on "system". */
export function initTheme() {
  apply();
  media().addEventListener('change', () => {
    if (pref === 'system') apply();
  });
}

export function setTheme(next: ThemePref) {
  pref = next;
  try {
    if (next === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {
    // Storage blocked (private mode): the choice lasts for this tab only.
  }
  apply();
  for (const l of listeners) l();
}

export function useTheme(): [ThemePref, (t: ThemePref) => void] {
  const value = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => pref,
  );
  return [value, setTheme];
}
