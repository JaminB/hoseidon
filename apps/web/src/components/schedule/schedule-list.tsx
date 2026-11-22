import type { Schedule } from '@hoseidon/shared';
import { CloudRain, Repeat, Snowflake, Sun, TriangleAlert, Wind } from 'lucide-react';
import { describeRrule, fromLocalDateTime } from '../../lib/calendar';
import { cn } from '../../lib/cn';
import { formatDuration, formatRelative, formatTime } from '../../lib/format';
import { usePatchSchedule } from '../../lib/queries';
import { Badge } from '../ui/badge';
import { Card } from '../ui/card';
import { Switch } from '../ui/switch';

export function ScheduleList({
  schedules,
  zoneNames,
  onOpen,
}: {
  schedules: Schedule[];
  zoneNames: (id: string) => string;
  onOpen: (s: Schedule) => void;
}) {
  const patch = usePatchSchedule();
  return (
    <Card className="overflow-hidden">
      <ul className="divide-line divide-y">
        {schedules.map((s) => {
          const total = s.items.reduce((sum, i) => sum + i.seconds, 0);
          const rules = s.skipRules;
          return (
            <li
              key={s.id}
              className={cn('flex items-start gap-4 px-4 py-4 md:px-5', !s.enabled && 'opacity-60')}
            >
              <span
                className="mt-1 h-9 w-1 shrink-0 rounded-full"
                style={{ background: s.color }}
              />
              <button type="button" onClick={() => onOpen(s)} className="min-w-0 flex-1 text-left">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold tracking-tight">{s.name}</span>
                  {s.warnings.length > 0 && (
                    <Badge tone="warn" title={s.warnings.map((w) => w.message).join('\n')}>
                      <TriangleAlert className="size-3" />
                      {s.warnings.length === 1
                        ? warningLabel(s.warnings[0]!.kind)
                        : `${s.warnings.length} warnings`}
                    </Badge>
                  )}
                </div>
                <div className="text-muted mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[13px]">
                  <Repeat className="size-3" />
                  {describeRrule(s.rrule)} at {formatTime(fromLocalDateTime(s.dtstart))}
                  <span className="text-line-strong">·</span>
                  {formatDuration(total)}
                  {s.cycleSoak && (
                    <>
                      <span className="text-line-strong">·</span>
                      {s.cycleSoak.cycles} cycles, {s.cycleSoak.soakMinutes} min soak
                    </>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {s.items.map((i) => (
                    <Badge key={i.deviceId} tone="outline">
                      {zoneNames(i.deviceId)} · {formatDuration(i.seconds)}
                    </Badge>
                  ))}
                  {rules.rainForecastMm !== null && (
                    <Badge
                      tone="accent"
                      title={`Skips when more than ${rules.rainForecastMm} mm of rain is forecast`}
                    >
                      <CloudRain className="size-3" /> {rules.rainForecastMm} mm
                    </Badge>
                  )}
                  {rules.freezeC !== null && (
                    <Badge tone="accent" title={`Skips at or below ${rules.freezeC} °C`}>
                      <Snowflake className="size-3" /> {rules.freezeC}°
                    </Badge>
                  )}
                  {rules.windKph !== null && (
                    <Badge tone="accent" title={`Skips at or above ${rules.windKph} km/h wind`}>
                      <Wind className="size-3" /> {rules.windKph} km/h
                    </Badge>
                  )}
                  {rules.etScaling && (
                    <Badge tone="accent" title="Scales with evapotranspiration">
                      <Sun className="size-3" /> ET₀
                    </Badge>
                  )}
                </div>
              </button>
              <div className="flex shrink-0 flex-col items-end gap-2">
                <Switch
                  checked={s.enabled}
                  onCheckedChange={(enabled) => patch.mutate({ id: s.id, patch: { enabled } })}
                  label={`${s.name} enabled`}
                />
                <span className="text-subtle text-xs whitespace-nowrap">
                  {s.enabled ? (s.nextAt ? formatRelative(s.nextAt) : 'No more runs') : 'Paused'}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function warningLabel(kind: Schedule['warnings'][number]['kind']) {
  return {
    linktap_plan: 'LinkTap plan',
    offline_device: 'Zone offline',
    unknown_device: 'Unknown zone',
  }[kind];
}
