import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, BellOff } from 'lucide-react';
import { PUSH_CATEGORIES, PUSH_CATEGORY_LABEL } from '@hoseidon/shared';
import { api } from '../../lib/api';
import { disablePush, enablePush, pushState, type PushState } from '../../lib/push';
import { usePushPrefs, usePushStatus } from '../../lib/queries';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardHeader } from '../ui/card';
import { Switch } from '../ui/switch';
import { toast } from '../ui/toast';
import { Row } from './row';

const STATE_NOTE: Record<PushState, string | null> = {
  unsupported:
    'This browser can’t receive push notifications. On iPhone, add Hoseidon to your Home Screen first.',
  denied: 'Notifications are blocked for this site. Allow them in your browser’s site settings.',
  off: null,
  on: null,
};

/** Settings > Notifications: subscribe this device, and choose what is worth a buzz. */
export function NotificationsCard() {
  const qc = useQueryClient();
  const status = usePushStatus();
  const prefs = usePushPrefs();
  const state = useQuery({ queryKey: ['push-state'], queryFn: pushState, staleTime: 0 });

  const toggle = useMutation({
    mutationFn: async (on: boolean) => {
      if (on) await enablePush(status.data!.publicKey);
      else await disablePush();
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['push'] });
      void qc.invalidateQueries({ queryKey: ['push-state'] });
    },
    onError: (err) =>
      toast.error('Notifications', err instanceof Error ? err.message : String(err)),
  });
  const test = useMutation({
    mutationFn: api.pushTest,
    onSuccess: (r) =>
      r.failed
        ? toast.error(
            'Test failed',
            `${r.failed} of ${r.sent + r.failed} devices did not accept it.`,
          )
        : toast.success('Sent', 'It should arrive in a moment.'),
    onError: (err) => toast.error('Test failed', err instanceof Error ? err.message : String(err)),
  });

  const here = state.data ?? 'off';
  const available = here === 'on' || here === 'off';
  const note = STATE_NOTE[here];

  return (
    <Card data-testid="notifications-card">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Bell className="text-accent-strong size-4" /> Notifications
          </span>
        }
        description="Push alerts to this device, even when Hoseidon is closed."
        actions={
          status.data && (
            <Badge tone={status.data.subscriptions ? 'ok' : 'outline'}>
              {status.data.subscriptions
                ? `${status.data.subscriptions} device${status.data.subscriptions === 1 ? '' : 's'}`
                : 'No devices'}
            </Badge>
          )
        }
      />
      <dl className="divide-line border-line divide-y border-t">
        <Row label="This device" hint={note ?? undefined}>
          <Switch
            label="Notifications on this device"
            checked={here === 'on'}
            onCheckedChange={(on) => toggle.mutate(on)}
            className={
              !available || toggle.isPending || !status.data ? 'pointer-events-none opacity-50' : ''
            }
          />
        </Row>
        {PUSH_CATEGORIES.map((c) => (
          <Row key={c} label={PUSH_CATEGORY_LABEL[c].label} hint={PUSH_CATEGORY_LABEL[c].hint}>
            <Switch
              label={`Notify for ${PUSH_CATEGORY_LABEL[c].label.toLowerCase()}`}
              checked={status.data?.prefs[c] ?? false}
              onCheckedChange={(v) => prefs.mutate({ [c]: v })}
              className={status.data ? '' : 'pointer-events-none opacity-50'}
            />
          </Row>
        ))}
      </dl>
      <div className="border-line flex items-center justify-between gap-3 border-t px-5 py-3">
        <p className="text-subtle flex items-center gap-1.5 text-xs">
          <BellOff className="size-3.5" /> Applies to every subscribed device.
        </p>
        <Button
          size="sm"
          loading={test.isPending}
          disabled={here !== 'on'}
          onClick={() => test.mutate()}
        >
          Send test
        </Button>
      </div>
    </Card>
  );
}
