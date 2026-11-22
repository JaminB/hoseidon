import type { LinkTapClient } from '../linktap/client';
import { MAX_RUN_SEC } from '@hoseidon/shared';

export interface ExecDevice {
  id: string;
  gatewayId: string;
}

/**
 * How the engine turns water on and off. CloudExecutor goes through the LinkTap cloud API; a
 * LocalGatewayExecutor (HTTP/MQTT on the LAN) can replace it later without touching the engine.
 */
export interface Executor {
  readonly kind: 'cloud' | 'local';
  /** Round a duration to what the device can actually do. */
  quantize(device: ExecDevice | null, seconds: number): number;
  start(device: ExecDevice, seconds: number): Promise<void>;
  stop(device: ExecDevice): Promise<void>;
  /** True if the device reports it is watering now. */
  verify(device: ExecDevice): Promise<boolean>;
}

export interface CloudExecutorOptions {
  client: LinkTapClient;
  /** Devices that take seconds (S models). Others run whole minutes. */
  supportsSeconds?: (device: ExecDevice) => boolean;
  /** Wait between the start command and the status check. Default 5 s. */
  verifyDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class CloudExecutor implements Executor {
  readonly kind = 'cloud';
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: CloudExecutorOptions) {
    this.sleep = opts.sleep ?? defaultSleep;
  }

  quantize(device: ExecDevice | null, seconds: number): number {
    const s =
      device && this.opts.supportsSeconds?.(device)
        ? Math.round(seconds)
        : Math.round(seconds / 60) * 60;
    return Math.min(MAX_RUN_SEC, Math.max(60, s));
  }

  start(device: ExecDevice, seconds: number): Promise<void> {
    return this.opts.client.startWatering({
      gatewayId: device.gatewayId,
      taplinkerId: device.id,
      seconds: this.quantize(device, seconds),
    });
  }

  stop(device: ExecDevice): Promise<void> {
    return this.opts.client.stopWatering({ gatewayId: device.gatewayId, taplinkerId: device.id });
  }

  async verify(device: ExecDevice): Promise<boolean> {
    await this.sleep(this.opts.verifyDelayMs ?? 5_000);
    // getWateringStatus says null both for "not watering" and for bad credentials; either way the
    // start didn't take as far as we can tell.
    const status = await this.opts.client.getWateringStatus({
      gatewayId: device.gatewayId,
      taplinkerId: device.id,
    });
    return status !== null;
  }
}

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not implemented yet`);
    this.name = 'NotImplementedError';
  }
}

/** Placeholder for driving the gateway directly on the LAN (HTTP api.shtml / MQTT). */
export class LocalGatewayExecutor implements Executor {
  readonly kind = 'local';
  quantize(_device: ExecDevice | null, seconds: number): number {
    return Math.min(MAX_RUN_SEC, Math.max(60, Math.round(seconds)));
  }
  start(): Promise<void> {
    return Promise.reject(new NotImplementedError('LocalGatewayExecutor.start'));
  }
  stop(): Promise<void> {
    return Promise.reject(new NotImplementedError('LocalGatewayExecutor.stop'));
  }
  verify(): Promise<boolean> {
    return Promise.reject(new NotImplementedError('LocalGatewayExecutor.verify'));
  }
}

export class StartVerifyError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
  ) {
    super(message);
    this.name = 'StartVerifyError';
  }
}

/** The user pressed Stop while a start was still being verified. */
export class StartAbortedError extends Error {
  constructor() {
    super('stopped before it started');
    this.name = 'StartAbortedError';
  }
}

/**
 * Start, check the device really is watering, and retry the start once if not (some users see
 * starts that LinkTap accepts but never run). Throws StartVerifyError, or the executor's error.
 * Returns the number of start attempts used. `shouldAbort` is checked before every start and after
 * every failed verify, so a Stop pressed in the verify window doesn't get a retry start behind it
 * (throws StartAbortedError).
 */
export async function startVerified(
  executor: Executor,
  device: ExecDevice,
  seconds: number,
  onAttempt?: (attempt: number) => void,
  shouldAbort?: () => boolean,
): Promise<number> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (shouldAbort?.()) throw new StartAbortedError();
    onAttempt?.(attempt);
    await executor.start(device, seconds);
    if (await executor.verify(device)) return attempt;
  }
  if (shouldAbort?.()) throw new StartAbortedError();
  throw new StartVerifyError('device did not report watering after 2 start attempts', 2);
}
