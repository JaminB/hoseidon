import type { CheckStatus, Diagnosis } from '@hoseidon/shared';
import { CircleAlert, CircleCheck, CircleHelp, RefreshCw, TriangleAlert } from 'lucide-react';
import { useEffect } from 'react';
import { cn } from '../../lib/cn';
import { useDiagnose } from '../../lib/queries';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { ErrorBanner, Skeleton } from '../ui/misc';
import { Sheet } from '../ui/sheet';

export interface DiagnoseTarget {
  id: string;
  name: string;
}

const ICON = {
  pass: { icon: CircleCheck, className: 'text-ok' },
  warn: { icon: TriangleAlert, className: 'text-warn-strong' },
  fail: { icon: CircleAlert, className: 'text-danger' },
  unknown: { icon: CircleHelp, className: 'text-subtle' },
} as const satisfies Record<CheckStatus, { icon: unknown; className: string }>;

const VERDICT = {
  ok: { tone: 'ok', label: 'All clear' },
  warn: { tone: 'warn', label: 'Worth a look' },
  fail: { tone: 'danger', label: 'Needs attention' },
} as const;

/** Runs the checklist when it opens, and shows each check with a plain-English fix. */
export function DiagnoseSheet({
  target,
  onClose,
}: {
  target: DiagnoseTarget | null;
  onClose: () => void;
}) {
  return (
    <Sheet
      open={target !== null}
      onOpenChange={(o) => !o && onClose()}
      title={target ? `Diagnose ${target.name}` : 'Diagnose'}
      description="Checks the gateway, signal, battery, alarms, plans and recent runs."
      wide
    >
      {target && <DiagnoseBody key={target.id} target={target} />}
    </Sheet>
  );
}

function DiagnoseBody({ target }: { target: DiagnoseTarget }) {
  const { mutate, data, isPending, error, reset } = useDiagnose();
  useEffect(() => {
    mutate(target.id);
    return reset;
  }, [mutate, reset, target.id]);

  return (
    <div className="space-y-4">
      {error && <ErrorBanner title="Couldn't run the checks" error={error} />}
      {isPending && (
        <div className="space-y-3" aria-busy>
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      )}
      {data && <Result diagnosis={data} />}
      <Button
        variant="secondary"
        size="sm"
        loading={isPending}
        onClick={() => mutate(target.id)}
        className="w-full"
      >
        {!isPending && <RefreshCw className="size-3.5" />}
        Run again
      </Button>
    </div>
  );
}

function Result({ diagnosis }: { diagnosis: Diagnosis }) {
  const v = VERDICT[diagnosis.verdict];
  // Problems first; the rest keep the checklist's own order.
  const order: Record<CheckStatus, number> = { fail: 0, warn: 1, unknown: 2, pass: 3 };
  const checks = [...diagnosis.checks].sort((a, b) => order[a.status] - order[b.status]);
  return (
    <>
      <div className="bg-surface-2 border-line rounded-xl border p-3.5">
        <Badge tone={v.tone}>{v.label}</Badge>
        <p className="mt-2 text-sm">{diagnosis.summary}</p>
      </div>
      <ul className="divide-line border-line bg-surface divide-y rounded-xl border">
        {checks.map((c) => {
          const { icon: Icon, className } = ICON[c.status];
          return (
            <li key={c.id} className="flex gap-3 px-3.5 py-3">
              <Icon className={cn('mt-0.5 size-4.5 shrink-0', className)} aria-hidden />
              <div className="min-w-0">
                <div className="text-sm font-medium">
                  {c.label}
                  <span className="sr-only"> — {c.status}</span>
                </div>
                <p className="text-muted mt-0.5 text-[13px]">{c.detail}</p>
                {c.fix && (
                  <p className="bg-accent-soft text-accent-strong mt-2 rounded-md px-2.5 py-1.5 text-[13px]">
                    <span className="font-medium">Try: </span>
                    {c.fix}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
