import type { Device, PlannedRun, Schedule } from '@hoseidon/shared';
import {
  CalendarClock,
  CalendarPlus,
  Check,
  CircleAlert,
  Droplet,
  Droplets,
  Square,
  TriangleAlert,
  Waves,
} from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router';
import { QuickRun, useRemaining } from '../components/devices/device-controls';
import { Page, PageHeader } from '../components/layout/app-shell';
import { WeatherStrip } from '../components/weather-strip';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, SectionLabel } from '../components/ui/card';
import { CountdownRing } from '../components/ui/indicators';
import { EmptyState, ErrorBanner, Skeleton, Stat } from '../components/ui/misc';
import { addDays, startOfDay } from '../lib/calendar';
import { cn } from '../lib/cn';
import { formatDuration, formatRelative, formatTime, greeting } from '../lib/format';
import { ALARM_LABEL } from '../lib/linktap';
import {
  useGateways,
  usePlannedRuns,
  useSchedules,
  useSkipPlannedRun,
  useStopDevice,
} from '../lib/queries';
import { useNow } from '../lib/use-now';

const dateFmt = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
});

export function HomePage() {
  // Re-derive "today" each minute so the page rolls over at midnight.
  const now = useNow(60_000);
  const dayStart = useMemo(() => startOfDay(new Date(now)), [now]);
  const dayEnd = useMemo(() => addDays(dayStart, 1), [dayStart]);

  const gateways = useGateways();
  const planned = usePlannedRuns(dayStart, dayEnd);
  const schedules = useSchedules();

  const devices = useMemo(() => gateways.data?.flatMap((g) => g.devices) ?? [], [gateways.data]);
  const byId = useMemo(() => new Map(devices.map((d) => [d.id, d])), [devices]);
  const scheduleById = useMemo(
    () => new Map(schedules.data?.map((s) => [s.id, s]) ?? []),
    [schedules.data],
  );

  const running = devices.filter((d) => d.watering);
  const runs = planned.data ?? [];
  // Planned runs are sorted; a late one (waiting behind another zone) is still the next run.
  const next = runs.find((r) => r.status === 'planned');
  const doneSec = runs.filter((r) => r.status === 'done').reduce((s, r) => s + r.seconds, 0);
  const attention = devices.filter(
    (d) => d.alarms.length || !d.online || (d.batteryPct ?? 100) < 20,
  );

  return (
    <Page>
      <PageHeader title={greeting(new Date(now))} description={dateFmt.format(now)} />

      {gateways.isError && <ErrorBanner title="Couldn't load devices" error={gateways.error} />}
      {planned.isError && <ErrorBanner title="Couldn't load today's runs" error={planned.error} />}

      <Card className="mb-6 grid grid-cols-2 gap-x-4 gap-y-5 px-5 py-4 md:grid-cols-4 md:px-6 md:py-5">
        <Stat
          icon={Droplet}
          tone="accent"
          label="Watering now"
          value={gateways.isPending ? <Skeleton className="h-7 w-8" /> : running.length}
          hint={running.length ? running.map((d) => d.name).join(', ') : 'All quiet'}
        />
        <Stat
          icon={CalendarClock}
          label="Next run"
          value={next ? formatTime(next.plannedAt) : '—'}
          hint={
            next
              ? `${byId.get(next.deviceId)?.name ?? 'Zone'} · ${formatRelative(next.plannedAt, now)}`
              : 'Nothing else today'
          }
        />
        <Stat
          icon={Waves}
          label="Watered today"
          value={formatDuration(doneSec)}
          hint={`${runs.filter((r) => r.status === 'done').length} of ${runs.length} planned runs`}
        />
        <Stat
          icon={TriangleAlert}
          tone={attention.length ? 'warn' : undefined}
          label="Needs attention"
          value={attention.length}
          hint={
            attention.length ? attention.map((d) => d.name).join(', ') : 'Everything looks good'
          }
        />
      </Card>

      <WeatherStrip now={now} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-6">
          {running.length > 0 && (
            <section>
              <SectionLabel>Running now</SectionLabel>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                {running.map((d) => (
                  <RunningCard key={d.id} device={d} />
                ))}
              </div>
            </section>
          )}

          <section>
            <SectionLabel>Today</SectionLabel>
            <Card>
              {planned.isPending ? (
                <TimelineSkeleton />
              ) : planned.isError ? (
                <EmptyState icon={CircleAlert} title="Today's runs are unavailable" />
              ) : runs.length === 0 ? (
                <EmptyState
                  icon={CalendarPlus}
                  title="Nothing scheduled today"
                  description="Add a schedule and Hoseidon will run it, skip it when it rains, and log every drop."
                  action={
                    <Button asChild variant="primary" size="sm">
                      <Link to="/schedule">Plan a schedule</Link>
                    </Button>
                  }
                />
              ) : (
                <Timeline runs={runs} devices={byId} schedules={scheduleById} nextId={next?.id} />
              )}
            </Card>
          </section>
        </div>

        <aside className="space-y-6">
          <section>
            <SectionLabel>Quick run</SectionLabel>
            <Card>
              {gateways.isPending ? (
                <div className="space-y-3 p-4">
                  {[0, 1, 2].map((i) => (
                    <Skeleton key={i} className="h-8" />
                  ))}
                </div>
              ) : (
                <ul className="divide-line divide-y">
                  {devices
                    .filter((d) => d.online)
                    .map((d) => (
                      <li
                        key={d.id}
                        className="flex items-center justify-between gap-3 px-4 py-2.5"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">{d.name}</div>
                          {d.zone && <div className="text-subtle truncate text-xs">{d.zone}</div>}
                        </div>
                        <QuickRun device={d} />
                      </li>
                    ))}
                </ul>
              )}
            </Card>
          </section>

          {attention.length > 0 && (
            <section>
              <SectionLabel>Needs attention</SectionLabel>
              <Card>
                <ul className="divide-line divide-y">
                  {attention.map((d) => (
                    <li key={d.id}>
                      <Link
                        to="/devices"
                        className="hover:bg-surface-2 flex items-start gap-3 px-4 py-3 transition-colors"
                      >
                        <CircleAlert
                          className={cn(
                            'mt-0.5 size-4 shrink-0',
                            d.alarms.length || !d.online ? 'text-danger' : 'text-warn',
                          )}
                        />
                        <div className="min-w-0">
                          <div className="text-sm font-medium">{d.name}</div>
                          <div className="text-muted text-xs">{attentionText(d)}</div>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          )}
        </aside>
      </div>
    </Page>
  );
}

function attentionText(d: Device): string {
  const parts: string[] = [];
  if (!d.online)
    parts.push(d.lastSeenAt ? `Offline since ${formatRelative(d.lastSeenAt)}` : 'Offline');
  parts.push(...d.alarms.map((a) => ALARM_LABEL[a]));
  if (d.batteryPct !== null && d.batteryPct < 20)
    parts.push(`Battery ${Math.round(d.batteryPct)}%`);
  return parts.join(' · ');
}

function RunningCard({ device }: { device: Device }) {
  const stop = useStopDevice();
  const remaining = useRemaining(device);
  const total = device.watering?.totalSec ?? 0;
  const volume = device.watering?.volumeMl;
  return (
    <Card className="flex items-center gap-4 p-4">
      <CountdownRing remaining={remaining ?? 0} total={total} size={84} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-semibold tracking-tight">{device.name}</div>
        <div className="text-muted mt-0.5 text-xs">
          {formatDuration(total)} run
          {volume ? ` · ${(volume / 1000).toFixed(1)} L so far` : ''}
        </div>
        <Button
          size="sm"
          variant="danger"
          className="mt-3"
          loading={stop.isPending}
          onClick={() => stop.mutate(device)}
        >
          {!stop.isPending && <Square className="size-3 fill-current" />}
          Stop
        </Button>
      </div>
    </Card>
  );
}

const STATUS_BADGE: Record<
  PlannedRun['status'],
  { label: string; tone: 'ok' | 'accent' | 'neutral' | 'danger' | 'outline' }
> = {
  done: { label: 'Done', tone: 'ok' },
  running: { label: 'Running', tone: 'accent' },
  planned: { label: 'Planned', tone: 'outline' },
  skipped: { label: 'Skipped', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

function Timeline({
  runs,
  devices,
  schedules,
  nextId,
}: {
  runs: PlannedRun[];
  devices: Map<string, Device>;
  schedules: Map<number, Schedule>;
  nextId: number | undefined;
}) {
  const skip = useSkipPlannedRun();
  const cycles = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of runs) {
      const k = `${r.scheduleId}|${r.occurrenceAt}|${r.deviceId}`;
      m.set(k, Math.max(m.get(k) ?? 0, r.cycle));
    }
    return m;
  }, [runs]);

  return (
    <ol className="py-2">
      {runs.map((r, i) => {
        const device = devices.get(r.deviceId);
        const schedule = schedules.get(r.scheduleId);
        const totalCycles = cycles.get(`${r.scheduleId}|${r.occurrenceAt}|${r.deviceId}`) ?? 1;
        const isNext = r.id === nextId;
        const badge = isNext ? { label: 'Next', tone: 'accent' as const } : STATUS_BADGE[r.status];
        const muted = r.status === 'skipped' || r.status === 'cancelled';
        const last = i === runs.length - 1;
        return (
          <li key={r.id} className="group relative flex gap-3 px-4 md:px-5">
            <div className="tnum text-muted w-16 shrink-0 pt-3 text-right text-[13px]">
              {formatTime(r.startedAt ?? r.plannedAt)}
            </div>
            <div className="relative flex w-4 shrink-0 justify-center">
              {!last && <span className="bg-line absolute top-6 -bottom-3 w-px" />}
              <TimelineDot status={r.status} isNext={isNext} color={schedule?.color} />
            </div>
            <div className={cn('min-w-0 flex-1 py-2.5', !last && 'border-line border-b')}>
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'truncate text-sm font-medium',
                    muted && 'text-muted line-through decoration-line-strong',
                  )}
                >
                  {device?.name ?? r.deviceId}
                </span>
                <Badge tone={badge.tone} className="shrink-0">
                  {badge.label}
                </Badge>
                {r.status === 'planned' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto h-6 px-2 text-xs opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
                    onClick={() => skip.mutate(r.id)}
                  >
                    Skip
                  </Button>
                )}
              </div>
              <div className="text-muted mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs">
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="size-1.5 rounded-full"
                    style={{ background: schedule?.color ?? 'var(--app-subtle)' }}
                  />
                  {schedule?.name ?? 'Schedule'}
                </span>
                <span className="text-line-strong">·</span>
                <span>{formatDuration(r.seconds)}</span>
                {r.scale !== 1 && (
                  <span className="text-accent-strong">
                    ({Math.round(r.scale * 100)}% for weather)
                  </span>
                )}
                {totalCycles > 1 && (
                  <>
                    <span className="text-line-strong">·</span>
                    <span>
                      Cycle {r.cycle}/{totalCycles}
                    </span>
                  </>
                )}
              </div>
              {r.skipReason && r.status === 'skipped' && (
                <div className="text-muted mt-1 text-xs">Skipped — {r.skipReason}</div>
              )}
              {r.error && r.status === 'failed' && (
                <div className="text-danger mt-1 text-xs">{r.error}</div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function TimelineDot({
  status,
  isNext,
  color,
}: {
  status: PlannedRun['status'];
  isNext: boolean;
  color?: string;
}) {
  if (status === 'done')
    return (
      <span className="bg-ok text-surface relative mt-3.5 grid size-4 place-items-center rounded-full">
        <Check className="size-2.5" strokeWidth={3.5} />
      </span>
    );
  if (status === 'running')
    return (
      <span className="relative mt-3.5 grid size-4 place-items-center">
        <span className="bg-accent/40 animate-ripple absolute inset-0 rounded-full" />
        <Droplets className="text-accent-strong relative size-3.5" />
      </span>
    );
  if (status === 'failed')
    return (
      <span className="bg-danger relative mt-4 size-3 rounded-full ring-4 ring-[var(--app-surface)]" />
    );
  return (
    <span
      className={cn(
        'bg-surface relative mt-4 size-3 rounded-full border-2',
        status === 'planned' ? '' : 'border-line-strong',
        isNext && 'ring-accent-soft ring-4',
      )}
      style={status === 'planned' ? { borderColor: color ?? 'var(--app-accent)' } : undefined}
    />
  );
}

function TimelineSkeleton() {
  return (
    <div className="space-y-4 p-5">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-4">
          <Skeleton className="h-4 w-14" />
          <Skeleton className="size-3 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-24" />
          </div>
        </div>
      ))}
    </div>
  );
}
