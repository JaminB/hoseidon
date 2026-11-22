import type { Device, Schedule, SkipRules } from '@hoseidon/shared';
import { Check, Minus, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { formatDuration } from '../../lib/format';
import { parseRepeat, toRrule, WEEKDAYS, type Repeat, type Weekday } from '../../lib/repeat';
import { SCHEDULE_COLORS, toInput, type ScheduleDraft } from '../../lib/schedule-draft';
import {
  useCreateSchedule,
  useDeleteSchedule,
  useDevices,
  usePatchSchedule,
} from '../../lib/queries';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/dialog';
import { Field, Input, inputClass } from '../ui/misc';
import { Sheet } from '../ui/sheet';
import { Switch } from '../ui/switch';
import { Segmented } from '../ui/tabs';

export type SheetState =
  | { mode: 'create'; draft: ScheduleDraft }
  | { mode: 'edit'; schedule: Schedule; draft: ScheduleDraft }
  | null;

export function ScheduleSheet({ state, onClose }: { state: SheetState; onClose: () => void }) {
  return (
    <Sheet
      open={state !== null}
      onOpenChange={(o) => !o && onClose()}
      title={state?.mode === 'edit' ? 'Edit schedule' : 'New schedule'}
      description={
        state?.mode === 'edit'
          ? undefined
          : 'Hoseidon runs it through LinkTap and skips it when the weather says so.'
      }
      wide
    >
      {state && (
        <ScheduleForm
          key={
            state.mode === 'edit'
              ? `e${state.schedule.id}`
              : `c${state.draft.dtstart}${state.draft.name}`
          }
          state={state}
          onDone={onClose}
        />
      )}
    </Sheet>
  );
}

const DAY_LETTER: Record<Weekday, string> = {
  MO: 'M',
  TU: 'T',
  WE: 'W',
  TH: 'T',
  FR: 'F',
  SA: 'S',
  SU: 'S',
};
const DAY_NAME: Record<Weekday, string> = {
  MO: 'Monday',
  TU: 'Tuesday',
  WE: 'Wednesday',
  TH: 'Thursday',
  FR: 'Friday',
  SA: 'Saturday',
  SU: 'Sunday',
};

function ScheduleForm({ state, onDone }: { state: NonNullable<SheetState>; onDone: () => void }) {
  const [d, setD] = useState<ScheduleDraft>(state.draft);
  const [repeat, setRepeat] = useState<Repeat>(() => parseRepeat(state.draft.rrule));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { devices } = useDevices();
  const create = useCreateSchedule();
  const patch = usePatchSchedule();
  const del = useDeleteSchedule();

  const set = <K extends keyof ScheduleDraft>(k: K, v: ScheduleDraft[K]) =>
    setD((p) => ({ ...p, [k]: v }));
  const setSkip = <K extends keyof SkipRules>(k: K, v: SkipRules[K]) =>
    setD((p) => ({ ...p, skipRules: { ...p.skipRules, [k]: v } }));

  const [date = '', time = '06:00'] = d.dtstart.split('T');
  const totalSec = d.items.reduce((s, i) => s + i.seconds, 0);
  const canSave = d.items.length > 0 && (repeat.kind !== 'weekly' || repeat.days.length > 0);
  const saving = create.isPending || patch.isPending;

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    const input = toInput({ ...d, rrule: toRrule(repeat) });
    if (state.mode === 'edit') {
      patch.mutate({ id: state.schedule.id, patch: input }, { onSuccess: onDone });
    } else {
      create.mutate(input, { onSuccess: onDone });
    }
  };

  const toggleZone = (dev: Device) => {
    const has = d.items.some((i) => i.deviceId === dev.id);
    set(
      'items',
      has
        ? d.items.filter((i) => i.deviceId !== dev.id)
        : [...d.items, { deviceId: dev.id, seconds: d.zoneSeconds ?? 600 }],
    );
    if (!has && !d.name.trim() && d.items.length === 0) set('name', dev.name);
  };

  const warnings = state.mode === 'edit' ? state.schedule.warnings : [];

  return (
    <form onSubmit={save} className="space-y-6" id="schedule-form">
      {warnings.length > 0 && (
        <div className="border-warn/30 bg-warn-soft text-warn-strong space-y-1 rounded-lg border px-3.5 py-2.5 text-[13px]">
          {warnings.map((w) => (
            <div key={`${w.kind}${w.deviceId}`} className="flex gap-2">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              {w.message}
            </div>
          ))}
        </div>
      )}

      <div className="flex items-end gap-3">
        <div className="flex-1">
          <Field label="Name" htmlFor="s-name">
            <Input
              id="s-name"
              value={d.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="Front lawn mornings"
              maxLength={80}
              autoComplete="off"
            />
          </Field>
        </div>
        {state.mode === 'edit' && (
          <label className="flex h-9 items-center gap-2 text-[13px] font-medium">
            <Switch
              checked={d.enabled}
              onCheckedChange={(v) => set('enabled', v)}
              label="Enabled"
            />
            {d.enabled ? 'On' : 'Off'}
          </label>
        )}
      </div>

      <div className="space-y-1.5">
        <div className="text-[13px] font-medium">Color</div>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Color">
          {SCHEDULE_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={d.color === c}
              aria-label={c}
              onClick={() => set('color', c)}
              className={cn(
                'grid size-7 place-items-center rounded-full transition-transform hover:scale-110',
                d.color === c && 'ring-fg/80 ring-2 ring-offset-2 ring-offset-[var(--app-surface)]',
              )}
              style={{ background: c }}
            >
              {d.color === c && <Check className="size-3.5 text-white" strokeWidth={3} />}
            </button>
          ))}
        </div>
      </div>

      <Group title="Zones" aside={d.items.length ? `${formatDuration(totalSec)} total` : undefined}>
        <ul className="border-line divide-line divide-y overflow-hidden rounded-lg border">
          {devices.map((dev) => {
            const item = d.items.find((i) => i.deviceId === dev.id);
            return (
              <li
                key={dev.id}
                className={cn('flex items-center gap-3 px-3 py-2', item && 'bg-accent-soft/50')}
              >
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    checked={!!item}
                    onChange={() => toggleZone(dev)}
                    className="accent-[var(--app-accent)] size-4 shrink-0"
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{dev.name}</span>
                    {!dev.online && <span className="text-danger block text-xs">Offline</span>}
                  </span>
                </label>
                {item && (
                  <Stepper
                    value={Math.round(item.seconds / 60)}
                    onChange={(m) =>
                      set(
                        'items',
                        d.items.map((i) => (i.deviceId === dev.id ? { ...i, seconds: m * 60 } : i)),
                      )
                    }
                    label={`Minutes for ${dev.name}`}
                  />
                )}
              </li>
            );
          })}
        </ul>
        {d.items.length > 1 && (
          <Toggle
            label="One zone at a time"
            hint="Zones on the same gateway run back to back, for water pressure."
            checked={d.sequential}
            onChange={(v) => set('sequential', v)}
          />
        )}
      </Group>

      <Group title="When">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Starts" htmlFor="s-date">
            <input
              id="s-date"
              type="date"
              className={inputClass}
              value={date}
              required
              onChange={(e) => set('dtstart', `${e.target.value}T${time}`)}
            />
          </Field>
          <Field label="At" htmlFor="s-time">
            <input
              id="s-time"
              type="time"
              step={300}
              className={inputClass}
              value={time}
              required
              onChange={(e) => set('dtstart', `${date}T${e.target.value}`)}
            />
          </Field>
        </div>
        <RepeatPicker value={repeat} onChange={setRepeat} />
        <p className="text-subtle text-xs">Times are in {d.timezone.replace(/_/g, ' ')}.</p>
      </Group>

      <Group title="Cycle and soak">
        <Toggle
          label="Split into cycles"
          hint="Short runs with rests soak in instead of running off."
          checked={d.cycleSoak !== null}
          onChange={(v) => set('cycleSoak', v ? { cycles: 3, soakMinutes: 20 } : null)}
        />
        {d.cycleSoak && (
          <div className="flex flex-wrap gap-x-6 gap-y-3 pl-0.5">
            <Inline label="Cycles">
              <Stepper
                value={d.cycleSoak.cycles}
                min={2}
                max={10}
                unit="×"
                onChange={(cycles) => set('cycleSoak', { ...d.cycleSoak!, cycles })}
                label="Cycles"
              />
            </Inline>
            <Inline label="Soak">
              <Stepper
                value={d.cycleSoak.soakMinutes}
                min={0}
                max={240}
                step={5}
                onChange={(soakMinutes) => set('cycleSoak', { ...d.cycleSoak!, soakMinutes })}
                label="Soak minutes"
              />
            </Inline>
          </div>
        )}
      </Group>

      <Group title="Weather" aside="Needs a gateway location">
        <Threshold
          label="Skip if rain forecast over"
          unit="mm"
          value={d.skipRules.rainForecastMm}
          fallback={5}
          min={0}
          max={500}
          onChange={(v) => setSkip('rainForecastMm', v)}
        />
        <Threshold
          label="Skip if it freezes below"
          unit="°C"
          value={d.skipRules.freezeC}
          fallback={2}
          min={-50}
          max={20}
          onChange={(v) => setSkip('freezeC', v)}
        />
        <Threshold
          label="Skip if wind over"
          unit="km/h"
          value={d.skipRules.windKph}
          fallback={30}
          min={0}
          max={300}
          step={5}
          onChange={(v) => setSkip('windKph', v)}
        />
        <Toggle
          label="Scale with evapotranspiration"
          hint="Water more on hot, dry days and less on mild ones (ET₀)."
          checked={d.skipRules.etScaling}
          onChange={(v) => setSkip('etScaling', v)}
        />
      </Group>

      <div className="bg-surface border-line sticky -bottom-5 -mx-5 flex items-center gap-2 border-t px-5 pt-3 pb-4">
        {state.mode === 'edit' && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="hover:text-danger"
            onClick={() => setConfirmDelete(true)}
            aria-label="Delete schedule"
          >
            <Trash2 className="size-4" />
          </Button>
        )}
        <span className="text-subtle mr-auto text-xs">
          {!d.items.length
            ? 'Pick at least one zone'
            : repeat.kind === 'weekly' && !repeat.days.length
              ? 'Pick at least one day'
              : ''}
        </span>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!canSave} loading={saving}>
          {state.mode === 'edit' ? 'Save' : 'Create'}
        </Button>
      </div>

      {state.mode === 'edit' && (
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title={`Delete “${state.schedule.name}”?`}
          description="Upcoming runs are removed. Anything watering right now finishes on its own timer."
          confirmLabel="Delete"
          onConfirm={() => {
            del.mutate(state.schedule);
            onDone();
          }}
        />
      )}
    </form>
  );
}

function Group({ title, aside, children }: { title: string; aside?: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-3">
      <legend className="mb-3 flex w-full items-baseline justify-between">
        <span className="text-[13px] font-semibold">{title}</span>
        {aside && <span className="text-subtle text-xs">{aside}</span>}
      </legend>
      {children}
    </fieldset>
  );
}

function Inline({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-muted text-[13px]">{label}</span>
      {children}
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4">
      <span>
        <span className="block text-sm">{label}</span>
        {hint && <span className="text-subtle block text-xs">{hint}</span>}
      </span>
      <Switch checked={checked} onCheckedChange={onChange} label={label} className="mt-0.5" />
    </label>
  );
}

function Threshold({
  label,
  unit,
  value,
  fallback,
  onChange,
  ...range
}: {
  label: string;
  unit: string;
  value: number | null;
  fallback: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number | null) => void;
}) {
  return (
    <div className="flex min-h-8 items-center justify-between gap-3">
      <label className="flex cursor-pointer items-center gap-3 text-sm">
        <Switch
          checked={value !== null}
          onCheckedChange={(on) => onChange(on ? fallback : null)}
          label={label}
        />
        <span className={cn(value === null && 'text-muted')}>{label}</span>
      </label>
      {value !== null && (
        <Stepper value={value} onChange={onChange} unit={unit} label={label} {...range} />
      )}
    </div>
  );
}

function Stepper({
  value,
  onChange,
  min = 1,
  max = 1439,
  step = 1,
  unit = 'min',
  label,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  label: string;
}) {
  const clampTo = (v: number) => Math.min(max, Math.max(min, v));
  return (
    <div className="border-line bg-surface flex h-8 shrink-0 items-center rounded-md border shadow-xs">
      <button
        type="button"
        className="text-muted hover:text-fg grid h-full w-7 place-items-center disabled:opacity-30"
        onClick={() => onChange(clampTo(value - step))}
        disabled={value <= min}
        aria-label={`Less ${label}`}
      >
        <Minus className="size-3.5" />
      </button>
      <input
        type="number"
        inputMode="numeric"
        className="tnum w-10 [appearance:textfield] bg-transparent text-center text-sm font-medium outline-none [&::-webkit-inner-spin-button]:appearance-none"
        value={value}
        min={min}
        max={max}
        aria-label={label}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(clampTo(n));
        }}
      />
      <span className="text-subtle pr-1 text-xs">{unit}</span>
      <button
        type="button"
        className="text-muted hover:text-fg grid h-full w-7 place-items-center disabled:opacity-30"
        onClick={() => onChange(clampTo(value + step))}
        disabled={value >= max}
        aria-label={`More ${label}`}
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  );
}

function RepeatPicker({ value, onChange }: { value: Repeat; onChange: (r: Repeat) => void }) {
  const kind = value.kind === 'daily' && value.interval === 2 ? 'other' : value.kind;
  return (
    <div className="space-y-3">
      <Segmented
        label="Repeat"
        className="flex w-full"
        value={kind}
        onChange={(k) => {
          if (k === 'daily') onChange({ kind: 'daily', interval: 1 });
          else if (k === 'other') onChange({ kind: 'daily', interval: 2 });
          else if (k === 'weekly')
            onChange({
              kind: 'weekly',
              interval: 1,
              days: value.kind === 'weekly' ? value.days : ['MO', 'WE', 'FR'],
            });
        }}
        options={[
          { value: 'daily', label: 'Daily' },
          { value: 'other', label: 'Every other day' },
          { value: 'weekly', label: 'Days of week' },
          ...(value.kind === 'custom' ? [{ value: 'custom' as const, label: 'Custom' }] : []),
        ]}
      />
      {value.kind === 'daily' && value.interval > 2 && (
        <p className="text-muted text-[13px]">Every {value.interval} days</p>
      )}
      {value.kind === 'weekly' && (
        <div className="flex gap-1.5">
          {WEEKDAYS.map((day) => {
            const on = value.days.includes(day);
            return (
              <button
                key={day}
                type="button"
                aria-pressed={on}
                aria-label={DAY_NAME[day]}
                title={DAY_NAME[day]}
                onClick={() =>
                  onChange({
                    ...value,
                    days: on ? value.days.filter((x) => x !== day) : [...value.days, day],
                  })
                }
                className={cn(
                  'grid size-9 place-items-center rounded-full text-[13px] font-medium transition-colors',
                  on ? 'bg-accent text-accent-fg' : 'bg-surface-2 text-muted hover:text-fg',
                )}
              >
                {DAY_LETTER[day]}
              </button>
            );
          })}
        </div>
      )}
      {value.kind === 'custom' && (
        <Field
          label="RRULE"
          htmlFor="s-rrule"
          hint="This rule was written elsewhere; edit it as text."
        >
          <Input
            id="s-rrule"
            className="font-mono text-xs"
            value={value.rrule}
            onChange={(e) => onChange({ kind: 'custom', rrule: e.target.value })}
          />
        </Field>
      )}
    </div>
  );
}
