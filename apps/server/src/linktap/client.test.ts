import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLinkTapClient, isRateLimitError, isRateLimitMessage, LinkTapError } from './client';
import { LinkTapMock, MOCK_IDS } from './mock';

const lawn = { gatewayId: MOCK_IDS.backyard, taplinkerId: MOCK_IDS.frontLawn };

function setup(opts: { realLimits?: boolean; username?: string } = {}) {
  const mock = new LinkTapMock({ enforceRateLimits: opts.realLimits ?? false, timeZone: 'UTC' });
  const zero = { intervalMs: 0 };
  const client = createLinkTapClient({
    username: opts.username ?? 'tester',
    apiKey: 'key',
    transport: mock.transport(),
    limits: opts.realLimits
      ? undefined
      : { devices: zero, status: zero, history: zero, command: zero },
  });
  return { mock, client };
}

describe('LinkTap client against the mock', () => {
  afterEach(() => vi.useRealTimers());

  it('lists and normalizes gateways and taplinkers', async () => {
    const { client } = setup();
    const gws = await client.getAllDevices();
    expect(gws.map((g) => g.name)).toEqual(['Backyard Gateway', 'Garage Gateway']);
    const all = gws.flatMap((g) => g.taplinkers);
    expect(all).toHaveLength(6);

    const byId = new Map(all.map((t) => [t.id, t]));
    expect(byId.get(MOCK_IDS.frontLawn)?.watering?.totalSec).toBe(600);
    expect(byId.get(MOCK_IDS.veggies)).toMatchObject({ batteryPct: 14, alarms: ['noWater'] });
    expect(byId.get(MOCK_IDS.dripB)).toMatchObject({ outlet: 2, gatewayId: MOCK_IDS.backyard });
    expect(byId.get(MOCK_IDS.sideYard)).toMatchObject({ signalPct: 18, workMode: 'T' });
    expect(byId.get(MOCK_IDS.backFence)?.online).toBe(false);
  });

  it('surfaces {"result":"error"} as LinkTapError', async () => {
    const { client } = setup({ username: '' });
    await expect(client.getAllDevices()).rejects.toThrow(LinkTapError);
    await expect(client.getAllDevices()).rejects.toThrow(/Invalid username/);
  });

  it('does not treat a null watering status as proof of good credentials', async () => {
    const { client } = setup({ username: '' });
    // The real API answers ok + status:null for bad credentials; so does the mock.
    expect(await client.getWateringStatus(lawn)).toBeNull();
  });

  it('starts a run with minutes + seconds and stops it', async () => {
    const { client, mock } = setup();
    const veg = { gatewayId: MOCK_IDS.backyard, taplinkerId: MOCK_IDS.dripA };
    await client.startWatering({ ...veg, seconds: 150 });
    const call = mock.calls.at(-1);
    expect(call).toMatchObject({
      endpoint: 'activateInstantMode',
      body: { action: true, duration: 2, durationSec: 30, taplinkerId: MOCK_IDS.dripA },
    });
    expect((await client.getWateringStatus(veg))?.totalSec).toBe(150);

    await client.stopWatering(veg);
    expect(await client.getWateringStatus(veg)).toBeNull();
    expect(mock.find(MOCK_IDS.dripA)?.history.at(-1)?.durationSec).toBeLessThanOrEqual(1);
  });

  it('rejects out-of-range durations and pauses before calling the API', async () => {
    const { client, mock } = setup();
    const before = mock.calls.length;
    await expect(client.startWatering({ ...lawn, seconds: 30 })).rejects.toThrow(/1..1439/);
    await expect(client.pauseWateringPlan(lawn, 500)).rejects.toThrow(/0.1..240/);
    expect(mock.calls.length).toBe(before);
    await expect(client.pauseWateringPlan(lawn, -1)).resolves.toBeUndefined();
  });

  it('refuses commands to offline devices', async () => {
    const { client } = setup();
    await expect(
      client.startWatering({
        gatewayId: MOCK_IDS.garage,
        taplinkerId: MOCK_IDS.backFence,
        seconds: 60,
      }),
    ).rejects.toThrow(/offline/);
  });

  it('dismisses alarms', async () => {
    const { client, mock } = setup();
    await client.dismissAlarm(
      { gatewayId: MOCK_IDS.backyard, taplinkerId: MOCK_IDS.veggies },
      'noWater',
    );
    expect(mock.find(MOCK_IDS.veggies)?.alarms.size).toBe(0);
  });

  it('returns 30 days of history', async () => {
    const { client } = setup();
    const history = await client.getWateringHistory(lawn, 'UTC');
    expect(history.length).toBeGreaterThan(5);
    const oldest = history[0]!.startedAt.getTime();
    expect(Date.now() - oldest).toBeLessThanOrEqual(31 * 86_400_000);
    expect(history.every((h) => h.volumeMl !== null)).toBe(true);
  });

  it('with real limits, never trips the (enforcing) mock and coalesces concurrent reads', async () => {
    vi.useFakeTimers();
    const { client, mock } = setup({ realLimits: true });

    const [a, b] = await Promise.all([client.getAllDevices(), client.getAllDevices()]);
    expect(a).toBe(b);
    expect(mock.calls.filter((c) => c.endpoint === 'getAllDevices')).toHaveLength(1);

    // A second poll right away has to wait out the 5-minute window.
    const second = client.getAllDevices();
    expect(client.nextAvailableAt('devices').getTime() - Date.now()).toBeGreaterThan(4 * 60_000);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await expect(second).resolves.toHaveLength(2);

    // Two commands back to back are spaced 15 s apart, and both succeed.
    const ref = { gatewayId: MOCK_IDS.backyard, taplinkerId: MOCK_IDS.dripA };
    const start = client.startWatering({ ...ref, seconds: 60 });
    const stop = client.stopWatering(ref);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(Promise.all([start, stop])).resolves.toBeDefined();
    const cmds = mock.calls.filter((c) => c.endpoint === 'activateInstantMode');
    expect(cmds[1]!.at - cmds[0]!.at).toBeGreaterThanOrEqual(15_000);
  });

  it('spaces getWateringStatus account-wide (31 s) across taplinkers', async () => {
    vi.useFakeTimers();
    const { client, mock } = setup({ realLimits: true });
    const dripA = { gatewayId: MOCK_IDS.backyard, taplinkerId: MOCK_IDS.dripA };
    const both = Promise.all([client.getWateringStatus(lawn), client.getWateringStatus(dripA)]);
    await vi.advanceTimersByTimeAsync(31_000);
    await both;
    const calls = mock.calls.filter((c) => c.endpoint === 'getWateringStatus');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(31_000);
    expect(client.nextAvailableAt('status').getTime() - Date.now()).toBe(31_000);
  });

  it('limits getWateringHistory per taplinker: two outlets back to back are fine', async () => {
    vi.useFakeTimers();
    const { client, mock } = setup({ realLimits: true });
    const dripB = { gatewayId: MOCK_IDS.backyard, taplinkerId: MOCK_IDS.dripB };
    await client.getWateringHistory(lawn, 'UTC');
    await client.getWateringHistory(dripB, 'UTC');
    const calls = mock.calls.filter((c) => c.endpoint === 'getWateringHistory');
    expect(calls[1]!.at - calls[0]!.at).toBeLessThan(1_000);
    expect(client.nextAvailableAt('history', MOCK_IDS.frontLawn).getTime()).toBe(
      calls[0]!.at + 10 * 60_000,
    );
    expect(client.nextAvailableAt('history', MOCK_IDS.veggies).getTime()).toBe(Date.now());
  });

  it('classifies LinkTap rate-limit messages as rate_limit errors', async () => {
    const transport = async () => ({
      result: 'error',
      message: 'The minimum interval of calling this API is 30 seconds.',
    });
    const client = createLinkTapClient({ username: 'u', apiKey: 'k', transport });
    const err = await client.getWateringStatus(lawn).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LinkTapError);
    expect(err).toMatchObject({ kind: 'rate_limit' });
    expect(isRateLimitError(err)).toBe(true);
    expect(isRateLimitMessage('The API is called too frequently.')).toBe(true);
    expect(isRateLimitMessage('Gateway is offline')).toBe(false);
  });

  it('the enforcing mock rejects a second status call within 30 s for ANY taplinker', () => {
    let t = 0;
    const mock = new LinkTapMock({ now: () => t, seedRunning: false });
    const body = (taplinkerId: string) => ({
      username: 'u',
      apiKey: 'k',
      gatewayId: MOCK_IDS.backyard,
      taplinkerId,
    });
    expect(mock.handle('getWateringStatus', body(MOCK_IDS.dripA))).toEqual({
      result: 'ok',
      status: null,
    });
    t = 1_000;
    expect(mock.handle('getWateringStatus', body(MOCK_IDS.dripB))).toEqual({
      result: 'error',
      message: 'The minimum interval of calling this API is 30 seconds.',
    });
    t = 30_000;
    expect(mock.handle('getWateringStatus', body(MOCK_IDS.dripB))).toMatchObject({
      result: 'ok',
    });
    // History is per taplinker.
    expect(mock.handle('getWateringHistory', body(MOCK_IDS.dripA))).toMatchObject({
      result: 'ok',
    });
    expect(mock.handle('getWateringHistory', body(MOCK_IDS.dripB))).toMatchObject({
      result: 'ok',
    });
  });

  it('mock status: null during start latency, live string shape while running, {dur} after', () => {
    let t = 1_000_000;
    const mock = new LinkTapMock({ now: () => t, seedRunning: false, startLatencyMs: 15_000 });
    const auth = { username: 'u', apiKey: 'k' };
    const ref = { ...auth, gatewayId: MOCK_IDS.backyard, taplinkerId: MOCK_IDS.dripA };
    expect(
      mock.handle('activateInstantMode', { ...ref, action: true, duration: 1, autoBack: false }),
    ).toEqual({ result: 'ok', message: 'success' });
    t += 12_000;
    expect(mock.handle('getWateringStatus', ref)).toEqual({ result: 'ok', status: null });
    t += 31_000;
    const running = mock.handle('getWateringStatus', ref) as { status: Record<string, string> };
    expect(running.status).toMatchObject({
      onDuration: '1',
      onDurSec: '0',
      total: '1',
      totalSec: '0',
      onStamp: String(1_000_000 + 15_000),
      vel: '900',
      vol: '0',
      dur: '60',
      cm: 'M',
    });
    t += 40_000; // the valve opened at +15 s, so the 60 s run ended at +75 s
    expect(mock.handle('getWateringStatus', ref)).toEqual({
      result: 'ok',
      status: { dur: '60' },
    });
  });

  it('the enforcing mock does reject calls that ignore the limits', async () => {
    const mock = new LinkTapMock();
    const body = { username: 'u', apiKey: 'k' };
    expect(mock.handle('getAllDevices', body)).toMatchObject({ result: 'ok' });
    expect(mock.handle('getAllDevices', body)).toMatchObject({
      result: 'error',
      message: expect.stringMatching(/too frequently/),
    });
  });
});
