import { useQueryClient } from '@tanstack/react-query';
import { lazy, useEffect, type ReactNode } from 'react';
import { Route, Routes } from 'react-router';
import { LogoMark } from './components/logo';
import { Button } from './components/ui/button';
import { SIGNED_OUT_EVENT } from './lib/api';
import { SESSION_KEY, useSession } from './lib/queries';
import { LoginPage } from './pages/login';
import { AppShell } from './components/layout/app-shell';
import { HomePage } from './pages/home';

// Home ships in the main bundle; the rest load on first visit.
const DevicesPage = lazy(() => import('./pages/devices').then((m) => ({ default: m.DevicesPage })));
const SchedulePage = lazy(() =>
  import('./pages/schedule').then((m) => ({ default: m.SchedulePage })),
);
const SettingsPage = lazy(() =>
  import('./pages/settings').then((m) => ({ default: m.SettingsPage })),
);
const AnalyticsPage = lazy(() =>
  import('./pages/analytics').then((m) => ({ default: m.AnalyticsPage })),
);
const NetworkPage = lazy(() => import('./pages/network').then((m) => ({ default: m.NetworkPage })));

export function App() {
  return (
    <AuthGate>
      <AppRoutes />
    </AuthGate>
  );
}

/** The app once signed in; the login page otherwise. Cached data is dropped on sign-out. */
function AuthGate({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const session = useSession();
  const authenticated = session.data?.authenticated;

  // Any 401 means the cookie is gone or expired.
  useEffect(() => {
    const signedOut = () =>
      qc.setQueryData<{ authenticated: boolean }>(
        SESSION_KEY,
        (s) => s && { ...s, authenticated: false },
      );
    window.addEventListener(SIGNED_OUT_EVENT, signedOut);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, signedOut);
  }, [qc]);

  // Don't leave one session's data in memory (or the offline cache) for the next visitor.
  useEffect(() => {
    if (authenticated === false) {
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== SESSION_KEY[0] });
    }
  }, [authenticated, qc]);

  if (session.data) return authenticated ? children : <LoginPage session={session.data} />;
  return (
    <div className="grid min-h-dvh place-items-center px-4">
      {session.isError ? (
        <div className="flex flex-col items-center gap-3 text-center">
          <LogoMark className="size-12 rounded-2xl" />
          <p className="text-muted text-sm">Can’t reach the Hoseidon server.</p>
          <Button onClick={() => void session.refetch()}>Try again</Button>
        </div>
      ) : (
        <LogoMark className="size-12 animate-pulse rounded-2xl" />
      )}
    </div>
  );
}

function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<HomePage />} />
        <Route path="devices" element={<DevicesPage />} />
        <Route path="schedule" element={<SchedulePage />} />
        <Route path="analytics" element={<AnalyticsPage />} />
        <Route path="network" element={<NetworkPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<HomePage />} />
      </Route>
    </Routes>
  );
}
