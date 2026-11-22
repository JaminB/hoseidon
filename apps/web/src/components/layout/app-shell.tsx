import {
  CalendarDays,
  ChartColumn,
  Droplet,
  House,
  Monitor,
  Moon,
  Network,
  Settings,
  Sun,
  type LucideIcon,
} from 'lucide-react';
import { Suspense, type ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router';
import { cn } from '../../lib/cn';
import { useHealth } from '../../lib/queries';
import { useTheme, type ThemePref } from '../../lib/theme';
import { Dot } from '../ui/badge';
import { LogoMark } from '../logo';

export const NAV: { to: string; label: string; icon: LucideIcon }[] = [
  { to: '/', label: 'Home', icon: House },
  { to: '/devices', label: 'Devices', icon: Droplet },
  { to: '/schedule', label: 'Schedule', icon: CalendarDays },
  { to: '/analytics', label: 'Analytics', icon: ChartColumn },
  { to: '/network', label: 'Network', icon: Network },
  { to: '/settings', label: 'Settings', icon: Settings },
];

const THEME_ICON: Record<ThemePref, LucideIcon> = { system: Monitor, light: Sun, dark: Moon };
const NEXT_THEME: Record<ThemePref, ThemePref> = { system: 'light', light: 'dark', dark: 'system' };

export function ThemeToggle({ className }: { className?: string }) {
  const [theme, setTheme] = useTheme();
  const Icon = THEME_ICON[theme];
  return (
    <button
      type="button"
      onClick={() => setTheme(NEXT_THEME[theme])}
      className={cn(
        'text-muted hover:text-fg hover:bg-surface-2 grid size-8 place-items-center rounded-md transition-colors',
        className,
      )}
      aria-label={`Theme: ${theme}. Switch to ${NEXT_THEME[theme]}`}
      title={`Theme: ${theme}`}
    >
      <Icon className="size-4" />
    </button>
  );
}

function ServerPill() {
  const { data, isError, isPending } = useHealth();
  return (
    <div className="text-muted flex items-center gap-2 text-xs">
      <Dot tone={isError ? 'danger' : isPending ? 'muted' : 'ok'} />
      {isError
        ? 'Server unreachable'
        : isPending
          ? 'Connecting…'
          : data.mock
            ? 'Mock LinkTap'
            : 'LinkTap cloud'}
    </div>
  );
}

function Sidebar() {
  return (
    <aside className="border-line bg-bg sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r px-3 py-4 md:flex">
      <div className="flex items-center gap-2.5 px-2 pb-6">
        <LogoMark />
        <div className="leading-tight">
          <div className="text-[15px] font-semibold tracking-tight">Hoseidon</div>
          <div className="text-subtle text-xs">God of the garden hose</div>
        </div>
      </div>
      <nav className="flex flex-col gap-0.5" aria-label="Main">
        {NAV.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              cn(
                'flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-surface text-fg border-line border shadow-xs'
                  : 'text-muted hover:text-fg hover:bg-surface-2 border border-transparent',
              )
            }
          >
            {({ isActive }) => (
              <>
                <Icon className={cn('size-4', isActive && 'text-accent-strong')} />
                {label}
              </>
            )}
          </NavLink>
        ))}
      </nav>
      <div className="mt-auto flex items-center justify-between px-2">
        <ServerPill />
        <ThemeToggle />
      </div>
    </aside>
  );
}

function TabBar() {
  return (
    <nav
      aria-label="Main"
      className="border-line bg-bg/85 pb-safe fixed inset-x-0 bottom-0 z-40 border-t backdrop-blur-xl md:hidden"
    >
      <div className="grid grid-cols-6">
        {NAV.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              cn(
                'flex h-15 flex-col items-center justify-center gap-1 text-[10.5px] font-medium transition-colors',
                isActive ? 'text-accent-strong' : 'text-subtle',
              )
            }
          >
            <Icon className="size-5" strokeWidth={1.75} />
            {label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}

export function AppShell() {
  return (
    <div className="flex min-h-dvh">
      <Sidebar />
      <main className="min-w-0 flex-1 pb-[calc(76px+env(safe-area-inset-bottom))] md:pb-0">
        <Suspense>
          <Outlet />
        </Suspense>
      </main>
      <TabBar />
    </div>
  );
}

/** Page title row. On phones it carries the logo + theme toggle since there's no sidebar. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="pt-4 pb-5 md:pt-10 md:pb-7">
      <div className="mb-5 flex items-center justify-between md:hidden">
        <div className="flex items-center gap-2">
          <LogoMark className="size-7 rounded-[9px]" />
          <span className="text-[15px] font-semibold tracking-tight">Hoseidon</span>
        </div>
        <ThemeToggle className="-mr-1.5" />
      </div>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-[26px] leading-8 font-semibold tracking-tight md:text-[28px]">
            {title}
          </h1>
          {description && <p className="text-muted mt-1 text-sm">{description}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

/** Standard page width + gutters. */
export function Page({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className={cn('mx-auto w-full px-4 pb-10 md:px-8', wide ? 'max-w-[1400px]' : 'max-w-5xl')}>
      {children}
    </div>
  );
}
