import type { PushCategory, PushPayload } from '@hoseidon/shared';

export interface PushableEvent {
  type: string;
  title: string;
  message: string | null;
  gatewayId: string | null;
  deviceId: string | null;
}

/**
 * Which notification setting governs an event, or null if it never notifies. Our own events have
 * exact types; LinkTap webhook events (`linktap.<name>`) are matched loosely because the exact
 * names are unverified.
 */
export function pushCategory(type: string): PushCategory | null {
  switch (type) {
    case 'device.alarm':
      return 'alarm';
    case 'gateway.offline':
    case 'device.offline':
      return 'offline';
    case 'schedule.run_failed':
    case 'schedule.missed':
      return 'failed';
    case 'schedule.skipped':
      return 'skipped';
  }
  if (!type.startsWith('linktap.')) return null;
  const e = type.slice('linktap.'.length).toLowerCase();
  if (/clear|resolved|dismiss/.test(e)) return null;
  if (/offline/.test(e)) return 'offline';
  if (/alarm|broken|fall|leak|clog|nowater|no_water|cut.?off/.test(e)) return 'alarm';
  return null;
}

const URL_FOR: Record<PushCategory, string> = {
  alarm: '/devices',
  offline: '/network',
  failed: '/',
  skipped: '/schedule',
};

export function pushPayload(category: PushCategory, e: PushableEvent): PushPayload {
  return {
    title: e.title,
    body: e.message ?? '',
    // Same tag: a repeat replaces the earlier notification instead of stacking.
    tag: `${category}:${e.deviceId ?? e.gatewayId ?? e.type}`,
    url: URL_FOR[category],
  };
}
