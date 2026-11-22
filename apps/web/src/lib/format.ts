/** "12 min", "1 h 5 min", "45 s". Compact, for chips and timelines. */
export function formatDuration(totalSec: number): string {
  const sec = Math.max(0, Math.round(totalSec));
  if (sec === 0) return '0 min';
  if (sec < 60) return `${sec} s`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** "4:05" or "1:02:09" — a ticking countdown. */
export function formatClock(totalSec: number): string {
  const sec = Math.max(0, Math.ceil(totalSec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

/** Local wall time, e.g. "6:00 AM". */
export function formatTime(d: Date | string): string {
  return timeFmt.format(typeof d === 'string' ? new Date(d) : d);
}

/** "now", "in 5 min", "3 h ago", "in 2 d". */
export function formatRelative(target: Date | string, now = Date.now()): string {
  const t = typeof target === 'string' ? new Date(target).getTime() : target.getTime();
  const diff = Math.round((t - now) / 1000);
  const abs = Math.abs(diff);
  if (abs < 45) return 'now';
  const [n, unit] =
    abs < 3600
      ? [Math.round(abs / 60), 'min']
      : abs < 86_400
        ? [Math.round(abs / 3600), 'h']
        : [Math.round(abs / 86_400), 'd'];
  return diff > 0 ? `in ${n} ${unit}` : `${n} ${unit} ago`;
}

/** "Good morning" etc. for the Home header. */
export function greeting(d = new Date()): string {
  const h = d.getHours();
  if (h < 5) return 'Good night';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

/** Battery buckets for icon + color. */
export function batteryLevel(pct: number | null): 'unknown' | 'critical' | 'low' | 'ok' | 'full' {
  if (pct === null) return 'unknown';
  if (pct < 10) return 'critical';
  if (pct < 20) return 'low';
  if (pct < 70) return 'ok';
  return 'full';
}

/** 0-4 bars. LinkTap treats < 30% as weak (the poller raises signal_low there). */
export function signalBars(pct: number | null): number {
  if (pct === null || pct <= 0) return 0;
  if (pct < 30) return 1;
  if (pct < 55) return 2;
  if (pct < 80) return 3;
  return 4;
}
