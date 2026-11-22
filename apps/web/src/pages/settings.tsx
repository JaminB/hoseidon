import { Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router';
import { AccessCard } from '../components/settings/access-card';
import { GcalCard } from '../components/gcal-card';
import { ThresholdCard } from '../components/network/threshold-card';
import { LinktapCard } from '../components/settings/linktap-card';
import { NotificationsCard } from '../components/settings/notifications-card';
import { PreferencesCard } from '../components/settings/preferences-card';
import { Row } from '../components/settings/row';
import { SecurityCard } from '../components/settings/security-card';
import { Skeleton } from '../components/ui/misc';
import { toast } from '../components/ui/toast';
import { connectErrorMessage } from '../lib/gcal';
import { Page, PageHeader } from '../components/layout/app-shell';
import { Card, CardHeader } from '../components/ui/card';
import { Segmented } from '../components/ui/tabs';
import { useHealth, useNetworkSettings } from '../lib/queries';
import { useTheme } from '../lib/theme';

export function SettingsPage() {
  const [theme, setTheme] = useTheme();
  const health = useHealth();
  useGcalRedirectToast();

  return (
    <Page>
      <PageHeader title="Settings" />
      <div className="space-y-5">
        <Card>
          <CardHeader title="Appearance" description="Follow your device, or pick one." />
          <div className="px-5 pb-5">
            <Segmented
              label="Theme"
              value={theme}
              onChange={setTheme}
              options={[
                {
                  value: 'system',
                  label: (
                    <>
                      <Monitor className="size-3.5" /> System
                    </>
                  ),
                },
                {
                  value: 'light',
                  label: (
                    <>
                      <Sun className="size-3.5" /> Light
                    </>
                  ),
                },
                {
                  value: 'dark',
                  label: (
                    <>
                      <Moon className="size-3.5" /> Dark
                    </>
                  ),
                },
              ]}
            />
          </div>
        </Card>

        <PreferencesCard />

        <NotificationsCard />

        <WeakSignal />

        <LinktapCard />

        <GcalCard />

        <SecurityCard />

        <AccessCard />

        <Card>
          <CardHeader title="About" />
          <dl className="divide-line border-line divide-y border-t">
            <Row label="Version">{health.data?.version ?? '—'}</Row>
            <Row label="Source">
              <a
                className="text-accent-strong hover:underline"
                href="https://github.com/JaminB/hoseidon"
                target="_blank"
                rel="noreferrer"
              >
                github.com/JaminB/hoseidon
              </a>
            </Row>
          </dl>
        </Card>
      </div>
    </Page>
  );
}

/** The OAuth callback lands here with ?gcal=connected or ?gcal=error&reason=…; say how it went. */
function useGcalRedirectToast() {
  const [params, setParams] = useSearchParams();
  const result = params.get('gcal');
  const reason = params.get('reason');
  // StrictMode runs effects twice in dev; toast once per redirect.
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!result || handled.current === `${result}:${reason}`) return;
    handled.current = `${result}:${reason}`;
    if (result === 'connected') {
      toast.success('Google Calendar connected', 'Your schedules are on their way.');
    } else {
      toast.error('Couldn’t connect Google Calendar', connectErrorMessage(reason));
    }
    setParams({}, { replace: true });
  }, [result, reason, setParams]);
}

function WeakSignal() {
  const { data } = useNetworkSettings();
  return data ? <ThresholdCard pct={data.weakSignalPct} /> : <Skeleton className="h-28" />;
}
