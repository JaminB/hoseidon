import { Switch as S } from 'radix-ui';
import { cn } from '../../lib/cn';

export function Switch({
  checked,
  onCheckedChange,
  label,
  className,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  label: string;
  className?: string;
}) {
  return (
    <S.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      aria-label={label}
      className={cn(
        'bg-surface-3 data-[state=checked]:bg-accent relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
        className,
      )}
    >
      <S.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform duration-200 data-[state=checked]:translate-x-4.5" />
    </S.Root>
  );
}
