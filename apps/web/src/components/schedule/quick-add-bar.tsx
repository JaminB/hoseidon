import { parseQuickAdd } from '@hoseidon/shared';
import { useMutation } from '@tanstack/react-query';
import { ArrowRight, CircleCheck, CircleX, SlidersHorizontal, Sparkles } from 'lucide-react';
import { useDeferredValue, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { cn } from '../../lib/cn';
import { formatDuration } from '../../lib/format';
import { useCreateSchedule, useDevices } from '../../lib/queries';
import { blankDraft, browserTimeZone, type ScheduleDraft } from '../../lib/schedule-draft';
import { Button } from '../ui/button';
import { toast } from '../ui/toast';

const EXAMPLES = [
  'every other day 6am front lawn 15m',
  'mon wed fri 5:30am veggie beds 10 min x3 soak 20',
  'daily at 7 drip line a 20m, drip line b 20m',
];

/**
 * Natural-language quick add. Parses live in the browser with the shared parser for instant
 * feedback; on Enter the server parses again (with the zone's gateway time zone) and creates it.
 */
export function QuickAddBar({ onEdit }: { onEdit: (draft: ScheduleDraft) => void }) {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const { devices } = useDevices();
  const deferred = useDeferredValue(text);
  const create = useCreateSchedule();

  const preview = useMemo(
    () =>
      deferred.trim()
        ? parseQuickAdd(deferred, {
            devices: devices.map((d) => ({ id: d.id, name: d.name })),
            timeZone: browserTimeZone(),
          })
        : null,
    [deferred, devices],
  );

  const submit = useMutation({
    mutationFn: (t: string) => api.quickAdd(t),
    onSuccess: (res) => {
      if (!res.ok) return toast.error("That didn't quite parse", res.errors[0]);
      create.mutate(res.draft, { onSuccess: () => setText('') });
    },
    onError: (err) => toast.error('Quick add failed', err.message),
  });

  const editDraft = () => {
    if (!preview) return;
    onEdit(
      blankDraft({
        ...preview.draft,
        name: preview.draft.name === 'New schedule' ? '' : preview.draft.name,
      }),
    );
  };

  const busy = submit.isPending || create.isPending;
  const showHelp = focused && !text;

  return (
    <div className="relative">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim() && preview?.ok) submit.mutate(text.trim());
        }}
        className={cn(
          'bg-surface border-line flex items-center gap-2 rounded-xl border py-1.5 pr-1.5 pl-3.5 shadow-sm transition-[border-color,box-shadow]',
          'focus-within:border-accent focus-within:ring-ring focus-within:ring-3',
        )}
      >
        <Sparkles className="text-accent-strong size-4 shrink-0" />
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="Every other day 6am front lawn 15m"
          className="placeholder:text-subtle h-8 min-w-0 flex-1 bg-transparent text-sm outline-none"
          aria-label="Quick add a schedule"
          autoComplete="off"
          spellCheck={false}
        />
        {preview && (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            onClick={editDraft}
            aria-label="Edit details"
            title="Edit details"
          >
            <SlidersHorizontal className="size-4" />
          </Button>
        )}
        <Button type="submit" size="sm" variant="primary" disabled={!preview?.ok} loading={busy}>
          Add {!busy && <ArrowRight className="size-3.5" />}
        </Button>
      </form>

      {preview && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 px-1 text-[13px]">
          <span className="text-fg font-medium">{preview.summary}</span>
          {preview.zones.map((z) => (
            <span
              key={z.query}
              className={cn(
                'inline-flex items-center gap-1',
                z.deviceId ? 'text-muted' : 'text-danger',
              )}
            >
              {z.deviceId ? (
                <CircleCheck className="text-ok size-3.5" />
              ) : (
                <CircleX className="size-3.5" />
              )}
              {z.deviceName ?? z.query} · {formatDuration(z.seconds)}
            </span>
          ))}
          {preview.errors[0] && preview.zones.every((z) => z.deviceId) && (
            <span className="text-danger">{preview.errors[0]}</span>
          )}
          {preview.warnings.map((w) => (
            <span key={w} className="text-warn-strong">
              {w}
            </span>
          ))}
        </div>
      )}

      {showHelp && (
        <div className="bg-surface border-line animate-pop-in absolute inset-x-0 top-full z-20 mt-2 rounded-xl border p-2 shadow-lg">
          <div className="text-subtle px-2 pt-1 pb-1.5 text-xs font-medium">Try</div>
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                setText(ex);
              }}
              className="hover:bg-surface-2 text-muted hover:text-fg block w-full rounded-md px-2 py-1.5 text-left font-mono text-[12.5px] transition-colors"
            >
              {ex}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
