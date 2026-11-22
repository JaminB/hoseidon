import { Dialog as D } from 'radix-ui';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** Wider panel on desktop. */
  wide?: boolean;
}

/**
 * Side sheet on desktop, bottom sheet on phones. Built on Radix Dialog (focus trap, Esc, aria).
 */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  wide,
}: SheetProps) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out fixed inset-0 z-50 bg-black/30 dark:bg-black/60" />
        <D.Content
          className={cn(
            'bg-surface border-line fixed z-50 flex flex-col shadow-lg outline-none',
            // phone: bottom sheet
            'inset-x-0 bottom-0 max-h-[92dvh] rounded-t-2xl border-t',
            'data-[state=open]:animate-sheet-up data-[state=closed]:animate-sheet-down',
            // desktop: right panel
            'md:inset-y-2 md:right-2 md:left-auto md:max-h-none md:rounded-2xl md:border',
            'md:data-[state=open]:animate-sheet-in md:data-[state=closed]:animate-sheet-out',
            wide ? 'md:w-[min(520px,calc(100vw-16px))]' : 'md:w-[min(440px,calc(100vw-16px))]',
          )}
        >
          <div className="bg-line-strong mx-auto mt-2 h-1 w-9 shrink-0 rounded-full md:hidden" />
          <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-2 md:pt-5">
            <div className="min-w-0">
              <D.Title className="text-[17px] font-semibold tracking-tight">{title}</D.Title>
              {description ? (
                <D.Description className="text-muted mt-1 text-[13px]">{description}</D.Description>
              ) : (
                <D.Description className="sr-only">{title}</D.Description>
              )}
            </div>
            <D.Close
              className="text-subtle hover:text-fg hover:bg-surface-2 -mt-1 -mr-1.5 rounded-md p-1.5 transition-colors"
              aria-label="Close"
            >
              <X className="size-4" />
            </D.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-2 pb-5">{children}</div>
          {footer && (
            <div className="border-line pb-safe flex items-center gap-2 border-t px-5 py-3">
              <div className="flex w-full items-center gap-2 pb-2 md:pb-0">{footer}</div>
            </div>
          )}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
