import { useEffect, useMemo, useRef } from 'react';
import { buildHeatmap, parseDate, type HeatCell } from '../../lib/analytics';
import { longDate } from './charts';

const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'short' });
const LEVEL_MIX = [0, 28, 52, 76, 100] as const;

/** Level 0 is the empty tile; the rest are the accent blended into it. Follows light/dark. */
const levelColor = (level: HeatCell['level']) =>
  level === 0
    ? 'var(--app-surface-3)'
    : `color-mix(in oklab, var(--app-accent) ${LEVEL_MIX[level]}%, var(--app-surface-3))`;

/** GitHub-style calendar heatmap of one number per day. */
export function Heatmap({
  days,
  format,
  label,
}: {
  days: { date: string; value: number }[];
  /** How a day's value reads in the tooltip, e.g. "12 L". */
  format: (value: number) => string;
  label: string;
}) {
  const { weeks } = useMemo(() => buildHeatmap(days), [days]);
  const scroller = useRef<HTMLDivElement>(null);
  // Long ranges overflow on phones; start at the most recent week.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [weeks.length]);

  // Label a month above the first week that starts it.
  const months = weeks.map((w, i) => {
    const first = w.find((c) => c !== null);
    if (!first) return '';
    const d = parseDate(first.date);
    const prev = weeks[i - 1]?.find((c) => c !== null);
    const newMonth = !prev || parseDate(prev.date).getMonth() !== d.getMonth();
    return newMonth && (i > 0 || d.getDate() <= 14) ? monthFmt.format(d) : '';
  });

  return (
    <div>
      <div ref={scroller} className="-mx-1 overflow-x-auto px-1 pb-1">
        <div
          role="img"
          aria-label={label}
          className="grid w-max gap-[3px]"
          style={{ gridTemplateColumns: `repeat(${weeks.length}, 13px)` }}
        >
          {months.map((m, i) => (
            <div
              key={`m${i}`}
              className="text-subtle h-4 text-[11px] leading-4"
              style={{ gridColumn: i + 1, gridRow: 1 }}
            >
              <span className="whitespace-nowrap">{m}</span>
            </div>
          ))}
          {Array.from({ length: 7 }, (_, row) =>
            weeks.map((w, col) => {
              const c = w[row];
              return c ? (
                <div
                  key={c.date}
                  title={`${longDate(c.date)}: ${c.value > 0 ? format(c.value) : 'no watering'}`}
                  className="size-[13px] rounded-[3px]"
                  style={{ background: levelColor(c.level), gridColumn: col + 1, gridRow: row + 2 }}
                />
              ) : null;
            }),
          )}
        </div>
      </div>
      <div className="text-subtle mt-2 flex items-center justify-end gap-1.5 text-[11px]">
        Less
        {([0, 1, 2, 3, 4] as const).map((l) => (
          <span
            key={l}
            className="size-[11px] rounded-[3px]"
            style={{ background: levelColor(l) }}
          />
        ))}
        More
      </div>
    </div>
  );
}
