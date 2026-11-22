import type { Diagnosis, DiagnosisCheck, WorkMode } from '@hoseidon/shared';
import { isPlanMode } from '../linktap/normalize';
import { GAP_MS } from './metrics';

const MIN = 60_000;
const HOUR = 60 * MIN;
const BATTERY_WARN_PCT = 20;
const BATTERY_FAIL_PCT = 10;

export interface DiagnoseInput {
  now: number;
  device: {
    id: string;
    name: string;
    online: boolean;
    lastSeenAt: number | null;
    signalPct: number | null;
    batteryPct: number | null;
    alarms: string[];
    workMode: WorkMode | null;
  };
  gateway: { name: string; online: boolean; lastSeenAt: number | null } | null;
  weakSignalPct: number;
  /** Newest snapshot for this device. */
  lastSnapshotAt: number | null;
  /** Failed scheduled starts in the last 7 days, newest first. */
  failedStarts: Array<{ at: number; error: string | null }>;
  webhook: { configured: boolean; lastEventAt: number | null };
  /** Most recent getAllDevices outcome, from the client's call stats. */
  cloud: { lastOkAt: number | null; lastErrorAt: number | null; lastError: string | null };
  batteryDaysLeft: number | null;
}

const ago = (ms: number) => {
  const min = Math.round(ms / MIN);
  if (min < 60) return `${Math.max(1, min)} min`;
  const h = Math.round(ms / HOUR);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
};

const check = (
  id: string,
  label: string,
  status: DiagnosisCheck['status'],
  detail: string,
  fix: string | null = null,
): DiagnosisCheck => ({ id, label, status, detail, fix: status === 'pass' ? null : fix });

/**
 * Runs the troubleshooting checklist for one timer. Pure: the caller gathers the facts. Fixes are
 * written for a person standing in the yard, not a developer.
 */
export function diagnose(i: DiagnoseInput): Diagnosis {
  const { device: d, gateway: g, now } = i;
  const checks: DiagnosisCheck[] = [];

  // 1. Gateway
  if (!g) {
    checks.push(
      check('gateway', 'Gateway is online', 'unknown', 'This timer has no known gateway.'),
    );
  } else if (g.online) {
    checks.push(
      check('gateway', 'Gateway is online', 'pass', `${g.name} is connected to LinkTap.`),
    );
  } else {
    const seen = g.lastSeenAt ? ` Last seen ${ago(now - g.lastSeenAt)} ago.` : '';
    checks.push(
      check(
        'gateway',
        'Gateway is online',
        'fail',
        `${g.name} is offline.${seen}`,
        'Check the gateway has power and a Wi-Fi or Ethernet link. Unplug it for 10 seconds and plug it back in, then give it a few minutes to reconnect.',
      ),
    );
  }
  const gatewayDown = g !== null && !g.online;

  // 2. Timer
  if (d.online) {
    checks.push(check('device', 'Timer is online', 'pass', `${d.name} is reachable.`));
  } else if (gatewayDown) {
    checks.push(
      check(
        'device',
        'Timer is online',
        'fail',
        `${d.name} shows as offline because its gateway is.`,
        'Fix the gateway first; the timer should follow on its own.',
      ),
    );
  } else {
    const seen = d.lastSeenAt ? ` Last seen ${ago(now - d.lastSeenAt)} ago.` : '';
    checks.push(
      check(
        'device',
        'Timer is online',
        'fail',
        `${d.name} is not responding.${seen}`,
        'Check its batteries, and that it is within range of the gateway (ideally a few metres, without walls or metal between). Pressing its button should make it reconnect.',
      ),
    );
  }

  // 3. Signal
  if (!d.online) {
    checks.push(
      check(
        'signal',
        'Signal is strong',
        'unknown',
        'Signal is only reported while the timer is online.',
      ),
    );
  } else if (d.signalPct === null) {
    checks.push(
      check('signal', 'Signal is strong', 'unknown', 'LinkTap did not report a signal level.'),
    );
  } else if (d.signalPct < i.weakSignalPct) {
    checks.push(
      check(
        'signal',
        'Signal is strong',
        d.signalPct < i.weakSignalPct / 2 ? 'fail' : 'warn',
        `Signal is ${Math.round(d.signalPct)}%, below your ${i.weakSignalPct}% threshold.`,
        'Move the gateway closer to the timer or raise it off the ground. LinkTap sells range extenders, but they do not report to the API, so Hoseidon cannot see them.',
      ),
    );
  } else {
    checks.push(
      check('signal', 'Signal is strong', 'pass', `Signal is ${Math.round(d.signalPct)}%.`),
    );
  }

  // 4. Battery
  if (d.batteryPct === null) {
    checks.push(
      check('battery', 'Battery is healthy', 'unknown', 'LinkTap did not report a battery level.'),
    );
  } else if (d.batteryPct < BATTERY_WARN_PCT) {
    const left =
      i.batteryDaysLeft !== null
        ? ` At the current rate that is about ${i.batteryDaysLeft} days.`
        : '';
    checks.push(
      check(
        'battery',
        'Battery is healthy',
        d.batteryPct < BATTERY_FAIL_PCT ? 'fail' : 'warn',
        `Battery is ${Math.round(d.batteryPct)}%.${left}`,
        'Swap in fresh AA batteries soon. A low battery can make a timer miss a scheduled run or drop off the network.',
      ),
    );
  } else {
    checks.push(
      check('battery', 'Battery is healthy', 'pass', `Battery is ${Math.round(d.batteryPct)}%.`),
    );
  }

  // 5. Alarms
  if (d.alarms.length) {
    checks.push(
      check(
        'alarms',
        'No active alarms',
        'fail',
        `Active: ${d.alarms.join(', ')}.`,
        'Fix the cause (turn the water on, reseat the valve, check the pipe), then dismiss the alarm from the Devices page.',
      ),
    );
  } else {
    checks.push(
      check('alarms', 'No active alarms', 'pass', 'LinkTap is not reporting any alarms.'),
    );
  }

  // 6. LinkTap plan conflict
  if (isPlanMode(d.workMode)) {
    checks.push(
      check(
        'plan',
        'No LinkTap plan in the way',
        'warn',
        'A watering plan from the LinkTap app is active on this timer.',
        'It will run alongside Hoseidon schedules and may water twice. Switch the timer to Instant mode in the LinkTap app, or delete its plan there.',
      ),
    );
  } else {
    checks.push(
      check(
        'plan',
        'No LinkTap plan in the way',
        'pass',
        'Hoseidon is the only thing scheduling this timer.',
      ),
    );
  }

  // 7. Data age
  if (i.lastSnapshotAt === null) {
    checks.push(
      check(
        'freshness',
        'Data is fresh',
        'fail',
        'Hoseidon has never received data for this timer.',
        'Check the LinkTap username and API key in your settings and that the server can reach link-tap.com.',
      ),
    );
  } else {
    const age = now - i.lastSnapshotAt;
    const status = age > 3 * HOUR ? 'fail' : age > GAP_MS ? 'warn' : 'pass';
    checks.push(
      check(
        'freshness',
        'Data is fresh',
        status,
        `Last update from LinkTap was ${ago(age)} ago.`,
        'Hoseidon polls LinkTap every 5 minutes. If this stays stale, the server may be down or LinkTap may be rejecting the API key.',
      ),
    );
  }

  // 8. Cloud API
  const { cloud } = i;
  if (
    cloud.lastErrorAt !== null &&
    (cloud.lastOkAt === null || cloud.lastErrorAt > cloud.lastOkAt)
  ) {
    checks.push(
      check(
        'cloud',
        'LinkTap cloud is reachable',
        'fail',
        `The last device poll failed${cloud.lastError ? `: ${cloud.lastError}` : '.'}`,
        'Check the API key, and status.link-tap.com for an outage. Hoseidon keeps retrying on its own.',
      ),
    );
  } else if (cloud.lastOkAt === null) {
    checks.push(
      check(
        'cloud',
        'LinkTap cloud is reachable',
        'unknown',
        'No poll has finished since the server started.',
      ),
    );
  } else {
    checks.push(
      check(
        'cloud',
        'LinkTap cloud is reachable',
        'pass',
        `Last poll succeeded ${ago(now - cloud.lastOkAt)} ago.`,
      ),
    );
  }

  // 9. Failed starts
  if (i.failedStarts.length) {
    const latest = i.failedStarts[0]!;
    checks.push(
      check(
        'starts',
        'Recent runs started fine',
        'fail',
        `${i.failedStarts.length} scheduled run${i.failedStarts.length === 1 ? '' : 's'} failed in the last 7 days. The latest was ${ago(now - latest.at)} ago${latest.error ? `: ${latest.error}` : '.'}`,
        'Usually the timer was offline or out of water when the run was due. Fix whatever the checks above found, then watch the next scheduled run.',
      ),
    );
  } else {
    checks.push(
      check('starts', 'Recent runs started fine', 'pass', 'No failed starts in the last 7 days.'),
    );
  }

  // 10. Webhook
  if (!i.webhook.configured) {
    checks.push(
      check(
        'webhook',
        'Webhook is set up',
        'warn',
        'No webhook secret is configured, so LinkTap cannot push alerts to Hoseidon.',
        'Set WEBHOOK_SECRET and add the webhook URL in the LinkTap app. Without it, offline and alarm news can take up to 5 minutes to arrive.',
      ),
    );
  } else if (i.webhook.lastEventAt === null) {
    checks.push(
      check(
        'webhook',
        'Webhook is set up',
        'warn',
        'A secret is set, but LinkTap has never called the webhook.',
        'Add https://<your-host>/hooks/linktap/<secret> as the webhook URL in the LinkTap app, and make sure it is reachable from the internet (a Cloudflare Tunnel works).',
      ),
    );
  } else {
    checks.push(
      check(
        'webhook',
        'Webhook is set up',
        'pass',
        `Last webhook arrived ${ago(now - i.webhook.lastEventAt)} ago.`,
      ),
    );
  }

  const fails = checks.filter((c) => c.status === 'fail');
  const warns = checks.filter((c) => c.status === 'warn');
  const verdict = fails.length ? 'fail' : warns.length ? 'warn' : 'ok';
  const summary =
    verdict === 'ok'
      ? `${d.name} looks healthy.`
      : verdict === 'fail'
        ? `${fails.length} problem${fails.length === 1 ? '' : 's'} found. Start with: ${fails[0]!.detail}`
        : `${warns.length} thing${warns.length === 1 ? '' : 's'} worth a look.`;
  return {
    deviceId: d.id,
    deviceName: d.name,
    generatedAt: new Date(now).toISOString(),
    verdict,
    summary,
    checks,
  };
}
