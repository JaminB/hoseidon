import { Tabs as T } from 'radix-ui';
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

/** A segmented control for small choices outside of tab panels. */
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
    <div
      role="radiogroup"
      aria-label={label}
      className={cn('bg-surface-2 border-line inline-flex rounded-lg border p-0.5', className)}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md px-3 text-[13px] font-medium transition-colors',
            value === o.value ? 'bg-surface text-fg shadow-xs' : 'text-muted hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
