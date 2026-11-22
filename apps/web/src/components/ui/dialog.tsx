import { AlertDialog as A } from 'radix-ui';
import type { ReactNode } from 'react';
import { Button } from './button';

/** A small confirm dialog for destructive actions. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  onConfirm: () => void;
}) {
  return (
    <A.Root open={open} onOpenChange={onOpenChange}>
      <A.Portal>
        <A.Overlay className="data-[state=open]:animate-fade-in fixed inset-0 z-[60] bg-black/30 dark:bg-black/55" />
        <A.Content className="bg-surface border-line data-[state=open]:animate-pop-in fixed top-1/2 left-1/2 z-[60] w-[min(400px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-xl border p-5 shadow-lg">
          <A.Title className="text-[15px] font-semibold">{title}</A.Title>
          {description && (
            <A.Description className="text-muted mt-1.5 text-sm">{description}</A.Description>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <A.Cancel asChild>
              <Button variant="ghost">Cancel</Button>
            </A.Cancel>
            <A.Action asChild>
              <Button variant="danger" onClick={onConfirm}>
                {confirmLabel}
              </Button>
            </A.Action>
          </div>
        </A.Content>
      </A.Portal>
    </A.Root>
  );
}
