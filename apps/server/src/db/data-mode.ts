import { inArray } from 'drizzle-orm';
import { MOCK_IDS } from '../linktap/mock';
import { getSetting, setSetting } from './kv';
import {
  deviceSnapshots,
  devices,
  events,
  gateways,
  plannedRuns,
  runs,
  schedules,
  weatherDaily,
} from './schema';
import type { Db } from './types';

const MODE_KEY = 'linktap.dataMode';

/**
 * Device data from the mock LinkTap must never mix with a real account (and vice versa): fake
 * gateways would linger next to the real ones, with fake runs that never end. Remember which
 * source filled the database and wipe all device data when it changes. Auth, push and Google
 * settings are kept, and so are the LinkTap rate-limit times (the real API counts them).
 *
 * Returns true when data was wiped.
 */
export function purgeOnLinkTapModeChange(
  db: Db,
  mock: boolean,
  log?: (msg: string) => void,
): boolean {
  const current = mock ? 'mock' : 'real';
  const stored = getSetting(db, MODE_KEY);
  // Databases from before this marker existed: only a real install with mock leftovers is dirty.
  const dirty =
    stored !== undefined
      ? stored !== current
      : !mock &&
        db
          .select({ id: gateways.id })
          .from(gateways)
          .where(inArray(gateways.id, [MOCK_IDS.backyard, MOCK_IDS.garage]))
          .all().length > 0;
  if (dirty) {
    // Children first, so this works with or without foreign-key enforcement.
    db.delete(plannedRuns).run();
    db.delete(schedules).run();
    db.delete(runs).run();
    db.delete(deviceSnapshots).run();
    db.delete(events).run();
    db.delete(devices).run();
    db.delete(gateways).run();
    db.delete(weatherDaily).run();
    log?.(`LinkTap source changed to ${current}: cleared device data from the previous source`);
  }
  if (stored !== current) setSetting(db, MODE_KEY, current);
  return dirty;
}
