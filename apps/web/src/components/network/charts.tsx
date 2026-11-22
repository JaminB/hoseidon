import type { Series, TimelineSegment } from '@hoseidon/shared';
import { cn } from '../../lib/cn';
import { formatRelative } from '../../lib/format';
import { segmentBars, sparkline, TONE_VAR, type Tone } from '../../lib/network';

const dateTime = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

const STATE_CLASS = {
  online: 'bg-ok/80',
  offline: 'bg-danger',
  // Unknown is "we weren't watching": a quiet hatch, not a colour that reads as a problem.
  unknown: 'bg-surface-3',
} as const;

const STATE_LABEL = { online: 'Online', offline: 'Offline', unknown: 'No data' } as const;

/** A thin online/offline/no-data strip across the window. */
export function UptimeBar({
  segments,
  from,
  to,
  className,
}: {
  segments: TimelineSegment[];
  from: number;
  to: number;
  className?: string;
}) {
  const bars = segmentBars(segments, from, to);
  const outages = bars.filter((b) => b.state === 'offline').length;
  return (
    <div
      className={cn('bg-surface-3 relative h-2.5 w-full overflow-hidden rounded-full', className)}
      role="img"
      aria-label={`Uptime timeline: ${outages} offline stretch${outages === 1 ? '' : 'es'}`}
    >
      {bars.map((b) => (
        <span
          key={b.start}
          className={cn('absolute inset-y-0', STATE_CLASS[b.state])}
          style={{
            left: `${b.left}%`,
            width: `${b.width}%`,
            ...(b.state === 'unknown'
              ? {
                  backgroundImage:
                    'repeating-linear-gradient(135deg, transparent 0 3px, var(--app-line-strong) 3px 4px)',
                }
              : null),
          }}
          title={`${STATE_LABEL[b.state]} · ${dateTime.format(new Date(b.start))} to ${dateTime.format(new Date(b.end))}`}
        />
      ))}
    </div>
  );
}

/** Axis labels for an UptimeBar. */
export function UptimeAxis({ from, to }: { from: number; to: number }) {
  return (
    <div className="text-subtle mt-1 flex justify-between text-[11px]">
      <span>{formatRelative(new Date(from), to)}</span>
      <span>now</span>
    </div>
  );
}

/** A small line chart of a 0-100 series, with an optional dashed threshold. */
export function Sparkline({
  series,
  tone = 'ok',
  threshold,
  width = 120,
  height = 32,
  label,
  className,
}: {
  series: Series;
  tone?: Tone;
  threshold?: number;
  width?: number;
  height?: number;
  label: string;
  className?: string;
}) {
  const s = sparkline(series, width, height, { threshold });
  if (series.length < 2) {
    return (
      <div
        className={cn('text-subtle grid place-items-center text-[11px]', className)}
        style={{ width, height }}
      >
        No data yet
      </div>
    );
  }
  const color = TONE_VAR[tone];
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={cn('overflow-visible', className)}
      role="img"
      aria-label={label}
    >
      {s.thresholdY !== null && (
        <line
          x1="0"
          x2={width}
          y1={s.thresholdY}
          y2={s.thresholdY}
          stroke="var(--app-line-strong)"
          strokeDasharray="2 3"
        />
      )}
      <path d={s.area} fill={color} fillOpacity="0.12" />
      <path
        d={s.line}
        fill="none"
        stroke={color}
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {s.last && <circle cx={s.last.x} cy={s.last.y} r="2.4" fill={color} />}
    </svg>
  );
}
