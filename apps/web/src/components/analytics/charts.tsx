import { useMemo, type ReactNode } from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { cn } from '../../lib/cn';
import { parseDate, toDisplayUnits, type ChartRow } from '../../lib/analytics';
import { unitLabels, useUnits } from '../../lib/units';

/** Chart colors come from the design tokens, so they follow light/dark with the rest of the app. */
export const COLOR = {
  water: 'var(--app-accent)',
  rain: 'var(--app-rain)',
  et0: 'var(--app-et0)',
  grid: 'var(--app-line)',
  axis: 'var(--app-subtle)',
  cursor: 'var(--app-surface-3)',
} as const;

const dayFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const fullFmt = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});
export const shortDate = (s: string) => dayFmt.format(parseDate(s));
export const longDate = (s: string) => fullFmt.format(parseDate(s));

const tick = { fill: COLOR.axis, fontSize: 11 } as const;

interface TipItem {
  color: string;
  name: string;
  value: string;
}

/** Tooltip card in the app's own surface style. */
function Tip({
  active,
  payload,
  describe,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: unknown }>;
  describe: (row: ChartRow) => { title: string; items: TipItem[] };
}) {
  const row = payload?.[0]?.payload as ChartRow | undefined;
  if (!active || !row) return null;
  const { title, items } = describe(row);
  return (
    <div className="bg-surface border-line rounded-lg border px-3 py-2 text-xs shadow-md">
      <div className="text-muted mb-1 font-medium">{title}</div>
      {items.map((i) => (
        <div key={i.name} className="flex items-center gap-2 py-0.5">
          <span className="size-2 rounded-full" style={{ background: i.color }} />
          <span className="text-muted">{i.name}</span>
          <span className="tnum ml-auto pl-4 font-medium">{i.value}</span>
        </div>
      ))}
    </div>
  );
}

const rowTitle = (r: ChartRow) => (r.span > 1 ? `Week of ${shortDate(r.date)}` : longDate(r.date));

export function Legend({ items }: { items: { color: string; label: string; line?: boolean }[] }) {
  return (
    <ul className="text-muted flex flex-wrap gap-x-4 gap-y-1 text-xs">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span
            className={cn('inline-block', i.line ? 'h-0.5 w-3 rounded-full' : 'size-2 rounded-sm')}
            style={{ background: i.color }}
          />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

const Frame = ({ children, height = 240 }: { children: ReactNode; height?: number }) => (
  <div style={{ height }} className="w-full min-w-0 [&_svg]:overflow-visible">
    {children}
  </div>
);

/** Water used (bars, left) against rainfall (area) and ET0 (line) on the right axis. */
export function WaterWeatherChart({ rows: metricRows }: { rows: ChartRow[] }) {
  const [units] = useUnits();
  const u = unitLabels(units);
  const rows = useMemo(() => toDisplayUnits(metricRows, units), [metricRows, units]);
  const hasWeather = rows.some((r) => r.rainMm !== null || r.et0Mm !== null);
  return (
    <Frame>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 8, right: 0, bottom: 0, left: -12 }}>
          <CartesianGrid stroke={COLOR.grid} vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={shortDate}
            tick={tick}
            tickLine={false}
            axisLine={{ stroke: COLOR.grid }}
            minTickGap={28}
          />
          <YAxis
            yAxisId="l"
            tick={tick}
            tickLine={false}
            axisLine={false}
            width={44}
            unit={` ${u.volume}`}
            allowDecimals={false}
          />
          {hasWeather && (
            <YAxis
              yAxisId="r"
              orientation="right"
              tick={tick}
              tickLine={false}
              axisLine={false}
              width={44}
              unit={` ${u.depth}`}
              allowDecimals={false}
            />
          )}
          <Tooltip
            cursor={{ fill: COLOR.cursor, opacity: 0.6 }}
            content={(p) => (
              <Tip
                active={p.active}
                payload={p.payload}
                describe={(r) => ({
                  title: rowTitle(r),
                  items: [
                    { color: COLOR.water, name: 'Water used', value: `${r.liters} ${u.volume}` },
                    ...(r.rainMm !== null
                      ? [{ color: COLOR.rain, name: 'Rain', value: `${r.rainMm} ${u.depth}` }]
                      : []),
                    ...(r.et0Mm !== null
                      ? [{ color: COLOR.et0, name: 'ET₀', value: `${r.et0Mm} ${u.depth}` }]
                      : []),
                  ],
                })}
              />
            )}
          />
          <Bar
            yAxisId="l"
            dataKey="liters"
            fill={COLOR.water}
            radius={[3, 3, 0, 0]}
            maxBarSize={16}
            isAnimationActive={false}
          />
          {hasWeather && (
            <Bar
              yAxisId="r"
              dataKey="rainMm"
              fill={COLOR.rain}
              fillOpacity={0.75}
              radius={[3, 3, 0, 0]}
              maxBarSize={12}
              isAnimationActive={false}
            />
          )}
          {hasWeather && (
            <Line
              yAxisId="r"
              dataKey="et0Mm"
              type="monotone"
              stroke={COLOR.et0}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
              connectNulls
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </Frame>
  );
}

/** A single-series line, for run duration and flow rate. */
function TrendChart({
  rows,
  dataKey,
  unit,
  color,
  name,
  describe,
}: {
  rows: ChartRow[];
  dataKey: 'avgRunMin' | 'flowLMin';
  unit: string;
  color: string;
  name: string;
  describe: (r: ChartRow) => string;
}) {
  return (
    <Frame height={200}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid stroke={COLOR.grid} vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={shortDate}
            tick={tick}
            tickLine={false}
            axisLine={{ stroke: COLOR.grid }}
            minTickGap={36}
          />
          <YAxis
            tick={tick}
            tickLine={false}
            axisLine={false}
            width={unit.length > 3 ? 62 : 48}
            tickFormatter={(v: number) => `${v} ${unit}`}
            domain={[0, 'auto']}
          />
          <Tooltip
            cursor={{ stroke: COLOR.grid }}
            content={(p) => (
              <Tip
                active={p.active}
                payload={p.payload}
                describe={(r) => ({
                  title: rowTitle(r),
                  items: [{ color, name, value: describe(r) }],
                })}
              />
            )}
          />
          <Line
            dataKey={dataKey}
            type="monotone"
            stroke={color}
            strokeWidth={2}
            dot={rows.length <= 45 ? { r: 2.5, fill: color, strokeWidth: 0 } : false}
            activeDot={{ r: 4 }}
            connectNulls
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </Frame>
  );
}

export const DurationChart = ({ rows }: { rows: ChartRow[] }) => (
  <TrendChart
    rows={rows}
    dataKey="avgRunMin"
    unit="min"
    color={COLOR.water}
    name="Avg run"
    describe={(r) => (r.avgRunMin === null ? 'No runs' : `${r.avgRunMin} min (${r.runs} runs)`)}
  />
);

export function FlowChart({ rows }: { rows: ChartRow[] }) {
  const [units] = useUnits();
  const flow = unitLabels(units).flow;
  return (
    <TrendChart
      rows={useMemo(() => toDisplayUnits(rows, units), [rows, units])}
      dataKey="flowLMin"
      unit={flow}
      color={COLOR.rain}
      name="Flow"
      describe={(r) => (r.flowLMin === null ? 'No data' : `${r.flowLMin} ${flow}`)}
    />
  );
}
