import { describe, expect, it } from 'vitest';
import { harness } from '../test-utils';
import { MOCK_IDS } from '../linktap/mock';
import {
  CloudExecutor,
  LocalGatewayExecutor,
  NotImplementedError,
  startVerified,
  StartAbortedError,
  StartVerifyError,
} from './executor';

const lawn = { id: MOCK_IDS.frontLawn, gatewayId: MOCK_IDS.backyard };
const starts = (calls: { endpoint: string; body: Record<string, unknown> }[]) =>
  calls.filter((c) => c.endpoint === 'activateInstantMode' && c.body.action === true);

function setup() {
  const h = harness({ mock: { seedRunning: false } });
  return { ...h, executor: new CloudExecutor({ client: h.client, verifyDelayMs: 0 }) };
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

  it('starts, verifies and stops through the client', async () => {
    const { executor, mock } = setup();
    await executor.start(lawn, 600);
    expect(starts(mock.calls)[0]?.body).toMatchObject({ duration: 10, durationSec: 0 });
    expect(await executor.verify(lawn)).toBe(true);
    await executor.stop(lawn);
    expect(await executor.verify(lawn)).toBe(false);
  });

  it('does not take a null status as success, even with bad credentials', async () => {
    const h = harness({ mock: { seedRunning: false } });
    const { createLinkTapClient } = await import('../linktap/client');
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
    expect(await startVerified(executor, lawn, 600)).toBe(1);
    expect(starts(mock.calls)).toHaveLength(1);
  });

  it('retries once when the start silently fails', async () => {
    const { executor, mock } = setup();
    mock.failStartsSilently(lawn.id, 1);
    expect(await startVerified(executor, lawn, 600)).toBe(2);
    expect(starts(mock.calls)).toHaveLength(2);
    expect(mock.find(lawn.id)?.run).not.toBeNull();
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
      startVerified(executor, lawn, 600, undefined, () => stopped),
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
