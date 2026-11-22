import { Slot } from 'radix-ui';
import { LoaderCircle } from 'lucide-react';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

const VARIANT = {
  primary:
    'bg-accent text-accent-fg shadow-xs hover:brightness-[1.06] active:brightness-95 disabled:opacity-50',
  secondary:
    'bg-surface text-fg border border-line shadow-xs hover:bg-surface-2 hover:border-line-strong disabled:opacity-50',
  ghost: 'text-muted hover:text-fg hover:bg-surface-2 disabled:opacity-40',
  soft: 'bg-accent-soft text-accent-strong hover:brightness-[0.98] dark:hover:brightness-110 disabled:opacity-50',
  danger:
    'bg-danger-soft text-danger hover:brightness-[0.97] dark:hover:brightness-110 disabled:opacity-50',
} as const;

const SIZE = {
  sm: 'h-8 px-2.5 text-[13px] gap-1.5 rounded-md',
  md: 'h-9 px-3.5 text-sm gap-2 rounded-md',
  lg: 'h-11 px-5 text-[15px] gap-2 rounded-lg',
  icon: 'size-9 rounded-md',
  'icon-sm': 'size-8 rounded-md',
} as const;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof VARIANT;
  size?: keyof typeof SIZE;
  loading?: boolean;
  asChild?: boolean;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading,
  asChild,
  className,
  children,
  disabled,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button';
  return (
    <Comp
      className={cn(
        'inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap select-none',
        'transition-[background-color,border-color,filter,color,transform] duration-150 active:scale-[0.98] disabled:pointer-events-none',
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      disabled={disabled || loading}
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <>
          {loading && <LoaderCircle className="size-4 animate-spin" />}
          {children}
        </>
      )}
    </Comp>
  );
}
