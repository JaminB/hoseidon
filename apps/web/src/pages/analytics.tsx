import type { Analytics, SkipReasonKind } from '@hoseidon/shared';
import { WEATHER_ATTRIBUTION } from '@hoseidon/shared';
import { ChartColumn, Droplet, Gauge, Leaf, MapPin, Timer } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
  DurationChart,
  FlowChart,
  Legend,
  WaterWeatherChart,
  COLOR,
} from '../components/analytics/charts';
import { Heatmap } from '../components/analytics/heatmap';
import { Page, PageHeader } from '../components/layout/app-shell';
import { Card, CardHeader } from '../components/ui/card';
import { EmptyState, ErrorBanner, inputClass, Skeleton, Stat } from '../components/ui/misc';
import { Segmented } from '../components/ui/tabs';
import {
  buildChartRows,
  formatDepth,
  formatFlow,
  formatVolume,
  RANGES,
  rangeDates,
  SKIP_LABEL,
  type RangeKey,
} from '../lib/analytics';
import { cn } from '../lib/cn';
import { formatDuration } from '../lib/format';
import { useUnits } from '../lib/units';
import { useAnalytics, useGateways, useWeather } from '../lib/queries';

const SKIP_COLOR: Record<SkipReasonKind, string> = {
  rain: 'var(--app-rain)',
  freeze: 'var(--app-accent)',
  wind: 'var(--app-et0)',
  manual: 'var(--app-subtle)',
  missed: 'var(--app-danger)',
  other: 'var(--app-line-strong)',
};

export function AnalyticsPage() {
  const [units] = useUnits();
  const [target, setTarget] = useState('all');
  const [range, setRange] = useState<RangeKey>('30d');
  const { from, to } = useMemo(() => rangeDates(range), [range]);

  const gateways = useGateways();
  const devices = useMemo(() => gateways.data?.flatMap((g) => g.devices) ?? [], [gateways.data]);
  // Weather is per gateway: the chosen timer's, or the first located one for "all timers".
  const weatherGateway = useMemo(() => {
    const list = gateways.data ?? [];
    const own = list.find((g) => g.devices.some((d) => d.id === target));
    return own ?? list.find((g) => g.lat !== null && g.lon !== null);
  }, [gateways.data, target]);
  const located = weatherGateway?.lat != null && weatherGateway.lon != null;

  const analytics = useAnalytics(target, from, to);
  const weather = useWeather(located ? weatherGateway?.id : undefined, from, to);
  const a = analytics.data;

  const rows = useMemo(
    () => (a ? buildChartRows(a.days, weather.data?.days ?? []) : []),
    [a, weather.data],
  );
  const heat = useMemo(
    () =>
      a?.days.map((d) => ({
        date: d.date,
        value: a.hasFlow ? d.volumeMl / 1000 : d.durationSec / 60,
      })) ?? [],
    [a],
  );
  const rainTotal = rows.reduce((s, r) => s + (r.rainMm ?? 0), 0);
  const weatherDays = weather.data?.days.length ?? 0;

  return (
    <Page>
      <PageHeader
        title="Analytics"
        description="Water use against rain and evapotranspiration."
        actions={
          <div className="flex flex-wrap items-center gap-2 md:flex-nowrap">
            <select
              aria-label="Timer"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className={cn(inputClass, 'w-auto max-w-[220px] pr-8')}
            >
              <option value="all">All timers</option>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <Segmented
              label="Range"
              value={range}
              onChange={setRange}
              options={RANGES.map((r) => ({ value: r.value, label: r.label }))}
            />
          </div>
        }
      />

      {analytics.isError && <ErrorBanner title="Couldn't load analytics" error={analytics.error} />}

      <Card className="mb-6 grid grid-cols-2 gap-x-4 gap-y-5 px-5 py-4 md:grid-cols-4 md:px-6 md:py-5">
        <Tile
          pending={!a}
          icon={Droplet}
          tone="accent"
          label="Water used"
          value={a && formatVolume(a.totals.volumeMl)}
          hint={a && `${a.totals.runs} runs`}
        />
        <Tile
          pending={!a}
          icon={Timer}
          label="Time watering"
          value={a && formatDuration(a.totals.durationSec)}
          hint={
            a && a.totals.runs
              ? `${formatDuration(a.totals.durationSec / a.totals.runs)} per run`
              : 'No runs yet'
          }
        />
        <Tile
          pending={!a}
          icon={Gauge}
          label="Avg flow"
          value={a && (a.hasFlow ? formatFlow(a.totals.avgFlowMlMin ?? 0) : '—')}
          hint={a && (a.hasFlow ? 'Across runs with a flow meter' : 'Needs a G2 flow meter')}
        />
        <Tile
          pending={!a}
          icon={Leaf}
          tone="accent"
          label="Water saved"
          value={a && savedValue(a)}
          hint={
            a &&
            (a.saved.seconds > 0
              ? `${a.saved.skippedRuns} weather skips + ET₀ scaling · estimate`
              : 'No weather skips yet')
          }
        />
      </Card>

      {a && a.totals.runs === 0 && a.totals.skipped === 0 ? (
        <Card>
          <EmptyState
            icon={ChartColumn}
            title="No watering in this range"
            description="Once timers run, usage shows up here next to the weather. Try a longer range."
          />
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card className="lg:col-span-2">
            <CardHeader
              title="Water used vs. rain and ET₀"
              description={
                located
                  ? `${weatherGateway?.name}${rainTotal ? ` · ${formatDepth(rainTotal)} of rain in this range` : ''}`
                  : 'Add a gateway location to overlay rainfall and evapotranspiration.'
              }
              actions={
                !located && (
                  <Link
                    to="/devices"
                    className="text-accent-strong inline-flex items-center gap-1 text-[13px] font-medium hover:underline"
                  >
                    <MapPin className="size-3.5" /> Set location
                  </Link>
                )
              }
            />
            <div className="px-3 pb-4 md:px-5">
              {!a ? <Skeleton className="h-60" /> : <WaterWeatherChart rows={rows} />}
              <div className="mt-3 px-2">
                <Legend
                  items={[
                    { color: COLOR.water, label: 'Water used' },
                    ...(weatherDays
                      ? [
                          { color: COLOR.rain, label: 'Rain' },
                          { color: COLOR.et0, label: 'ET₀ (plant water demand)', line: true },
                        ]
                      : []),
                  ]}
                />
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Run duration" description="Average minutes per run" />
            <div className="px-3 pb-4 md:px-5">
              {!a ? <Skeleton className="h-48" /> : <DurationChart rows={rows} />}
            </div>
          </Card>

          {!a || a.hasFlow ? (
            <Card>
              <CardHeader
                title="Flow rate"
                description={`${units === 'imperial' ? 'Gallons' : 'Liters'} per minute, from the timer's flow meter`}
              />
              <div className="px-3 pb-4 md:px-5">
                {!a ? <Skeleton className="h-48" /> : <FlowChart rows={rows} />}
              </div>
            </Card>
          ) : null}

          <Card>
            <CardHeader
              title="Calendar"
              description={
                a?.hasFlow
                  ? `${units === 'imperial' ? 'Gallons' : 'Liters'} per day`
                  : 'Minutes watered per day'
              }
            />
            <div className="px-5 pb-5">
              {!a ? (
                <Skeleton className="h-28" />
              ) : (
                <Heatmap
                  days={heat}
                  label="Watering per day"
                  format={(v) =>
                    a.hasFlow ? `${Math.round(v * 10) / 10} L` : formatDuration(v * 60)
                  }
                />
              )}
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Why runs were skipped"
              description="Cycles that didn't run in this range"
            />
            <div className="px-5 pb-5">
              {!a ? <Skeleton className="h-28" /> : <SkipBreakdown a={a} />}
            </div>
          </Card>
        </div>
      )}

      <p className="text-subtle mt-6 text-center text-xs">
        <a
          href="https://open-meteo.com/"
          target="_blank"
          rel="noreferrer"
          className="hover:text-muted underline-offset-2 hover:underline"
        >
          {WEATHER_ATTRIBUTION}
        </a>
      </p>
    </Page>
  );
}

function savedValue(a: Analytics): string {
  if (a.saved.seconds <= 0) return '—';
  return a.saved.volumeMl !== null
    ? formatVolume(a.saved.volumeMl)
    : formatDuration(a.saved.seconds);
}

function Tile({
  pending,
  value,
  hint,
  ...rest
}: {
  pending: boolean;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon: React.ComponentProps<typeof Stat>['icon'];
  tone?: 'accent';
  label: string;
}) {
  return (
    <Stat
      {...rest}
      value={pending ? <Skeleton className="h-7 w-16" /> : value}
      hint={pending ? undefined : hint}
    />
  );
}

function SkipBreakdown({ a }: { a: Analytics }) {
  const max = Math.max(1, ...a.skipReasons.map((s) => s.count));
  if (!a.skipReasons.length)
    return (
      <p className="text-muted py-6 text-center text-sm">
        Nothing skipped. Every planned cycle ran.
      </p>
    );
  return (
    <ul className="space-y-3">
      {a.skipReasons.map((s) => (
        <li key={s.kind}>
          <div className="mb-1 flex items-baseline justify-between text-[13px]">
            <span>{SKIP_LABEL[s.kind]}</span>
            <span className="tnum text-muted">{s.count}</span>
          </div>
          <div className="bg-surface-3 h-2 overflow-hidden rounded-full">
            <div
              className="h-full rounded-full"
              style={{ width: `${(s.count / max) * 100}%`, background: SKIP_COLOR[s.kind] }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
