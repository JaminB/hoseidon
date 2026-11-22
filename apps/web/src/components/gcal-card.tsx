import { CalendarSync, Check, Copy, ExternalLink, RefreshCw, TriangleAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import type { GcalStatus } from '@hoseidon/shared';
import { GCAL_CONNECT_URL } from '../lib/api';
import { eventCounts, gcalPhase, reconnectHint, syncLabel } from '../lib/gcal';
import { useGcalDisconnect, useGcalLogRuns, useGcalResync, useGcalStatus } from '../lib/queries';
import { useNow } from '../lib/use-now';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardHeader } from './ui/card';
import { ConfirmDialog } from './ui/dialog';
import { Skeleton } from './ui/misc';
import { Switch } from './ui/switch';

const SETUP_GUIDE = 'https://github.com/JaminB/hoseidon#google-calendar-sync';

const PHASE_BADGE = {
  unconfigured: <Badge tone="outline">Not set up</Badge>,
  disconnected: <Badge>Not connected</Badge>,
  reconnect: <Badge tone="warn">Reconnect needed</Badge>,
  connected: <Badge tone="ok">Connected</Badge>,
};

/** Settings > Google Calendar: connect, sync status and controls. */
export function GcalCard() {
  const { data: s, isPending, isError } = useGcalStatus();
  const phase = s ? gcalPhase(s) : null;

  return (
    <Card data-testid="gcal-card">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <CalendarSync className="text-accent-strong size-4" /> Google Calendar
          </span>
        }
        description="Your schedules as recurring events in a dedicated “🔱 Hoseidon” calendar. One-way: Hoseidon → Google."
        actions={phase && PHASE_BADGE[phase]}
      />
      {isPending ? (
        <div className="space-y-2 px-5 pb-5">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-9 w-48" />
        </div>
      ) : isError || !s ? (
        <p className="text-danger px-5 pb-5 text-sm">Couldn’t load the calendar status.</p>
      ) : phase === 'unconfigured' ? (
        <Unconfigured s={s} />
      ) : phase === 'disconnected' ? (
        <Disconnected s={s} />
      ) : (
        <Connected s={s} />
      )}
    </Card>
  );
}

function Unconfigured({ s }: { s: GcalStatus }) {
  return (
    <div className="space-y-4 px-5 pb-5 text-sm">
      <p className="text-muted">
        Create an OAuth client in Google Cloud, then set{' '}
        {s.missing.map((m, i) => (
          <span key={m}>
            {i > 0 && (i === s.missing.length - 1 ? ' and ' : ', ')}
            <code className="bg-surface-2 rounded px-1 py-0.5 font-mono text-[12px]">{m}</code>
          </span>
        ))}{' '}
        in <code className="font-mono text-[12px]">.env</code> and restart Hoseidon.
      </p>
      <div>
        <div className="text-subtle mb-1.5 text-xs">
          Authorized redirect URI for the OAuth client
        </div>
        <RedirectUri uri={s.redirectUri} />
      </div>
      <Button asChild variant="secondary" size="sm">
        <a href={SETUP_GUIDE} target="_blank" rel="noreferrer">
          Setup guide <ExternalLink className="size-3.5" />
        </a>
      </Button>
    </div>
  );
}

function Disconnected({ s }: { s: GcalStatus }) {
  return (
    <div className="space-y-4 px-5 pb-5">
      <ul className="text-muted space-y-1.5 text-sm">
        <Bullet>Each schedule becomes a recurring event, with zones and times in the notes.</Bullet>
        <Bullet>Skipped runs show up greyed out, with the reason.</Bullet>
        <Bullet>Hoseidon only sees the calendar it creates, nothing else in your account.</Bullet>
      </ul>
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild variant="primary">
          <a href={GCAL_CONNECT_URL}>Connect Google Calendar</a>
        </Button>
        {s.calendarId && (
          <span className="text-subtle text-xs">Reconnecting picks up the existing calendar.</span>
        )}
      </div>
      <details className="text-subtle text-xs">
        <summary className="hover:text-fg cursor-pointer select-none">Redirect URI</summary>
        <div className="mt-2">
          <RedirectUri uri={s.redirectUri} />
        </div>
      </details>
    </div>
  );
}

function Connected({ s }: { s: GcalStatus }) {
  const now = useNow(15_000);
  const resync = useGcalResync();
  const disconnect = useGcalDisconnect();
  const logRuns = useGcalLogRuns();
  const [confirm, setConfirm] = useState(false);
  const hint = reconnectHint(s, now);
  const error = s.needsReconnect ? null : s.lastError;
  const busy = s.sync.state === 'running' || s.sync.state === 'pending' || resync.isPending;

  return (
    <>
      {s.needsReconnect && (
        <div className="px-5 pb-4">
          <div
            role="alert"
            className="bg-warn-soft text-warn-strong flex flex-wrap items-center gap-x-4 gap-y-3 rounded-lg px-4 py-3 text-[13px]"
          >
            <TriangleAlert className="size-4 shrink-0" />
            <p className="min-w-0 flex-1">
              <span className="font-medium">Sync is paused.</span> Google stopped accepting
              Hoseidon’s access. Apps in Testing mode have to reconnect every 7 days.
            </p>
            <Button asChild variant="primary" size="sm">
              <a href={GCAL_CONNECT_URL}>Reconnect</a>
            </Button>
          </div>
        </div>
      )}
      <dl className="divide-line border-line divide-y border-t text-sm">
        <Row label="Calendar">
          {s.calendarUrl ? (
            <a
              className="text-accent-strong inline-flex items-center gap-1 hover:underline"
              href={s.calendarUrl}
              target="_blank"
              rel="noreferrer"
            >
              🔱 Hoseidon <ExternalLink className="size-3.5" />
            </a>
          ) : (
            '—'
          )}
        </Row>
        <Row label="Status">
          <span className="inline-flex items-center gap-1.5">
            {busy ? (
              <RefreshCw className="text-accent-strong size-3.5 animate-spin" />
            ) : s.sync.state === 'backoff' ? (
              <TriangleAlert className="text-warn-strong size-3.5" />
            ) : !s.needsReconnect ? (
              <Check className="text-ok size-3.5" />
            ) : null}
            {s.needsReconnect ? 'Paused' : syncLabel(s, now)}
          </span>
        </Row>
        <Row label="In the calendar">{eventCounts(s)}</Row>
        <Row
          label={
            <span>
              Log finished runs
              <span className="text-subtle block text-xs">
                Adds what actually watered as past events
              </span>
            </span>
          }
        >
          <Switch
            label="Log finished runs"
            checked={logRuns.isPending ? (logRuns.variables ?? s.logRuns) : s.logRuns}
            onCheckedChange={(v) => logRuns.mutate(v)}
          />
        </Row>
      </dl>
      {(error || hint) && (
        <div className="border-line space-y-1 border-t px-5 py-3 text-[13px]">
          {error && <p className="text-danger break-words">{error}</p>}
          {hint && <p className="text-warn-strong">{hint}</p>}
        </div>
      )}
      <div className="border-line flex flex-wrap items-center gap-2 border-t px-5 py-3">
        {!s.needsReconnect && (
          <Button size="sm" onClick={() => resync.mutate()} loading={resync.isPending}>
            {!resync.isPending && <RefreshCw className="size-3.5" />} Resync everything
          </Button>
        )}
        {hint && !s.needsReconnect && (
          <Button asChild size="sm" variant="soft">
            <a href={GCAL_CONNECT_URL}>Reconnect</a>
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="hover:text-danger ml-auto"
          onClick={() => setConfirm(true)}
          loading={disconnect.isPending}
        >
          Disconnect
        </Button>
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Disconnect Google Calendar?"
        description="Hoseidon stops updating the calendar and forgets its access. The calendar and its events stay in your Google account."
        confirmLabel="Disconnect"
        onConfirm={() => disconnect.mutate()}
      />
    </>
  );
}

function RedirectUri({ uri }: { uri: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="bg-surface-2 border-line flex items-center gap-2 rounded-lg border py-1.5 pr-1.5 pl-3">
      <code className="min-w-0 flex-1 truncate font-mono text-[12px]" title={uri}>
        {uri}
      </code>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Copy redirect URI"
        onClick={() => {
          void navigator.clipboard?.writeText(uri).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check className="text-ok size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
    </div>
  );
}

function Bullet({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-2">
      <Check className="text-accent-strong mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </li>
  );
}

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3">
      <dt className="text-muted">{label}</dt>
      <dd className="tnum text-right">{children}</dd>
    </div>
  );
}

/** App-wide strip when Google has dropped the connection. Hidden on Settings (the card says it). */
export function GcalReconnectBanner() {
  const { data } = useGcalStatus();
  const { pathname } = useLocation();
  if (!data?.needsReconnect || pathname.startsWith('/settings')) return null;
  return (
    <div
      role="status"
      className="bg-warn-soft text-warn-strong border-warn/20 flex items-center gap-3 border-b px-4 py-2 text-[13px] md:px-8"
    >
      <TriangleAlert className="size-4 shrink-0" />
      <p className="min-w-0 flex-1">
        <span className="font-medium">Google Calendar sync is paused.</span>{' '}
        <span className="hidden sm:inline">Reconnect to keep your calendar up to date.</span>
      </p>
      <Link to="/settings" className="shrink-0 font-medium underline-offset-2 hover:underline">
        Reconnect
      </Link>
    </div>
  );
}
