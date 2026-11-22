import type { ApiHealth, Incident, NetworkOverview } from '@hoseidon/shared';
import { Activity, Info, Radio, ShieldCheck, SignalLow, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Page, PageHeader } from '../components/layout/app-shell';
import { DiagnoseSheet, type DiagnoseTarget } from '../components/network/diagnose-sheet';
import { GatewayCard } from '../components/network/gateway-card';
import { Badge, Dot } from '../components/ui/badge';
import { Card, CardHeader } from '../components/ui/card';
import { EmptyState, ErrorBanner, Skeleton, Stat } from '../components/ui/misc';
import { Segmented } from '../components/ui/tabs';
import { cn } from '../lib/cn';
import { formatDuration, formatRelative } from '../lib/format';
import { formatOutage, formatUptime, incidentSummary, NETWORK_WINDOWS } from '../lib/network';
import { useNetwork, useSetWeakSignal } from '../lib/queries';

const when = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export function NetworkPage() {
  const [days, setDays] = useState('7');
  const [diagnosing, setDiagnosing] = useState<DiagnoseTarget | null>(null);
  const { data, error, isPending } = useNetwork(Number(days));

  return (
    <Page>
      <PageHeader
        title="Network"
        description="Gateway uptime, timer signal and battery over time."
        actions={
          <Segmented
            value={days}
            onChange={setDays}
            options={NETWORK_WINDOWS.map((w) => ({ value: w.value, label: w.label }))}
            label="Time window"
          />
        }
      />

      {error && !data && <ErrorBanner title="Couldn't load network health" error={error} />}
      {isPending && <NetworkSkeleton />}
      {data && data.gateways.length === 0 && (
        <Card>
          <EmptyState
            icon={Radio}
            title="No gateways yet"
            description="Once Hoseidon has polled LinkTap, your gateways and timers show up here."
          />
        </Card>
      )}
      {data && data.gateways.length > 0 && (
        <NetworkBody data={data} onDiagnose={(d) => setDiagnosing({ id: d.id, name: d.name })} />
      )}
      <DiagnoseSheet target={diagnosing} onClose={() => setDiagnosing(null)} />
    </Page>
  );
}

function NetworkBody({
  data,
  onDiagnose,
}: {
  data: NetworkOverview;
  onDiagnose: (d: { id: string; name: string }) => void;
}) {
  const from = new Date(data.from).getTime();
  const to = new Date(data.to).getTime();
  const devices = useMemo(() => data.gateways.flatMap((g) => g.devices), [data.gateways]);
  const gatewaysUp = data.gateways.filter((g) => g.online).length;
  const weak = devices.filter(
    (d) => d.online && d.signal.latest !== null && d.signal.latest < data.weakSignalPct,
  ).length;
  const open = data.incidents.filter((i) => i.ongoing).length;
  const known = data.gateways.flatMap((g) => (g.uptimePct === null ? [] : [g.uptimePct]));
  const avgUptime = known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;

  return (
    <div className="space-y-6">
      <Card className="grid grid-cols-2 gap-x-6 gap-y-5 p-5 md:grid-cols-4">
        <Stat
          label="Gateways online"
          value={`${gatewaysUp}/${data.gateways.length}`}
          icon={Radio}
          tone={gatewaysUp < data.gateways.length ? 'danger' : undefined}
          hint={`${formatUptime(avgUptime)} average uptime`}
        />
        <Stat
          label="Weak signal"
          value={weak}
          icon={SignalLow}
          tone={weak ? 'warn' : undefined}
          hint={`below ${data.weakSignalPct}%`}
        />
        <Stat
          label="Open incidents"
          value={open}
          icon={TriangleAlert}
          tone={open ? 'danger' : undefined}
          hint={`${data.incidents.length} in the last ${data.windowDays} d`}
        />
        <Stat
          label="Data"
          value={data.freshness.stale ? 'Stale' : 'Fresh'}
          icon={Activity}
          tone={data.freshness.stale ? 'warn' : 'accent'}
          hint={
            data.freshness.lastPollAt
              ? `updated ${formatRelative(data.freshness.lastPollAt)}`
              : 'never polled'
          }
        />
      </Card>

      {data.gateways.map((g) => (
        <GatewayCard
          key={g.id}
          gateway={g}
          from={from}
          to={to}
          weakBelow={data.weakSignalPct}
          onDiagnose={onDiagnose}
        />
      ))}

      <div className="grid gap-6 lg:grid-cols-2">
        <IncidentLog incidents={data.incidents} windowDays={data.windowDays} windowStart={from} />
        <div className="space-y-6">
          <ApiHealthCard health={data.apiHealth} />
          <ThresholdCard pct={data.weakSignalPct} />
        </div>
      </div>

      <p className="text-subtle flex items-start gap-2 px-1 text-xs">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        <span>
          LinkTap does not expose range extenders or the mesh between devices, so every timer is
          drawn straight to its gateway. If a link looks weak, an extender may still be in the path.
        </span>
      </p>
    </div>
  );
}

function IncidentLog({
  incidents,
  windowDays,
  windowStart,
}: {
  incidents: Incident[];
  windowDays: number;
  windowStart: number;
}) {
  return (
    <Card>
      <CardHeader
        title="Offline incidents"
        description={`Gateways and timers that dropped off, last ${windowDays} day${windowDays === 1 ? '' : 's'}.`}
      />
      {incidents.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="No outages"
          description="Nothing went offline in this window."
          className="pb-8"
        />
      ) : (
        <ul className="divide-line divide-y">
          {incidents.map((i) => (
            <li key={i.id} className="flex gap-3 px-5 py-3">
              <span className="pt-1.5">
                <Dot tone={i.ongoing ? 'danger' : 'muted'} pulse={i.ongoing} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-sm font-medium">{i.name}</span>
                  <Badge tone="outline">{i.scope === 'gateway' ? 'Gateway' : 'Timer'}</Badge>
                  {i.ongoing && <Badge tone="danger">Ongoing</Badge>}
                </div>
                <p className="text-muted mt-0.5 text-xs">
                  {new Date(i.start).getTime() <= windowStart
                    ? 'Offline since before this window'
                    : `${when.format(new Date(i.start))} · ${formatOutage(i.durationSec)}${i.ongoing ? ' so far' : ''}`}
                </p>
                <p className="text-subtle text-xs">{incidentSummary(i)}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ApiHealthCard({ health }: { health: ApiHealth }) {
  return (
    <Card>
      <CardHeader
        title="LinkTap API health"
        description={`Since the server started ${formatRelative(health.since)}.`}
        actions={health.mock ? <Badge tone="accent">Mock</Badge> : undefined}
      />
      {health.endpoints.length === 0 ? (
        <p className="text-muted px-5 pb-5 text-sm">No calls yet.</p>
      ) : (
        <div className="overflow-x-auto px-5 pb-4">
          <table className="w-full text-left text-[13px]">
            <thead className="text-subtle text-xs">
              <tr>
                <th className="pb-2 font-medium">Endpoint</th>
                <th className="pb-2 font-medium">Last OK</th>
                <th className="pb-2 text-right font-medium">Errors</th>
                <th className="pb-2 text-right font-medium">Queue wait</th>
              </tr>
            </thead>
            <tbody className="divide-line divide-y">
              {health.endpoints.map((e) => (
                <tr key={e.endpoint} title={e.lastError ?? undefined}>
                  <td className="py-2 pr-3 font-mono text-xs">{e.endpoint}</td>
                  <td className="text-muted py-2 pr-3 whitespace-nowrap">
                    {e.lastOkAt ? formatRelative(e.lastOkAt) : '—'}
                  </td>
                  <td
                    className={cn(
                      'tnum py-2 pr-3 text-right whitespace-nowrap',
                      (e.errorRatePct ?? 0) > 20 ? 'text-danger' : 'text-muted',
                    )}
                  >
                    {e.errors}/{e.calls}
                    {e.errorRatePct !== null && e.errorRatePct > 0 ? ` · ${e.errorRatePct}%` : ''}
                  </td>
                  <td className="tnum text-muted py-2 text-right whitespace-nowrap">
                    {e.avgWaitMs < 1000 ? `${e.avgWaitMs} ms` : formatDuration(e.avgWaitMs / 1000)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {health.endpoints.some((e) => e.lastError) && (
        <p className="text-danger border-line border-t px-5 py-3 text-xs">
          Latest error:{' '}
          {
            [...health.endpoints]
              .filter((e) => e.lastErrorAt)
              .sort((a, b) => (b.lastErrorAt ?? '').localeCompare(a.lastErrorAt ?? ''))[0]
              ?.lastError
          }
        </p>
      )}
      <p className="text-subtle border-line border-t px-5 py-3 text-xs">
        Next device refresh allowed {formatRelative(health.nextAvailableAt.devices)}. Queue wait is
        time spent holding back for LinkTap&apos;s rate limits.
      </p>
    </Card>
  );
}

/** The weak-signal threshold. Saved when you let go of the slider. */
function ThresholdCard({ pct }: { pct: number }) {
  // While dragging we show the draft; once saved the server value takes over again.
  const [draft, setDraft] = useState<number | null>(null);
  const value = draft ?? pct;
  const save = useSetWeakSignal();
  const commit = () => {
    if (draft !== null && draft !== pct) save.mutate(draft, { onSettled: () => setDraft(null) });
    else setDraft(null);
  };

  return (
    <Card>
      <CardHeader
        title="Weak-signal threshold"
        description="Timers below this are flagged, and you get an event when one drops under it."
      />
      <div className="flex items-center gap-4 px-5 pb-5">
        <input
          type="range"
          min={10}
          max={90}
          step={5}
          value={value}
          onChange={(e) => setDraft(Number(e.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
          className="accent-accent h-2 flex-1"
          aria-label="Weak-signal threshold"
        />
        <span className="tnum w-12 text-right text-sm font-semibold">{value}%</span>
      </div>
    </Card>
  );
}

function NetworkSkeleton() {
  return (
    <div className="space-y-6" aria-busy>
      <Skeleton className="h-28" />
      <Skeleton className="h-72" />
      <Skeleton className="h-48" />
    </div>
  );
}
