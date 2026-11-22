import { useQueryClient } from '@tanstack/react-query';
import { CloudOff } from 'lucide-react';
import { lastUpdatedAt, offlineMessage, useOnline } from '../lib/offline';
import { useHealth } from '../lib/queries';
import { useNow } from '../lib/use-now';

/** A thin strip under the top of the page while offline or while the server can't be reached. */
export function OfflineBanner() {
  const online = useOnline();
  const health = useHealth();
  const qc = useQueryClient();
  const now = useNow(30_000);
  const message = offlineMessage(
    {
      online,
      // A failed health check only counts once there is no fresh answer to fall back on.
      serverUp: !health.isError,
      lastUpdated: lastUpdatedAt(qc.getQueryCache().getAll()),
    },
    now,
  );
  if (!message) return null;
  return (
    <div
      role="status"
      className="bg-warn-soft text-warn-strong border-line flex items-center justify-center gap-2 border-b px-4 py-2 text-[13px] font-medium"
    >
      <CloudOff className="size-4 shrink-0" />
      <span>{message}</span>
    </div>
  );
}
