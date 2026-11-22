import type { ReactNode } from 'react';

/** One label/value line inside a settings card's divided list. */
export function Row({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3 text-sm">
      <div className="min-w-0">
        <dt className="text-fg">{label}</dt>
        {hint && <p className="text-subtle mt-0.5 text-xs">{hint}</p>}
      </div>
      <dd className="tnum shrink-0 text-right">{children}</dd>
    </div>
  );
}
