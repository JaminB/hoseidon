import { cn } from '../../lib/cn';
import { batteryLevel, formatClock, signalBars } from '../../lib/format';

const BATTERY_COLOR = {
  unknown: 'text-subtle',
  critical: 'text-danger',
  low: 'text-warn',
  ok: 'text-fg',
  full: 'text-ok',
} as const;

export function BatteryIcon({
  pct,
  showLabel = true,
}: {
  pct: number | null;
  showLabel?: boolean;
}) {
  const level = batteryLevel(pct);
  const fill = pct === null ? 0 : Math.max(1.5, (Math.min(100, pct) / 100) * 15);
  return (
    <span
      className={cn('inline-flex items-center gap-1.5', BATTERY_COLOR[level])}
      title={pct === null ? 'Battery unknown' : `Battery ${pct}%`}
    >
      <svg viewBox="0 0 24 12" className="h-3 w-6" aria-hidden>
        <rect
          x="0.75"
          y="0.75"
          width="19.5"
          height="10.5"
          rx="2.75"
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.45"
          strokeWidth="1.5"
        />
        <rect
          x="21.5"
          y="3.75"
          width="1.75"
          height="4.5"
          rx="0.8"
          fill="currentColor"
          fillOpacity="0.45"
        />
        <rect x="2.75" y="2.75" width={fill} height="6.5" rx="1.25" fill="currentColor" />
      </svg>
      {showLabel && (
        <span className="tnum text-[13px] font-medium">
          {pct === null ? '—' : `${Math.round(pct)}%`}
        </span>
      )}
    </span>
  );
}

export function SignalBars({ pct, showLabel = true }: { pct: number | null; showLabel?: boolean }) {
  const bars = signalBars(pct);
  const color = bars === 0 ? 'text-subtle' : bars === 1 ? 'text-warn' : 'text-fg';
  return (
    <span
      className={cn('inline-flex items-center gap-1.5', color)}
      title={pct === null ? 'Signal unknown' : `Signal ${pct}%`}
    >
      <svg viewBox="0 0 16 12" className="h-3 w-4" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <rect
            key={i}
            x={i * 4.25}
            y={9 - i * 3}
            width="3"
            height={3 + i * 3}
            rx="0.9"
            fill="currentColor"
            fillOpacity={i < bars ? 1 : 0.2}
          />
        ))}
      </svg>
      {showLabel && (
        <span className="tnum text-[13px] font-medium">
          {pct === null ? '—' : `${Math.round(pct)}%`}
        </span>
      )}
    </span>
  );
}

/**
 * A ring that drains as a run counts down. `remaining`/`total` in seconds; the label shows the
 * remaining clock time.
 */
export function CountdownRing({
  remaining,
  total,
  size = 88,
  stroke = 6,
  className,
}: {
  remaining: number;
  total: number;
  size?: number;
  stroke?: number;
  className?: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const frac = total > 0 ? Math.min(1, Math.max(0, remaining / total)) : 0;
  return (
    <div className={cn('relative shrink-0', className)} style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="-rotate-90"
        aria-hidden
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--app-accent-soft)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--app-accent)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - frac)}
          className="transition-[stroke-dashoffset] duration-1000 ease-linear"
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center">
        <div className="text-center leading-none">
          <div className="tnum font-semibold tracking-tight" style={{ fontSize: size * 0.2 }}>
            {formatClock(remaining)}
          </div>
          <div className="text-subtle mt-1 text-[10px] font-medium tracking-wide uppercase">
            left
          </div>
        </div>
      </div>
    </div>
  );
}
