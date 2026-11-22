import { Toast as T } from 'radix-ui';
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { cn } from '../../lib/cn';

type Tone = 'info' | 'success' | 'error';
interface ToastItem {
  id: number;
  title: string;
  description?: string;
  tone: Tone;
}

let items: ToastItem[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Fire-and-forget toast, callable from anywhere (mutations, event handlers). */
export function toast(title: string, opts: { description?: string; tone?: Tone } = {}) {
  items = [
    ...items.slice(-2),
    { id: ++seq, title, description: opts.description, tone: opts.tone ?? 'info' },
  ];
  emit();
}
toast.error = (title: string, description?: string) => toast(title, { description, tone: 'error' });
toast.success = (title: string, description?: string) =>
  toast(title, { description, tone: 'success' });

function remove(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

const ICON = { info: Info, success: CircleCheck, error: CircleAlert };

export function Toaster() {
  const list = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => items,
  );
  return (
    <T.Provider swipeDirection="down" duration={4500}>
      {list.map((t) => {
        const Icon = ICON[t.tone];
        return (
          <T.Root
            key={t.id}
            onOpenChange={(open) => !open && remove(t.id)}
            className={cn(
              'bg-surface border-line shadow-lg pointer-events-auto flex w-full items-start gap-3 rounded-lg border px-4 py-3',
              'data-[state=open]:animate-toast-in data-[state=closed]:animate-fade-out',
              'data-[swipe=move]:translate-y-(--radix-toast-swipe-move-y) data-[swipe=end]:animate-fade-out',
            )}
          >
            <Icon
              className={cn(
                'mt-0.5 size-4 shrink-0',
                t.tone === 'error'
                  ? 'text-danger'
                  : t.tone === 'success'
                    ? 'text-ok'
                    : 'text-accent-strong',
              )}
            />
            <div className="min-w-0 flex-1">
              <T.Title className="text-sm font-medium">{t.title}</T.Title>
              {t.description && (
                <T.Description className="text-muted mt-0.5 text-[13px]">
                  {t.description}
                </T.Description>
              )}
            </div>
            <T.Close className="text-subtle hover:text-fg -mr-1 rounded p-0.5" aria-label="Dismiss">
              <X className="size-3.5" />
            </T.Close>
          </T.Root>
        );
      })}
      <T.Viewport className="fixed inset-x-4 bottom-[calc(76px+env(safe-area-inset-bottom))] z-[100] flex flex-col gap-2 outline-none md:inset-x-auto md:right-6 md:bottom-6 md:w-90" />
    </T.Provider>
  );
}
