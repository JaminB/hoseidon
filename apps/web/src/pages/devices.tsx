import type { Device, GatewayWithDevices } from '@hoseidon/shared';
import { Droplet, MapPin, Pencil, Router, Stethoscope, TriangleAlert, X } from 'lucide-react';
import { useState } from 'react';
import { QuickRun } from '../components/devices/device-controls';
import { DeviceSheet } from '../components/devices/device-sheet';
import { DiagnoseSheet, type DiagnoseTarget } from '../components/network/diagnose-sheet';
import { GatewaySheet } from '../components/devices/gateway-sheet';
import { Page, PageHeader } from '../components/layout/app-shell';
import { Badge, Dot } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { BatteryIcon, SignalBars } from '../components/ui/indicators';
import { EmptyState, Skeleton } from '../components/ui/misc';
import { cn } from '../lib/cn';
import { formatRelative } from '../lib/format';
import { ALARM_LABEL, isDismissable, isLinkTapPlan, WORK_MODE_LABEL } from '../lib/linktap';
import { useDismissAlarm, useGateways } from '../lib/queries';
import { formatFlow } from '../lib/units';

export function DevicesPage() {
  const { data, isPending, isError, error } = useGateways();
  const [editing, setEditing] = useState<Device | null>(null);
  const [gateway, setGateway] = useState<GatewayWithDevices | null>(null);
  const [diagnosing, setDiagnosing] = useState<DiagnoseTarget | null>(null);

  const devices = data?.flatMap((g) => g.devices) ?? [];
  const attention = devices.filter((d) => d.alarms.length > 0 || !d.online).length;
  const conflicts = devices.filter((d) => isLinkTapPlan(d.workMode));

  return (
    <Page>
      <PageHeader
        title="Devices"
        description={
          data
            ? `${data.length} gateway${data.length === 1 ? '' : 's'} · ${devices.length} timer${devices.length === 1 ? '' : 's'}${attention ? ` · ${attention} need${attention === 1 ? 's' : ''} attention` : ''}`
            : 'Gateways and the timers paired to them'
        }
      />

      {conflicts.length > 0 && (
        <div className="border-warn/30 bg-warn-soft text-warn-strong mb-5 flex gap-3 rounded-xl border px-4 py-3 text-[13px]">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <p>
            <span className="font-medium">
              {conflicts.map((d) => d.name).join(', ')} {conflicts.length === 1 ? 'is' : 'are'}{' '}
              still running a LinkTap-app plan.
            </span>{' '}
            It will water on its own schedule as well as Hoseidon's. Switch the timer to Instant
            mode in the LinkTap app to avoid double watering.
          </p>
        </div>
      )}

      {isPending && <DevicesSkeleton />}
      {isError && (
        <Card>
          <EmptyState icon={Router} title="Couldn't load devices" description={error.message} />
        </Card>
      )}
      {data?.length === 0 && (
        <Card>
          <EmptyState
            icon={Router}
            title="No gateways yet"
            description="Hoseidon picks up your LinkTap gateways on the next poll (every 5 minutes)."
          />
        </Card>
      )}

      <div className="space-y-5">
        {data?.map((g) => (
          <GatewayCard
            key={g.id}
            gateway={g}
            onEditDevice={setEditing}
            onDiagnose={(dev) => setDiagnosing({ id: dev.id, name: dev.name })}
            onEditGateway={() => setGateway(g)}
          />
        ))}
      </div>

      <DeviceSheet device={editing} onClose={() => setEditing(null)} />
      <DiagnoseSheet target={diagnosing} onClose={() => setDiagnosing(null)} />
      <GatewaySheet
        gateway={gateway && (data?.find((g) => g.id === gateway.id) ?? gateway)}
        onClose={() => setGateway(null)}
      />
    </Page>
  );
}

function GatewayCard({
  gateway,
  onEditDevice,
  onDiagnose,
  onEditGateway,
}: {
  gateway: GatewayWithDevices;
  onEditDevice: (d: Device) => void;
  onDiagnose: (d: Device) => void;
  onEditGateway: () => void;
}) {
  const hasLocation = gateway.lat !== null && gateway.lon !== null;
  return (
    <Card className="overflow-hidden">
      <div className="border-line flex items-center gap-3 border-b px-4 py-3.5 md:px-5">
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
            <span className="text-line-strong">·</span>
            {gateway.devices.length} timer{gateway.devices.length === 1 ? '' : 's'}
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
        <Button
          size="sm"
          variant={hasLocation ? 'ghost' : 'soft'}
          onClick={onEditGateway}
          className="max-w-[45%]"
        >
          <MapPin className="size-3.5" />
          <span className="truncate">
            {hasLocation ? (gateway.timezone ?? 'Located') : 'Set location'}
            {hasLocation && (
              <span className="text-subtle font-normal">
                {' · '}
                {gateway.locationSource === 'manual' ? 'set manually' : 'from LinkTap'}
              </span>
            )}
          </span>
        </Button>
      </div>
      <ul className="divide-line divide-y">
        {gateway.devices.map((d) => (
          <DeviceRow
            key={d.id}
            device={d}
            onEdit={() => onEditDevice(d)}
            onDiagnose={() => onDiagnose(d)}
          />
        ))}
        {gateway.devices.length === 0 && (
          <li className="text-muted px-5 py-6 text-center text-sm">
            No timers paired to this gateway.
          </li>
        )}
      </ul>
    </Card>
  );
}

function DeviceRow({
  device,
  onEdit,
  onDiagnose,
}: {
  device: Device;
  onEdit: () => void;
  onDiagnose: () => void;
}) {
  const dismiss = useDismissAlarm();
  const watering = device.watering !== null;

  return (
    <li className={cn('group px-4 py-3.5 md:px-5', !device.online && 'bg-surface-2/50')}>
      <div className="flex items-center gap-3">
        <div
          className={cn(
            'relative grid size-9 shrink-0 place-items-center rounded-full',
            watering ? 'bg-accent-soft text-accent-strong' : 'bg-surface-2 text-subtle',
          )}
        >
          {watering && (
            <span className="bg-accent/30 animate-ripple absolute inset-0 rounded-full" />
          )}
          <Droplet className={cn('relative size-4', watering && 'fill-current')} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onEdit}
              className="hover:text-accent-strong truncate text-left text-sm font-medium transition-colors"
            >
              {device.name}
            </button>
            {device.outlet !== null && (
              <span className="text-subtle shrink-0 text-xs">Outlet {device.outlet}</span>
            )}
          </div>
          <div className="text-muted mt-0.5 flex items-center gap-1.5 text-xs">
            {statusLine(device).map((part, i) => (
              <span key={part.text} className="flex items-center gap-1.5">
                {i > 0 && <span className="text-line-strong">·</span>}
                <span className={part.className}>{part.text}</span>
              </span>
            ))}
          </div>
        </div>

        <div className="hidden items-center gap-4 sm:flex">
          <BatteryIcon pct={device.batteryPct} />
          <SignalBars pct={device.signalPct} />
        </div>

        <div className="hidden items-center gap-1 md:flex">
          <QuickRun device={device} />
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={onDiagnose}
            aria-label={`Diagnose ${device.name}`}
            title="Diagnose"
          >
            <Stethoscope className="size-3.5" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={onEdit}
            aria-label={`Edit ${device.name}`}
          >
            <Pencil className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Phone: stats + actions on a second line. */}
      <div className="mt-3 flex items-center justify-between gap-3 pl-12 md:hidden">
        <div className="flex items-center gap-3.5 sm:hidden">
          <BatteryIcon pct={device.batteryPct} />
          <SignalBars pct={device.signalPct} />
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={onDiagnose}
            aria-label={`Diagnose ${device.name}`}
          >
            <Stethoscope className="size-3.5" />
          </Button>
          <QuickRun device={device} />
        </div>
      </div>

      {device.alarms.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5 pl-12">
          {device.alarms.map((a) => (
            <Badge key={a} tone="danger" className="pr-1">
              <TriangleAlert className="size-3" />
              {ALARM_LABEL[a]}
              {isDismissable(a) ? (
                <button
                  type="button"
                  className="hover:bg-danger/15 ml-0.5 grid size-4 place-items-center rounded-full"
                  onClick={() => dismiss.mutate({ device, alarm: a })}
                  aria-label={`Dismiss ${ALARM_LABEL[a]} on ${device.name}`}
                  title="Dismiss"
                >
                  <X className="size-3" />
                </button>
              ) : (
                <span className="w-1" />
              )}
            </Badge>
          ))}
        </div>
      )}
    </li>
  );
}

/** "Front yard · Watering", "Offline · seen 2 h ago", "7-day plan"... */
function statusLine(d: Device): { text: string; className?: string }[] {
  if (!d.online) {
    const seen = d.lastSeenAt ? ` · seen ${formatRelative(d.lastSeenAt)}` : '';
    return [{ text: `Offline${seen}`, className: 'text-danger font-medium' }];
  }
  const parts: { text: string; className?: string }[] = [];
  if (d.zone) parts.push({ text: d.zone });
  if (d.watering) parts.push({ text: 'Watering', className: 'text-accent-strong font-medium' });
  // Only with a flow meter fitted, and only while it is actually flowing.
  if (d.watering && d.flowMeter !== false && (d.flowMlPerMin ?? 0) > 0)
    parts.push({ text: formatFlow(d.flowMlPerMin ?? 0) });
  if (d.workMode && isLinkTapPlan(d.workMode))
    parts.push({ text: WORK_MODE_LABEL[d.workMode], className: 'text-warn-strong font-medium' });
  if (parts.length === (d.zone ? 1 : 0)) parts.push({ text: 'Idle' });
  return parts;
}

function DevicesSkeleton() {
  return (
    <div className="space-y-5">
      {[3, 2].map((n, i) => (
        <Card key={i} className="overflow-hidden">
          <div className="border-line flex items-center gap-3 border-b px-5 py-4">
            <Skeleton className="size-9 rounded-lg" />
            <div className="space-y-1.5">
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-3 w-24" />
            </div>
          </div>
          {Array.from({ length: n }, (_, j) => (
            <div key={j} className="flex items-center gap-3 px-5 py-4">
              <Skeleton className="size-9 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-20" />
              </div>
              <Skeleton className="hidden h-8 w-28 md:block" />
            </div>
          ))}
        </Card>
      ))}
    </div>
  );
}
