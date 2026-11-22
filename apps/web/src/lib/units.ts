import { useSyncExternalStore } from 'react';

export type UnitSystem = 'metric' | 'imperial';

const KEY = 'hoseidon.units';
const ML_PER_GAL = 3785.411784;
const MM_PER_IN = 25.4;

/** Imperial where people usually expect it (US, Liberia, Myanmar), metric elsewhere. */
export function defaultUnits(
  language = typeof navigator === 'undefined' ? '' : navigator.language,
) {
  return /^en-(US|LR|MM)\b/.test(language) ? 'imperial' : 'metric';
}

function read(): UnitSystem {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'metric' || v === 'imperial') return v;
  } catch {
    // private mode or blocked storage: fall through to the default
  }
  return defaultUnits();
}

let current: UnitSystem = typeof window === 'undefined' ? 'metric' : read();
const listeners = new Set<() => void>();

export const getUnits = () => current;

export function setUnits(next: UnitSystem) {
  current = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // not persisted, still applies for this visit
  }
  for (const l of listeners) l();
}

export function useUnits(): [UnitSystem, (u: UnitSystem) => void] {
  const units = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
    () => 'metric' as const,
  );
  return [units, setUnits];
}

// ---- conversions (the server always speaks metric) --------------------------------------------

export const mlToVolume = (ml: number, u: UnitSystem = current) =>
  u === 'imperial' ? ml / ML_PER_GAL : ml / 1000;

export const mmToDepth = (mm: number, u: UnitSystem = current) =>
  u === 'imperial' ? mm / MM_PER_IN : mm;

export const cToTemp = (c: number, u: UnitSystem = current) =>
  u === 'imperial' ? (c * 9) / 5 + 32 : c;

export const unitLabels = (u: UnitSystem = current) =>
  u === 'imperial'
    ? { volume: 'gal', flow: 'gal/min', depth: 'in' }
    : { volume: 'L', flow: 'L/min', depth: 'mm' };

const round = (n: number, places: number) => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

/** "12.4 L" / "1,250 L" / "3.2 kL", or "3.3 gal" / "1,250 gal" / "3.2k gal". */
export function formatVolume(ml: number, u: UnitSystem = current): string {
  const v = mlToVolume(ml, u);
  const unit = unitLabels(u).volume;
  if (v >= 10_000) return `${(v / 1000).toFixed(1)}${u === 'imperial' ? 'k gal' : ' kL'}`;
  if (v >= 100) return `${Math.round(v).toLocaleString()} ${unit}`;
  if (v >= 10) return `${v.toFixed(0)} ${unit}`;
  return `${v.toFixed(1)} ${unit}`;
}

/** Rain depth: "4.2 mm" or "0.17 in". */
export function formatDepth(mm: number | null, u: UnitSystem = current): string {
  if (mm === null) return '—';
  return u === 'imperial' ? `${round(mmToDepth(mm, u), 2)} in` : `${round(mm, 1)} mm`;
}

export function formatTemp(c: number | null, u: UnitSystem = current): string {
  return c === null ? '—' : `${Math.round(cToTemp(c, u))}°`;
}

export function formatFlow(mlPerMin: number, u: UnitSystem = current): string {
  return `${round(mlToVolume(mlPerMin, u), u === 'imperial' ? 2 : 1)} ${unitLabels(u).flow}`;
}
