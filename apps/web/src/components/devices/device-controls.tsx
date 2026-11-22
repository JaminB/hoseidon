import type { Device } from '@hoseidon/shared';
import { Square } from 'lucide-react';
import { cn } from '../../lib/cn';
import { formatClock } from '../../lib/format';
import { useGateways, useRunDevice, useStopDevice } from '../../lib/queries';
import { useNow } from '../../lib/use-now';
import { Button } from '../ui/button';

export const QUICK_MINUTES = [5, 10, 15] as const;

/** "Run 5 / 10 / 15 min" chips, or a Stop button with the time left while watering. */
export function QuickRun({ device, className }: { device: Device; className?: string }) {
  const run = useRunDevice();
  const stop = useStopDevice();
  const pending = run.isPending && run.variables?.device.id === device.id;

  if (device.watering) {
    return (
      <Button
        size="sm"
        variant="soft"
        className={cn('tnum min-w-26', className)}
        loading={stop.isPending && stop.variables?.id === device.id}
        onClick={() => stop.mutate(device)}
        aria-label={`Stop ${device.name}`}
      >
        <Square className="size-3 fill-current" />
        <Remaining device={device} />
      </Button>
    );
  }

  return (
    <div
      className={cn(
        'border-line bg-surface inline-flex h-8 items-center rounded-md border shadow-xs',
        className,
      )}
      role="group"
      aria-label={`Run ${device.name}`}
    >
      {QUICK_MINUTES.map((m, i) => (
        <button
          key={m}
          type="button"
          disabled={!device.online || pending}
          onClick={() => run.mutate({ device, seconds: m * 60 })}
          className={cn(
            'tnum hover:bg-surface-2 hover:text-fg text-muted h-full px-2.5 text-[13px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-40',
            i > 0 && 'border-line border-l',
            i === 0 && 'rounded-l-md',
            i === QUICK_MINUTES.length - 1 && 'rounded-r-md',
          )}
          title={`Water ${device.name} for ${m} minutes`}
        >
          {m}
          <span className="text-subtle ml-0.5 text-[11px]">m</span>
        </button>
      ))}
    </div>
  );
}

function Remaining({ device }: { device: Device }) {
  const left = useRemaining(device);
  return <span>{left === null ? 'Stop' : formatClock(left)}</span>;
}

/** Seconds left on the current run, ticking locally between polls. */
export function useRemaining(device: Device): number | null {
  const now = useNow(1000);
  // remainingSec was true when the gateway tree was last fetched (or optimistically written).
  const fetchedAt = useGateways().dataUpdatedAt || now;
  const w = device.watering;
  if (!w || w.remainingSec === null) return null;
  return Math.max(0, w.remainingSec - (now - fetchedAt) / 1000);
}
