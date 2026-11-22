import { Monitor, Moon, Sun } from 'lucide-react';
import type { ReactNode } from 'react';
import { Page, PageHeader } from '../components/layout/app-shell';
import { Badge } from '../components/ui/badge';
import { Card, CardHeader } from '../components/ui/card';
import { Segmented } from '../components/ui/tabs';
import { formatRelative } from '../lib/format';
import { useHealth, useLinkTapStatus } from '../lib/queries';
import { useNow } from '../lib/use-now';
import { useTheme } from '../lib/theme';

export function SettingsPage() {
  const [theme, setTheme] = useTheme();
  const health = useHealth();
  const status = useLinkTapStatus();
  const now = useNow(1000);

  const wait = (iso?: string) => {
    if (!iso) return '—';
    const s = Math.ceil((Date.parse(iso) - now) / 1000);
    return s > 0 ? `in ${s < 90 ? `${s} s` : `${Math.ceil(s / 60)} min`}` : 'Ready';
  };

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

        <Card>
          <CardHeader
            title="LinkTap"
            description="Hoseidon talks to the LinkTap cloud and respects its rate limits."
            actions={
              health.data && (
                <Badge tone={health.data.mock ? 'warn' : 'ok'}>
                  {health.data.mock ? 'Mock mode' : 'Live'}
                </Badge>
              )
            }
          />
          <dl className="divide-line border-line divide-y border-t">
            <Row label="Next device refresh">{wait(status.data?.nextAvailableAt.devices)}</Row>
            <Row label="Next command slot">{wait(status.data?.nextAvailableAt.command)}</Row>
            <Row label="Next history fetch">{wait(status.data?.nextAvailableAt.history)}</Row>
            <Row label="Last device poll">
              {status.data?.poller?.last.devices?.at
                ? formatRelative(status.data.poller.last.devices.at, now)
                : '—'}
            </Row>
          </dl>
        </Card>

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

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3 text-sm">
      <dt className="text-muted">{label}</dt>
      <dd className="tnum text-right">{children}</dd>
    </div>
  );
}
