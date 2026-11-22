import { cn } from '../lib/cn';

/** The Hoseidon trident, drawn to sit with lucide icons (24 grid, 1.75 stroke). */
export function Trident({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M12 3v18" />
      <path d="M5.5 4.5V9a6.5 6.5 0 0 0 13 0V4.5" />
      <path d="M4 6.5 5.5 4.5 7 6.5M17 6.5l1.5-2 1.5 2M10.5 5 12 3l1.5 2" />
      <path d="M9.5 18.5h5" />
    </svg>
  );
}

export function LogoMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'grid size-8 place-items-center rounded-[10px] bg-linear-to-b from-[oklch(0.78_0.12_200)] to-[oklch(0.6_0.12_215)] text-white shadow-sm ring-1 ring-black/5 ring-inset',
        className,
      )}
    >
      <Trident className="size-[19px]" />
    </span>
  );
}
