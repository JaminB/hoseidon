import type { DeviceNetwork, GatewayNetwork } from '@hoseidon/shared';
import { Router, Stethoscope } from 'lucide-react';
import { cn } from '../../lib/cn';
import { formatRelative } from '../../lib/format';
import {
  batteryLabel,
  batteryTone,
  formatUptime,
  linkWidth,
  signalTone,
  TONE_VAR,
  uptimeTone,
} from '../../lib/network';
import { Badge, Dot } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { BatteryIcon } from '../ui/indicators';
import { Sparkline, UptimeAxis, UptimeBar } from './charts';

const ROW_H = 44;
const LINK_W = 56;

interface Props {
  gateway: GatewayNetwork;
  from: number;
  to: number;
  weakBelow: number;
  onDiagnose: (d: DeviceNetwork) => void;
}

const TEXT_TONE = {
  ok: 'text-ok',
  warn: 'text-warn-strong',
  danger: 'text-danger',
  muted: 'text-subtle',
} as const;

/** One gateway: its uptime, a topology of the timers it serves, and per-timer health. */
export function GatewayCard({ gateway, from, to, weakBelow, onDiagnose }: Props) {
  return (
    <Card className="overflow-hidden">
      <div className="border-line border-b px-4 py-4 md:px-5">
        <div className="flex items-center gap-3">
          <div className="bg-surface-2 border-line text-muted grid size-9 shrink-0 place-items-center rounded-lg border">
            <Router className="size-4.5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[15px] font-semibold tracking-tight">{gateway.name}</h2>
            <div className="text-muted mt-0.5 flex items-center gap-1.5 text-xs">
              <Dot tone={gateway.online ? 'ok' : 'danger'} />
              {gateway.online
                ? 'Online'
                : `Offline${gateway.lastSeenAt ? ` · seen ${formatRelative(gateway.lastSeenAt)}` : ''}`}
              {gateway.version && (
                <>
                  <span className="text-line-strong">·</span>
                  <span className="truncate font-mono text-[11px]" title="Gateway firmware">
                    {gateway.version}
                  </span>
                </>
              )}
            </div>
          </div>
          <div className="text-right">
            <div
              className={cn('tnum text-xl font-semibold', TEXT_TONE[uptimeTone(gateway.uptimePct)])}
            >
              {formatUptime(gateway.uptimePct)}
            </div>
            <div className="text-subtle text-xs">uptime</div>
          </div>
        </div>
        <UptimeBar segments={gateway.segments} from={from} to={to} className="mt-3.5" />
        <UptimeAxis from={from} to={to} />
      </div>

      {gateway.devices.length > 0 ? (
        <>
          <Topology gateway={gateway} weakBelow={weakBelow} />
          <ul className="divide-line border-line divide-y border-t">
            {gateway.devices.map((d) => (
              <DeviceHealth
                key={d.id}
                device={d}
                from={from}
                to={to}
                weakBelow={weakBelow}
                onDiagnose={() => onDiagnose(d)}
              />
            ))}
          </ul>
        </>
      ) : (
        <p className="text-muted px-5 py-6 text-center text-sm">
          No timers paired to this gateway.
        </p>
      )}
    </Card>
  );
}

/** Gateway on the left, timers on the right; line weight and colour show signal strength. */
function Topology({ gateway, weakBelow }: { gateway: GatewayNetwork; weakBelow: number }) {
  const n = gateway.devices.length;
  const height = n * ROW_H;
  const cy = height / 2;
  return (
    <div className="bg-surface-2/40 flex px-4 py-3 md:px-5" role="group" aria-label="Topology">
      <div className="flex shrink-0 items-center" style={{ height }}>
        <div
          className={cn(
            'bg-surface relative z-10 flex size-14 flex-col items-center justify-center gap-0.5 rounded-xl border text-[10px] font-medium shadow-xs',
            gateway.online ? 'border-line-strong text-fg' : 'border-danger/50 text-danger',
          )}
        >
          <Router className="size-4" />
          Gateway
        </div>
      </div>
      <svg
        width={LINK_W}
        height={height}
        viewBox={`0 0 ${LINK_W} ${height}`}
        className="shrink-0"
        aria-hidden
      >
        {gateway.devices.map((d, i) => {
          const ty = i * ROW_H + ROW_H / 2;
          const live = gateway.online && d.online;
          const tone = live ? signalTone(d.signal.latest, weakBelow) : 'muted';
          return (
            <path
              key={d.id}
              d={`M0 ${cy} C ${LINK_W / 2} ${cy}, ${LINK_W / 2} ${ty}, ${LINK_W} ${ty}`}
              fill="none"
              stroke={TONE_VAR[tone]}
              strokeWidth={live ? linkWidth(d.signal.latest) : 1.5}
              strokeLinecap="round"
              strokeDasharray={live ? undefined : '3 5'}
              strokeOpacity={live ? 0.9 : 0.6}
            />
          );
        })}
      </svg>
      <ul className="min-w-0 flex-1">
        {gateway.devices.map((d) => {
          const live = gateway.online && d.online;
          const tone = live ? signalTone(d.signal.latest, weakBelow) : 'muted';
          return (
            <li key={d.id} className="flex items-center gap-2" style={{ height: ROW_H }}>
              <div className="bg-surface border-line flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2.5 py-1.5 shadow-xs">
                <Dot tone={live ? 'ok' : 'danger'} />
                <span className="truncate text-[13px] font-medium">{d.name}</span>
                <span className={cn('tnum ml-auto shrink-0 text-xs font-medium', TEXT_TONE[tone])}>
                  {live && d.signal.latest !== null ? `${Math.round(d.signal.latest)}%` : 'offline'}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function DeviceHealth({
  device: d,
  from,
  to,
  weakBelow,
  onDiagnose,
}: {
  device: DeviceNetwork;
  from: number;
  to: number;
  weakBelow: number;
  onDiagnose: () => void;
}) {
  const sTone = signalTone(d.signal.latest, weakBelow);
  const bTone = batteryTone(d.battery);
  // With under two samples the charts say nothing; show one summary row instead.
  const sparse = d.signal.series.length < 2 && d.battery.series.length < 2;
  if (sparse) {
    return (
      <li className="flex items-center gap-3 px-4 py-3 md:px-5">
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium">{d.name}</h3>
        <span className="tnum text-muted flex shrink-0 gap-3 text-xs">
          <span className={TEXT_TONE[sTone]}>
            {d.signal.latest === null ? 'Signal —' : `Signal ${Math.round(d.signal.latest)}%`}
          </span>
          <span className={TEXT_TONE[bTone]}>
            {d.battery.latest === null ? 'Battery —' : `Battery ${Math.round(d.battery.latest)}%`}
          </span>
          <span className={TEXT_TONE[uptimeTone(d.uptimePct)]}>{formatUptime(d.uptimePct)} up</span>
        </span>
        <Button size="sm" variant="ghost" onClick={onDiagnose} aria-label={`Diagnose ${d.name}`}>
          <Stethoscope className="size-3.5" />
        </Button>
      </li>
    );
  }
  return (
    <li className="px-4 py-3.5 md:px-5">
      <div className="flex items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium">{d.name}</h3>
        {d.signal.weakEpisodes > 0 && (
          <Badge tone="warn">
            {d.signal.weakEpisodes} weak spell{d.signal.weakEpisodes === 1 ? '' : 's'}
          </Badge>
        )}
        {d.signal.drops > 0 && (
          <Badge tone="danger">
            {d.signal.drops} drop{d.signal.drops === 1 ? '' : 's'}
          </Badge>
        )}
        <Button size="sm" variant="ghost" onClick={onDiagnose} aria-label={`Diagnose ${d.name}`}>
          <Stethoscope className="size-3.5" />
          <span className="hidden sm:inline">Diagnose</span>
        </Button>
      </div>

      <div className="mt-3 grid gap-x-6 gap-y-4 sm:grid-cols-3">
        <Metric
          label="Signal"
          value={d.signal.latest === null ? '—' : `${Math.round(d.signal.latest)}%`}
          tone={sTone}
          hint={
            d.signal.avg === null
              ? 'No readings'
              : `avg ${Math.round(d.signal.avg)}% · low ${Math.round(d.signal.min ?? 0)}%`
          }
        >
          <Sparkline
            series={d.signal.series}
            tone={sTone === 'muted' ? 'ok' : sTone}
            threshold={weakBelow}
            label={`Signal history for ${d.name}`}
            className="w-full"
            width={180}
          />
        </Metric>
        <Metric
          label="Battery"
          value={<BatteryIcon pct={d.battery.latest} />}
          tone={bTone}
          hint={batteryLabel(d.battery)}
        >
          <Sparkline
            series={d.battery.series}
            tone={bTone === 'muted' ? 'ok' : bTone}
            label={`Battery history for ${d.name}`}
            className="w-full"
            width={180}
          />
        </Metric>
        <Metric label="Uptime" value={formatUptime(d.uptimePct)} tone={uptimeTone(d.uptimePct)}>
          <div className="pt-3">
            <UptimeBar segments={d.segments} from={from} to={to} />
          </div>
        </Metric>
      </div>
    </li>
  );
}

function Metric({
  label,
  value,
  hint,
  tone,
  children,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone: keyof typeof TEXT_TONE;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-subtle text-xs">{label}</span>
        <span className={cn('tnum text-[15px] font-semibold', TEXT_TONE[tone])}>{value}</span>
      </div>
      <div className="mt-1.5">{children}</div>
      {hint && <div className="text-muted mt-1 truncate text-xs">{hint}</div>}
    </div>
  );
}
