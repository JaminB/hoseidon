import type { LucideIcon } from 'lucide-react';
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('bg-surface-3 animate-shimmer rounded-md', className)} {...props} />;
}

export function Stat({
  label,
  value,
  hint,
  icon: Icon,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: LucideIcon;
  tone?: 'accent' | 'warn' | 'danger';
}) {
  return (
    <div className="min-w-0">
      <div className="text-muted flex items-center gap-1.5 text-[13px]">
        {Icon && (
          <Icon
            className={cn(
              'size-3.5',
              tone === 'accent' && 'text-accent-strong',
              tone === 'warn' && 'text-warn-strong',
              tone === 'danger' && 'text-danger',
            )}
          />
        )}
        {label}
      </div>
      <div className="tnum mt-1 truncate text-[22px] leading-7 font-semibold tracking-tight">
        {value}
      </div>
      {hint && <div className="text-subtle mt-0.5 truncate text-xs">{hint}</div>}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center px-6 py-12 text-center', className)}>
      <div className="bg-accent-soft text-accent-strong mb-4 grid size-11 place-items-center rounded-xl">
        <Icon className="size-5" />
      </div>
      <h3 className="text-[15px] font-semibold tracking-tight">{title}</h3>
      {description && (
        <p className="text-muted mt-1.5 max-w-sm text-sm text-balance">{description}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="text-fg block text-[13px] font-medium">
        {label}
      </label>
      {children}
      {hint && <p className="text-subtle text-xs">{hint}</p>}
    </div>
  );
}

export const inputClass =
  'bg-surface border-line placeholder:text-subtle focus:border-accent focus:ring-ring h-9 w-full rounded-md border px-3 text-sm shadow-xs outline-none transition-[border-color,box-shadow] focus:ring-3';

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(inputClass, className)} {...props} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="border-line bg-surface-2 text-subtle inline-flex h-5 min-w-5 items-center justify-center rounded border px-1 font-mono text-[11px]">
      {children}
    </kbd>
  );
}
