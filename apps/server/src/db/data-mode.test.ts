import { describe, expect, it } from 'vitest';
import { openDb } from './index';
import { purgeOnLinkTapModeChange } from './data-mode';
import { getSetting, setSetting } from './kv';
import { devices, gateways } from './schema';
import { MOCK_IDS } from '../linktap/mock';

function seed(db: ReturnType<typeof openDb>['db'], gatewayId: string, deviceId: string) {
  db.insert(gateways)
    .values({
      id: gatewayId,
      linktapName: 'gw',
      updatedAt: new Date(),
    } as typeof gateways.$inferInsert)
    .run();
  db.insert(devices)
    .values({
      id: deviceId,
      gatewayId,
      linktapName: 'tl',
      updatedAt: new Date(),
    } as typeof devices.$inferInsert)
    .run();
}

describe('purgeOnLinkTapModeChange', () => {
  it('wipes mock leftovers on a database from before the marker existed', () => {
    const { db } = openDb(':memory:');
    seed(db, MOCK_IDS.backyard, MOCK_IDS.frontLawn);
    setSetting(db, 'linktap.lastCall', '{"devices":1}');
    expect(purgeOnLinkTapModeChange(db, false)).toBe(true);
    expect(db.select().from(gateways).all()).toEqual([]);
    expect(db.select().from(devices).all()).toEqual([]);
    expect(getSetting(db, 'linktap.dataMode')).toBe('real');
    expect(getSetting(db, 'linktap.lastCall')).toBe('{"devices":1}');
  });

  it('keeps real data on a database from before the marker existed', () => {
    const { db } = openDb(':memory:');
    seed(db, 'REALGW0000000001', 'REALTL0000000001');
    expect(purgeOnLinkTapModeChange(db, false)).toBe(false);
    expect(db.select().from(gateways).all()).toHaveLength(1);
  });

  it('wipes when the source flips and is a no-op when it stays the same', () => {
    const { db } = openDb(':memory:');
    expect(purgeOnLinkTapModeChange(db, true)).toBe(false);
    seed(db, MOCK_IDS.garage, MOCK_IDS.sideYard);
    expect(purgeOnLinkTapModeChange(db, true)).toBe(false);
    expect(db.select().from(gateways).all()).toHaveLength(1);
    expect(purgeOnLinkTapModeChange(db, false)).toBe(true);
    expect(db.select().from(gateways).all()).toEqual([]);
  });
});
