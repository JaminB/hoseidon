import { lazy } from 'react';
import { Route, Routes } from 'react-router';
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
  import('./pages/placeholders').then((m) => ({ default: m.AnalyticsPage })),
);
const NetworkPage = lazy(() =>
  import('./pages/placeholders').then((m) => ({ default: m.NetworkPage })),
);

export function App() {
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
