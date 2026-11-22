import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

const TONE = {
  neutral: 'bg-surface-2 text-muted border-line',
  accent: 'bg-accent-soft text-accent-strong border-transparent',
  ok: 'bg-ok-soft text-ok border-transparent',
  warn: 'bg-warn-soft text-warn-strong border-transparent',
  danger: 'bg-danger-soft text-danger border-transparent',
  outline: 'bg-transparent text-muted border-line',
} as const;

export type BadgeTone = keyof typeof TONE;

export function Badge({
  tone = 'neutral',
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn(
        'inline-flex h-5.5 items-center gap-1 rounded-full border px-2 text-xs font-medium whitespace-nowrap',
        TONE[tone],
        className,
      )}
      {...props}
    />
  );
}

/** A small status dot, optionally pulsing (live). */
export function Dot({
  tone,
  pulse,
}: {
  tone: 'ok' | 'warn' | 'danger' | 'accent' | 'muted';
  pulse?: boolean;
}) {
  const color = {
    ok: 'bg-ok',
    warn: 'bg-warn',
    danger: 'bg-danger',
    accent: 'bg-accent',
    muted: 'bg-subtle',
  }[tone];
  return (
    <span className="relative inline-flex size-2 shrink-0">
      {pulse && <span className={cn('animate-ripple absolute inset-0 rounded-full', color)} />}
      <span className={cn('relative size-2 rounded-full', color)} />
    </span>
  );
}
