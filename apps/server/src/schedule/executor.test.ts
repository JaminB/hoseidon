import { describe, expect, it } from 'vitest';
import { harness } from '../test-utils';
import { createLinkTapClient, LinkTapError } from '../linktap/client';
import { LinkTapMock, MOCK_IDS, type MockOptions } from '../linktap/mock';
import {
  CloudExecutor,
  LocalGatewayExecutor,
  NotImplementedError,
  startVerified,
  StartAbortedError,
  StartVerifyError,
  type CloudExecutorOptions,
} from './executor';

const lawn = { id: MOCK_IDS.frontLawn, gatewayId: MOCK_IDS.backyard };
const starts = (calls: { endpoint: string; body: Record<string, unknown> }[]) =>
  calls.filter((c) => c.endpoint === 'activateInstantMode' && c.body.action === true);
const statusCalls = (calls: { endpoint: string }[]) =>
  calls.filter((c) => c.endpoint === 'getWateringStatus');

function setup() {
  const h = harness({ mock: { seedRunning: false } });
  return {
    ...h,
    executor: new CloudExecutor({ client: h.client, verifyDelayMs: 0, recheckDelayMs: 0 }),
  };
}

/**
 * Mock + client + executor on one virtual clock: every sleep advances it, so the real (20 s /
 * 30 s) verify timing runs instantly. Rate limits are off on both sides.
 */
function clocked(mock: MockOptions = {}, exec: Partial<CloudExecutorOptions> = {}) {
  let t = Date.parse('2026-06-01T12:00:00Z');
  const now = () => t;
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    t += ms;
  };
  const m = new LinkTapMock({
    now,
    enforceRateLimits: false,
    timeZone: 'UTC',
    seedRunning: false,
    ...mock,
  });
  const zero = { intervalMs: 0 };
  const client = createLinkTapClient({
    username: 'tester',
    apiKey: 'key',
    transport: m.transport(),
    now,
    limits: { devices: zero, status: zero, history: zero, command: zero },
  });
  const executor = new CloudExecutor({ client, sleep, now, ...exec });
  const run = (seconds: number, shouldAbort?: () => boolean) =>
    startVerified(executor, lawn, seconds, { sleep, now, shouldAbort });
  return { mock: m, client, executor, run, sleeps, now };
}

describe('CloudExecutor', () => {
  it('rounds to whole minutes unless the device takes seconds', () => {
    const { client } = setup();
    const minutes = new CloudExecutor({ client });
    expect(minutes.quantize(lawn, 450)).toBe(480);
    expect(minutes.quantize(lawn, 20)).toBe(60);
    expect(minutes.quantize(lawn, 10 ** 6)).toBe(1439 * 60);
    const seconds = new CloudExecutor({ client, supportsSeconds: () => true });
    expect(seconds.quantize(lawn, 450.4)).toBe(450);
  });

  it('starts, verifies and stops through the client, with the live-verified bodies', async () => {
    const { executor, mock } = setup();
    await executor.start(lawn, 600);
    const body = starts(mock.calls)[0]?.body;
    expect(body).toMatchObject({
      gatewayId: MOCK_IDS.backyard,
      taplinkerId: MOCK_IDS.frontLawn,
      action: true,
      duration: 10,
    });
    expect(body).not.toHaveProperty('durationSec');
    expect(body).not.toHaveProperty('eco');
    expect(await executor.verify(lawn)).toBe(true);
    await executor.stop(lawn);
    const stop = mock.calls.at(-1)!;
    expect(stop.body).toEqual({
      username: 'tester',
      apiKey: 'key',
      gatewayId: MOCK_IDS.backyard,
      taplinkerId: MOCK_IDS.frontLawn,
      action: false,
      duration: 0,
    });
    expect(await executor.verify(lawn)).toBe(false);
  });

  it('does not take a null status as success, even with bad credentials', async () => {
    const h = harness({ mock: { seedRunning: false } });
    const bad = createLinkTapClient({
      username: '',
      apiKey: '',
      transport: h.mock.transport(),
      limits: { status: { intervalMs: 0 } },
    });
    expect(await new CloudExecutor({ client: bad, verifyDelayMs: 0 }).verify(lawn)).toBe(false);
  });
});

describe('startVerified', () => {
  it('succeeds on the first try', async () => {
    const { executor, mock } = setup();
    expect(await startVerified(executor, lawn, 600)).toMatchObject({
      attempts: 1,
      verified: true,
    });
    expect(starts(mock.calls)).toHaveLength(1);
  });

  it('status shows running at the first check: no retry, one status call', async () => {
    const { mock, run, sleeps } = clocked();
    expect(await run(600)).toMatchObject({ attempts: 1, verified: true });
    expect(starts(mock.calls)).toHaveLength(1);
    expect(statusCalls(mock.calls)).toHaveLength(1);
    // Waited out the start latency before looking.
    expect(sleeps).toEqual([20_000]);
  });

  it('an early null then running is a success with no retry (start latency)', async () => {
    // Live: an outlet answered null 12 s after an accepted start and still ran.
    const { mock, run, sleeps } = clocked({ startLatencyMs: 25_000 });
    const result = await run(600);
    expect(result).toMatchObject({ attempts: 1, verified: true });
    expect(starts(mock.calls)).toHaveLength(1);
    expect(statusCalls(mock.calls)).toHaveLength(2);
    expect(sleeps).toEqual([20_000, 30_000]);
    expect(mock.find(lawn.id)?.run).not.toBeNull();
  });

  it('null twice retries the start once', async () => {
    const { mock, run } = clocked();
    mock.failStartsSilently(lawn.id, 1);
    expect(await run(600)).toMatchObject({ attempts: 2, verified: true });
    expect(starts(mock.calls)).toHaveLength(2);
    expect(mock.find(lawn.id)?.run).not.toBeNull();
  });

  it('does not retry when the planned window is mostly gone; flags it unverified', async () => {
    const { mock, run } = clocked();
    mock.failStartsSilently(lawn.id, 1);
    // 60 s run: 20 s + 30 s of checking is past half of it.
    const result = await run(60);
    expect(result).toMatchObject({ attempts: 1, verified: false });
    expect(result.note).toMatch(/too late/);
    expect(starts(mock.calls)).toHaveLength(1);
  });

  it('does not retry when the status cannot be read (rate limited): unverified', async () => {
    const { mock, executor, run } = clocked();
    executor.verify = () =>
      Promise.reject(
        new LinkTapError(
          'getWateringStatus',
          'The minimum interval of calling this API is 30 seconds.',
          'rate_limit',
        ),
      );
    const result = await run(600);
    expect(result).toMatchObject({ attempts: 1, verified: false });
    expect(starts(mock.calls)).toHaveLength(1);
  });

  it('a fresh history entry counts as proof it ran, so a finished short run is not re-sent', async () => {
    // Checks land after the 60 s run is over: status says {"dur":"60"} (idle) both times.
    const { mock, run } = clocked(
      {},
      { verifyDelayMs: 70_000, recheckDelayMs: 30_000, historyTimeZone: () => 'UTC' },
    );
    expect(await run(60)).toMatchObject({ attempts: 1, verified: true });
    expect(starts(mock.calls)).toHaveLength(1);
    expect(mock.calls.some((c) => c.endpoint === 'getWateringHistory')).toBe(true);
  });

  it('DB evidence (a getAllDevices snapshot or webhook) also prevents a retry', async () => {
    const { mock, run } = clocked({}, { evidence: () => true });
    mock.failStartsSilently(lawn.id, 1);
    expect(await run(600)).toMatchObject({ attempts: 1, verified: true });
    expect(starts(mock.calls)).toHaveLength(1);
  });

  it('re-sends a start that LinkTap rate-limited (it never ran)', async () => {
    const { mock, executor, run, sleeps } = clocked();
    const start = executor.start.bind(executor);
    let first = true;
    executor.start = (d, s) => {
      if (first) {
        first = false;
        return Promise.reject(
          new LinkTapError('activateInstantMode', 'The API is called too frequently', 'rate_limit'),
        );
      }
      return start(d, s);
    };
    expect(await run(600)).toMatchObject({ attempts: 1, verified: true });
    expect(sleeps[0]).toBe(16_000);
    expect(starts(mock.calls)).toHaveLength(1);
  });

  it('gives up after the retry', async () => {
    const { executor, mock } = setup();
    mock.failStartsSilently(lawn.id, 5);
    await expect(startVerified(executor, lawn, 600)).rejects.toBeInstanceOf(StartVerifyError);
    expect(starts(mock.calls)).toHaveLength(2);
  });

  it('does not retry a start the user stopped during verify', async () => {
    const { executor, mock } = setup();
    mock.failStartsSilently(lawn.id, 1);
    let stopped = false;
    const verify = executor.verify.bind(executor);
    executor.verify = async (d) => {
      stopped = true;
      return verify(d);
    };
    await expect(
      startVerified(executor, lawn, 600, { shouldAbort: () => stopped }),
    ).rejects.toBeInstanceOf(StartAbortedError);
    expect(starts(mock.calls)).toHaveLength(1);
    expect(mock.find(lawn.id)?.run ?? null).toBeNull();
  });

  it('does not retry API errors', async () => {
    const { executor, mock } = setup();
    const veggies = { id: MOCK_IDS.veggies, gatewayId: MOCK_IDS.backyard };
    await expect(startVerified(executor, veggies, 600)).rejects.toThrow(/active alarm/);
    expect(starts(mock.calls)).toHaveLength(1);
  });
});

describe('LocalGatewayExecutor', () => {
  it('is a stub', async () => {
    const local = new LocalGatewayExecutor();
    await expect(local.start()).rejects.toBeInstanceOf(NotImplementedError);
    await expect(local.verify()).rejects.toBeInstanceOf(NotImplementedError);
    expect(local.quantize(null, 90.4)).toBe(90);
  });
});
