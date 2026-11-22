import type { PreviewOccurrence } from '@hoseidon/shared';
import { TriangleAlert } from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  addDays,
  dragRange,
  layoutDay,
  minuteOfDay,
  MIN_PER_DAY,
  sameDay,
  visibleHourRange,
} from '../../lib/calendar';
import { cn } from '../../lib/cn';
import { formatTime } from '../../lib/format';
import { useNow } from '../../lib/use-now';

const HOUR_PX = 48;
const PX_PER_MIN = HOUR_PX / 60;
/** A lane narrower than this can't fit a title, so the block shrinks to a dot and a time. */
const COMPACT_PX = 80;
/** Blocks shorter than this still get room for their title. */
const MIN_BLOCK_PX = 22;

interface Block {
  id: string;
  start: Date;
  end: Date;
  occ: PreviewOccurrence;
}

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const hourFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric' });

export function WeekView({
  days,
  occurrences,
  zoneNames,
  onCreate,
  onOpen,
}: {
  days: Date[];
  occurrences: PreviewOccurrence[];
  zoneNames: (deviceId: string) => string;
  onCreate: (day: Date, startMin: number, endMin: number) => void;
  onOpen: (scheduleId: number) => void;
}) {
  const now = useNow(60_000);
  const [fullDay, setFullDay] = useState(false);

  const blocks = useMemo<Block[]>(
    () =>
      occurrences.map((o) => ({
        id: `${o.scheduleId}-${o.start}`,
        start: new Date(o.start),
        end: new Date(o.end),
        occ: o,
      })),
    [occurrences],
  );

  // Show the hours that have something in them; "Full day" opens all 24 h to add elsewhere.
  const [fitStart, fitEnd] = useMemo(() => visibleHourRange(blocks, days), [blocks, days]);
  const [startHour, endHour] = fullDay ? [0, 24] : [fitStart, fitEnd];
  const startMin = startHour * 60;

  return (
    <div className="bg-surface border-line flex min-h-0 flex-col overflow-hidden rounded-xl border shadow-sm">
      {/* Day headers */}
      <div
        className="border-line grid border-b"
        style={{ gridTemplateColumns: `52px repeat(${days.length}, minmax(0, 1fr))` }}
      >
        <div />
        {days.map((d) => {
          const today = sameDay(d, new Date(now));
          return (
            <div
              key={d.toISOString()}
              className="border-line flex flex-col items-center gap-0.5 border-l py-2.5"
            >
              <span
                className={cn(
                  'text-[11px] font-medium tracking-wide uppercase',
                  today ? 'text-accent-strong' : 'text-subtle',
                )}
              >
                {dayFmt.format(d)}
              </span>
              <span
                className={cn(
                  'tnum grid size-7 place-items-center rounded-full text-[15px] font-semibold',
                  today && 'bg-accent text-accent-fg',
                )}
              >
                {d.getDate()}
              </span>
            </div>
          );
        })}
      </div>

      {/* Time grid */}
      <div
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
        style={{ maxHeight: 'min(72dvh, 820px)' }}
      >
        <div
          className="grid"
          style={{
            gridTemplateColumns: `52px repeat(${days.length}, minmax(0, 1fr))`,
            height: (endHour - startHour) * HOUR_PX,
          }}
        >
          <div className="relative">
            {Array.from({ length: endHour - startHour - 1 }, (_, i) => startHour + i + 1).map(
              (h) => (
                <span
                  key={h}
                  className="text-subtle tnum absolute right-2 -translate-y-1/2 text-[10.5px]"
                  style={{ top: (h - startHour) * HOUR_PX }}
                >
                  {hourFmt.format(new Date(2000, 0, 1, h))}
                </span>
              ),
            )}
          </div>
          {days.map((d) => (
            <DayColumn
              key={d.toISOString()}
              day={d}
              blocks={blocks}
              now={now}
              startMin={startMin}
              endMin={endHour * 60}
              zoneNames={zoneNames}
              onCreate={onCreate}
              onOpen={onOpen}
            />
          ))}
        </div>
      </div>
      <div className="border-line flex justify-end border-t px-2 py-1">
        <button
          type="button"
          onClick={() => setFullDay((v) => !v)}
          className="text-subtle hover:text-fg rounded px-1.5 py-0.5 text-xs transition-colors"
        >
          {fullDay ? 'Fit to schedule' : 'Show full day'}
        </button>
      </div>
    </div>
  );
}

function DayColumn({
  day,
  blocks,
  now,
  startMin,
  endMin,
  zoneNames,
  onCreate,
  onOpen,
}: {
  day: Date;
  blocks: Block[];
  now: number;
  /** The grid's first and last visible minute of the day. */
  startMin: number;
  endMin: number;
  zoneNames: (deviceId: string) => string;
  onCreate: (day: Date, startMin: number, endMin: number) => void;
  onOpen: (scheduleId: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ from: number; to: number; moved: boolean } | null>(null);
  // Touch: where the finger went down. A scroll cancels the pointer, so only a real tap creates.
  const tap = useRef<{ y: number; minute: number } | null>(null);
  const laid = useMemo(() => layoutDay(blocks, day), [blocks, day]);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const isToday = sameDay(day, new Date(now));
  const isPast = addDays(day, 1).getTime() <= now;

  const minuteAt = (clientY: number) => {
    const rect = ref.current!.getBoundingClientRect();
    return Math.min(endMin, Math.max(startMin, startMin + (clientY - rect.top) / PX_PER_MIN));
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    const m = minuteAt(e.clientY);
    if (e.pointerType !== 'mouse') {
      // Touch: a tap (not a scroll) makes a 30 min block; dragging would fight scrolling.
      tap.current = { y: e.clientY, minute: m };
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ from: m, to: m, moved: false });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (tap.current && Math.abs(e.clientY - tap.current.y) > 8) tap.current = null;
    if (drag) {
      const to = minuteAt(e.clientY);
      setDrag({ ...drag, to, moved: drag.moved || Math.abs(to - drag.from) * PX_PER_MIN > 4 });
    }
  };
  const createAt = (minute: number) => {
    const start = Math.floor(minute / 15) * 15;
    onCreate(day, start, Math.min(MIN_PER_DAY, start + 30));
  };
  const onPointerUp = () => {
    if (tap.current) {
      createAt(tap.current.minute);
      tap.current = null;
      return;
    }
    if (!drag) return;
    setDrag(null);
    // A plain click (no real drag) gives a 30 min block.
    if (!drag.moved) return createAt(drag.from);
    const r = dragRange(drag.from, drag.to);
    onCreate(day, r.start, r.end);
  };
  const onPointerCancel = () => {
    tap.current = null;
    setDrag(null);
  };

  const preview = drag ? dragRange(drag.from, drag.to) : null;

  return (
    <div
      ref={ref}
      className={cn(
        'border-line relative touch-pan-y border-l select-none',
        'bg-[repeating-linear-gradient(to_bottom,transparent_0,transparent_47px,var(--app-line)_47px,var(--app-line)_48px)]',
        isPast && 'bg-surface-2/40',
        'cursor-cell',
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      aria-label={`${day.toDateString()}: drag to add a schedule`}
    >
      {laid.map(({ item, top, bottom, lane, lanes, clippedStart }) => {
        const { occ } = item;
        const height = Math.max(MIN_BLOCK_PX, (bottom - top) * PX_PER_MIN - 2);
        const compact = width > 0 && width / lanes < COMPACT_PX;
        const tiny = width > 0 && width / lanes < 44;
        const overlap = occ.overlapsWith.length > 0;
        const past = item.end.getTime() < now;
        const zones = [...new Set(occ.slots.map((s) => s.deviceId))];
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onOpen(occ.scheduleId)}
            className={cn(
              'absolute overflow-hidden rounded-md border-l-[3px] px-1.5 py-1 text-left transition-[filter,box-shadow] hover:brightness-[0.97] hover:shadow-md dark:hover:brightness-110',
              past && 'opacity-55',
              overlap && 'ring-danger/70 ring-1',
            )}
            style={{
              top: (top - startMin) * PX_PER_MIN + 1,
              height: compact ? Math.min(height, 40) : height,
              left: `calc(${(lane / lanes) * 100}% + 2px)`,
              width: `calc(${100 / lanes}% - 4px)`,
              borderLeftColor: occ.color,
              background: `color-mix(in oklab, ${occ.color} 16%, var(--app-surface))`,
              color: `color-mix(in oklab, ${occ.color} 55%, var(--app-fg))`,
            }}
            title={`${occ.name} · ${formatTime(occ.start)}–${formatTime(occ.end)}${overlap ? ' · overlaps another schedule' : ''}`}
          >
            {compact ? (
              <div className="flex items-center gap-1">
                <span className="size-2 shrink-0 rounded-full" style={{ background: occ.color }} />
                {!tiny && (
                  <span className="tnum truncate text-[10.5px] leading-4 font-semibold">
                    {formatTime(occ.start).replace(/\s?[AP]M$/i, '')}
                  </span>
                )}
                {overlap && !tiny && <TriangleAlert className="text-danger size-3 shrink-0" />}
              </div>
            ) : (
              <div className="flex items-center gap-1">
                {overlap && <TriangleAlert className="text-danger size-3 shrink-0" />}
                <span className="truncate text-[11.5px] leading-4 font-semibold">{occ.name}</span>
              </div>
            )}
            {!compact && height > 36 && (
              <div className="tnum truncate text-[10.5px] leading-4 opacity-80">
                {clippedStart ? '…' : formatTime(occ.start)} – {formatTime(occ.end)}
              </div>
            )}
            {!compact && height > 54 && (
              <div className="truncate text-[10.5px] leading-4 opacity-70">
                {zones.map(zoneNames).join(', ')}
              </div>
            )}
          </button>
        );
      })}

      {preview && (
        <div
          className="border-accent bg-accent-soft/80 text-accent-strong pointer-events-none absolute inset-x-1 rounded-md border border-dashed px-1.5 py-1 text-[11px] font-medium"
          style={{
            top: (preview.start - startMin) * PX_PER_MIN,
            height: (preview.end - preview.start) * PX_PER_MIN,
          }}
        >
          <span className="tnum">
            {formatTime(new Date(2000, 0, 1, 0, preview.start))} –{' '}
            {formatTime(new Date(2000, 0, 1, 0, preview.end))}
          </span>
        </div>
      )}

      {isToday &&
        minuteOfDay(new Date(now)) >= startMin &&
        minuteOfDay(new Date(now)) <= endMin && (
          <div
            className="pointer-events-none absolute inset-x-0 z-10"
            style={{ top: (minuteOfDay(new Date(now)) - startMin) * PX_PER_MIN }}
          >
            <div className="bg-danger relative h-px">
              <span className="bg-danger absolute -top-[3.5px] -left-1 size-2 rounded-full" />
            </div>
          </div>
        )}
    </div>
  );
}
