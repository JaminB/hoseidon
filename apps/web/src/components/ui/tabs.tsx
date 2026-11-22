import { RadioGroup, Tabs as T } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export const Tabs = T.Root;
export const TabsContent = T.Content;

/** Segmented-control style tab list. */
export function TabsList({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <T.List
      className={cn('bg-surface-2 border-line inline-flex rounded-lg border p-0.5', className)}
    >
      {children}
    </T.List>
  );
}

export function TabsTrigger({ value, children }: { value: string; children: ReactNode }) {
  return (
    <T.Trigger
      value={value}
      className={cn(
        'text-muted inline-flex h-7 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium transition-colors',
        'hover:text-fg data-[state=active]:bg-surface data-[state=active]:text-fg data-[state=active]:shadow-xs',
      )}
    >
      {children}
    </T.Trigger>
  );
}

/** A segmented control for small choices outside of tab panels (Radix RadioGroup: arrow keys). */
export function Segmented<V extends string>({
  value,
  onChange,
  options,
  className,
  label,
}: {
  value: V;
  onChange: (v: V) => void;
  options: { value: V; label: ReactNode }[];
  className?: string;
  label: string;
}) {
  return (
    <RadioGroup.Root
      value={value}
      onValueChange={(v) => onChange(v as V)}
      aria-label={label}
      orientation="horizontal"
      className={cn('bg-surface-2 border-line inline-flex rounded-lg border p-0.5', className)}
    >
      {options.map((o) => (
        <RadioGroup.Item
          key={o.value}
          value={o.value}
          className={cn(
            'inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md px-3 text-[13px] font-medium transition-colors',
            'text-muted hover:text-fg data-[state=checked]:bg-surface data-[state=checked]:text-fg data-[state=checked]:shadow-xs',
          )}
        >
          {o.label}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
