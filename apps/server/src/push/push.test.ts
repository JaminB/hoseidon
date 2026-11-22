import { describe, expect, it, vi } from 'vitest';
import type { PushPayload } from '@hoseidon/shared';
import { events, pushSubscriptions, type NewEvent } from '../db/schema';
import { harness } from '../test-utils';
import { pushCategory } from './classify';
import type { PushSender } from './service';

const SUB = { endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } };
const SUB2 = { endpoint: 'https://push.example/def', keys: { p256dh: 'p2', auth: 'a2' } };

function setup(send?: PushSender) {
  const sent: { endpoint: string; payload: PushPayload }[] = [];
  const sender: PushSender =
    send ??
    ((sub, body) => {
      sent.push({ endpoint: sub.endpoint, payload: JSON.parse(body) as PushPayload });
      return Promise.resolve();
    });
  const h = harness({ pushSend: sender });
  h.push.subscribe(SUB);
  return { ...h, sent };
}

const ev = (over: Partial<NewEvent> & Pick<NewEvent, 'type'>): NewEvent => ({
  at: new Date(),
  source: 'poller',
  severity: 'alert',
  title: over.type,
  gatewayId: 'G1',
  deviceId: null,
  ...over,
});

describe('pushCategory', () => {
  it('maps our own event types', () => {
    expect(pushCategory('device.alarm')).toBe('alarm');
    expect(pushCategory('gateway.offline')).toBe('offline');
    expect(pushCategory('device.offline')).toBe('offline');
    expect(pushCategory('schedule.run_failed')).toBe('failed');
    expect(pushCategory('schedule.missed')).toBe('failed');
    expect(pushCategory('schedule.skipped')).toBe('skipped');
  });

  it('ignores recoveries and chatter', () => {
    for (const t of [
      'device.online',
      'gateway.online',
      'device.alarm_cleared',
      'device.signal_low',
      'device.battery_low',
      'linktap.alarmCleared',
      'linktap.wateringStart',
    ]) {
      expect(pushCategory(t)).toBeNull();
    }
  });

  it('matches LinkTap webhook names loosely', () => {
    expect(pushCategory('linktap.deviceOffline')).toBe('offline');
    expect(pushCategory('linktap.valveBroken')).toBe('alarm');
    expect(pushCategory('linktap.noWater')).toBe('alarm');
    expect(pushCategory('linktap.fallAlarm')).toBe('alarm');
  });
});

describe('PushService.flush', () => {
  it('starts from now: history is not replayed on first run', async () => {
    const { db, push, sent } = setup();
    db.insert(events)
      .values(ev({ type: 'device.alarm' }))
      .run();
    await push.flush(); // sets the cursor
    await push.flush();
    expect(sent).toHaveLength(0);
  });

  it('notifies once for new alarm, offline and failed events', async () => {
    const { db, push, sent } = setup();
    await push.flush();
    db.insert(events)
      .values([
        ev({ type: 'device.alarm', title: 'Veggies: no water', deviceId: 'D1' }),
        ev({ type: 'gateway.offline', title: 'Backyard offline' }),
        ev({ type: 'schedule.run_failed', title: 'Lawn failed', message: 'valve stuck' }),
        ev({ type: 'device.online' }),
      ])
      .run();
    await push.flush();
    expect(sent.map((s) => s.payload.title)).toEqual([
      'Veggies: no water',
      'Backyard offline',
      'Lawn failed',
    ]);
    expect(sent[2]!.payload.body).toBe('valve stuck');
    expect(sent[0]!.payload.url).toBe('/devices');
    await push.flush();
    expect(sent).toHaveLength(3); // nothing new, nothing resent
  });

  it('respects per-type preferences (skipped is off by default)', async () => {
    const { db, push, sent } = setup();
    await push.flush();
    db.insert(events)
      .values(ev({ type: 'schedule.skipped', title: 'Skipped: rain' }))
      .run();
    await push.flush();
    expect(sent).toHaveLength(0);

    push.setPrefs({ skipped: true, alarm: false });
    db.insert(events)
      .values([
        ev({ type: 'schedule.skipped', title: 'Skipped: freeze' }),
        ev({ type: 'device.alarm', title: 'muted alarm' }),
      ])
      .run();
    await push.flush();
    expect(sent.map((s) => s.payload.title)).toEqual(['Skipped: freeze']);
  });

  it('does not buzz twice for the same thing reported by webhook and poller', async () => {
    const { db, push, sent } = setup();
    await push.flush();
    db.insert(events)
      .values([
        ev({ type: 'device.offline', deviceId: 'D1', title: 'poller says offline' }),
        ev({ type: 'linktap.deviceOffline', deviceId: 'D1', source: 'webhook', title: 'hook' }),
      ])
      .run();
    await push.flush();
    expect(sent).toHaveLength(1);
  });

  it('collapses a burst into a summary', async () => {
    const { db, push, sent } = setup();
    await push.flush();
    db.insert(events)
      .values(
        Array.from({ length: 8 }, (_, i) =>
          ev({ type: 'device.offline', deviceId: `D${i}`, title: `Timer ${i} offline` }),
        ),
      )
      .run();
    await push.flush();
    expect(sent).toHaveLength(4);
    expect(sent[3]!.payload.title).toBe('5 more alerts');
    expect(sent[3]!.payload.body).toContain('Timer 7 offline');
  });

  it('sends to every subscription and forgets ones the push service reports gone', async () => {
    const send: PushSender = vi.fn((sub) =>
      sub.endpoint === SUB2.endpoint
        ? Promise.reject(Object.assign(new Error('gone'), { statusCode: 410 }))
        : Promise.resolve(),
    );
    const { db, push } = setup(send);
    push.subscribe(SUB2);
    await push.flush();
    db.insert(events)
      .values(ev({ type: 'device.alarm', deviceId: 'D1' }))
      .run();
    await push.flush();
    expect(send).toHaveBeenCalledTimes(2);
    const left = db.select().from(pushSubscriptions).all();
    expect(left.map((s) => s.endpoint)).toEqual([SUB.endpoint]);
  });

  it('keeps a subscription after a transient failure', async () => {
    const send: PushSender = vi.fn(() =>
      Promise.reject(Object.assign(new Error('timeout'), { statusCode: 503 })),
    );
    const { push, db } = setup(send);
    await push.flush();
    db.insert(events)
      .values(ev({ type: 'device.alarm', deviceId: 'D1' }))
      .run();
    await push.flush();
    expect(db.select().from(pushSubscriptions).all()).toHaveLength(1);
  });

  it('passes VAPID details with a contact subject', async () => {
    const send = vi.fn<PushSender>(() => Promise.resolve());
    const { push } = setup(send);
    await push.sendTest();
    const vapid = send.mock.calls[0]![2];
    expect(vapid.publicKey).toMatch(/^[\w-]{80,}$/);
    expect(vapid.subject).toMatch(/^(mailto:|https:)/);
  });
});

describe('push API', () => {
  const json = (body: unknown) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hoseidon-csrf': '1' },
    body: JSON.stringify(body),
  });

  it('generates VAPID keys once and keeps them', async () => {
    const { app } = harness();
    const a = await (await app.request('/api/push')).json();
    const b = await (await app.request('/api/push')).json();
    expect(a.publicKey).toBe(b.publicKey);
    expect(a.subscriptions).toBe(0);
    expect(a.prefs).toEqual({ alarm: true, offline: true, failed: true, skipped: false });
  });

  it('subscribes, updates prefs, and unsubscribes', async () => {
    const { app } = harness();
    let status = await (await app.request('/api/push/subscribe', json(SUB))).json();
    expect(status.subscriptions).toBe(1);
    status = await (
      await app.request('/api/push/prefs', { ...json({ skipped: true }), method: 'PATCH' })
    ).json();
    expect(status.prefs).toEqual({ alarm: true, offline: true, failed: true, skipped: true });
    status = await (
      await app.request('/api/push/unsubscribe', json({ endpoint: SUB.endpoint }))
    ).json();
    expect(status.subscriptions).toBe(0);
  });

  it('validates the subscription and refuses a test with no devices', async () => {
    const { app } = harness();
    expect((await app.request('/api/push/subscribe', json({ endpoint: 'nope' }))).status).toBe(400);
    expect((await app.request('/api/push/test', json({}))).status).toBe(409);
  });

  it('sends a test notification', async () => {
    const send = vi.fn<PushSender>(() => Promise.resolve());
    const { app, push } = harness({ pushSend: send });
    push.subscribe(SUB);
    const res = await app.request('/api/push/test', json({}));
    expect(await res.json()).toEqual({ sent: 1, failed: 0 });
  });
});
