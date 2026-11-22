import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Eye, EyeOff, PlugZap, Webhook } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../lib/api';
import { formatRelative } from '../../lib/format';
import { useHealth, useLinkTapStatus, useWebhookInfo } from '../../lib/queries';
import { useNow } from '../../lib/use-now';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardHeader } from '../ui/card';
import { ConfirmDialog } from '../ui/dialog';
import { toast } from '../ui/toast';
import { Row } from './row';

const hide = (url: string) => url.replace(/(\/hooks\/linktap\/).+$/, '$1••••••••');

/** Settings > LinkTap: rate limits, a connection test, and the webhook address. */
export function LinktapCard() {
  const health = useHealth();
  const status = useLinkTapStatus();
  const now = useNow(1000);

  const wait = (iso?: string) => {
    if (!iso) return '—';
    const s = Math.ceil((Date.parse(iso) - now) / 1000);
    return s > 0 ? `in ${s < 90 ? `${s} s` : `${Math.ceil(s / 60)} min`}` : 'Ready';
  };

  const test = useMutation({ mutationFn: api.linktapTest });

  return (
    <Card data-testid="linktap-card">
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
        <div className="space-y-2 px-5 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 text-sm">
              <div>Connection</div>
              <p
                className={`mt-0.5 text-xs ${test.data && !test.data.ok ? 'text-danger' : 'text-subtle'}`}
                role="status"
              >
                {test.isError
                  ? test.error.message
                  : test.data
                    ? `${test.data.message}${test.data.ok ? ` ${test.data.gateways} gateway${test.data.gateways === 1 ? '' : 's'}, ${test.data.devices} timers.` : ''}`
                    : 'Checks your username and API key by listing your devices.'}
              </p>
            </div>
            <Button size="sm" loading={test.isPending} onClick={() => test.mutate()}>
              <PlugZap className="size-3.5" /> Test
            </Button>
          </div>
        </div>
        <WebhookRow />
      </dl>
    </Card>
  );
}

function WebhookRow() {
  const qc = useQueryClient();
  const info = useWebhookInfo();
  const [reveal, setReveal] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const register = useMutation({
    mutationFn: api.registerWebhook,
    onSuccess: () => {
      toast.success('Webhook registered', 'LinkTap will now push events to Hoseidon.');
      void qc.invalidateQueries({ queryKey: ['webhook'] });
    },
    onError: (err) =>
      toast.error('Could not register', err instanceof Error ? err.message : String(err)),
  });

  const url = info.data?.url ?? null;
  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Could not copy', 'Select the address and copy it by hand.');
    }
  };

  return (
    <div className="space-y-2.5 px-5 py-3 text-sm">
      <div className="flex items-center gap-2">
        <Webhook className="text-muted size-4" />
        <span>Webhook</span>
      </div>
      {!info.data ? null : url ? (
        <div className="flex items-center gap-1.5">
          <code
            className="bg-surface-2 border-line min-w-0 flex-1 truncate rounded-md border px-2.5 py-1.5 font-mono text-xs"
            data-testid="webhook-url"
          >
            {reveal ? url : hide(url)}
          </code>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={reveal ? 'Hide address' : 'Show address'}
            onClick={() => setReveal((r) => !r)}
          >
            {reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Copy address"
            onClick={() => void copy()}
          >
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          </Button>
        </div>
      ) : (
        <p className="text-subtle text-xs">Set WEBHOOK_SECRET to get a webhook address.</p>
      )}
      <div className="flex items-center justify-between gap-3">
        <p className="text-subtle text-xs">
          {info.data?.blockedReason ??
            'LinkTap allows one webhook per account. Registering replaces any existing one.'}
        </p>
        <Button
          size="sm"
          disabled={!info.data || !!info.data.blockedReason}
          loading={register.isPending}
          onClick={() => setConfirm(true)}
        >
          Register
        </Button>
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Register the webhook with LinkTap?"
        description="This tells your LinkTap account to send events to this server, replacing any webhook already set (including one used by another app)."
        confirmLabel="Register"
        onConfirm={() => register.mutate()}
      />
    </div>
  );
}
