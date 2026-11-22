import type { AlarmFlag, WorkMode } from '@hoseidon/shared';
import { LINKTAP_LIMITS, type Bucket, type Transport } from './client';
import { baseId } from './normalize';

/**
 * In-process fake of the LinkTap cloud API. It speaks the same JSON as the real thing (as far as
 * we know it), so the real client, normalizers and rate limiter all run against it.
 *
 * Cast: two gateways, six taplinkers (one ValveLinker with outlets _1/_2), one running, one with a
 * low battery + noWater alarm, one with a weak signal and a LinkTap plan, one offline.
 */

interface MockRun {
  startedAt: number;
  totalSec: number;
  autoBack: boolean;
  prevMode: WorkMode;
}

interface MockTaplinker {
  id: string;
  name: string;
  status: 'Connected' | 'Disconnected';
  battery: number;
  signal: number;
  workMode: WorkMode;
  /** ml/min; null for G1 models that don't meter flow. */
  flow: number | null;
  alarms: Set<AlarmFlag>;
  run: MockRun | null;
  history: { startedAt: number; durationSec: number; volumeMl: number | null }[];
}

interface MockGateway {
  id: string;
  name: string;
  status: 'Connected' | 'Disconnected';
  taplinkers: MockTaplinker[];
}

export interface MockOptions {
  now?: () => number;
  /** Reject calls that violate LinkTap's rate limits, like the real API. Default true. */
  enforceRateLimits?: boolean;
  /** Time zone used for history wall-clock times. */
  timeZone?: string;
  /** Start the "Front Lawn" run at construction. Default true. */
  seedRunning?: boolean;
  seed?: number;
}

const ENDPOINT_BUCKET: Record<string, Bucket> = {
  getAllDevices: 'devices',
  listDevices: 'devices',
  getWateringStatus: 'status',
  getWateringHistory: 'history',
  activateInstantMode: 'command',
  activateIntervalMode: 'command',
  activateOddEvenMode: 'command',
  activateSevenDayMode: 'command',
  activateMonthMode: 'command',
  activateCalendarMode: 'command',
  pauseWateringPlan: 'command',
  dismissAlarm: 'command',
};

const MODE_ENDPOINTS: Record<string, WorkMode> = {
  activateIntervalMode: 'I',
  activateOddEvenMode: 'O',
  activateSevenDayMode: 'T',
  activateMonthMode: 'Y',
  activateCalendarMode: 'D',
};

const DISMISSABLE = new Set(['noWater', 'valveBroken', 'fallFlag', 'pcFlag', 'pbFlag']);

/** Small deterministic PRNG so history looks the same on every boot. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tl(
  id: string,
  name: string,
  rest: Partial<Omit<MockTaplinker, 'id' | 'name' | 'alarms'>> & { alarms?: AlarmFlag[] } = {},
): MockTaplinker {
  return {
    id,
    name,
    status: 'Connected',
    battery: 90,
    signal: 80,
    workMode: 'M',
    flow: 3800,
    run: null,
    history: [],
    ...rest,
    alarms: new Set(rest.alarms ?? []),
  };
}

export const MOCK_IDS = {
  backyard: 'A1B2C3D4E5F60001',
  garage: 'A1B2C3D4E5F60002',
  frontLawn: 'B1C2D3E4F5A60011',
  veggies: 'B1C2D3E4F5A60012',
  dripA: 'B1C2D3E4F5A60013_1',
  dripB: 'B1C2D3E4F5A60013_2',
  sideYard: 'B1C2D3E4F5A60021',
  backFence: 'B1C2D3E4F5A60022',
} as const;

export class LinkTapMock {
  readonly gateways: MockGateway[];
  webhookUrl: string | null = null;
  /** Every call received, for assertions. */
  readonly calls: { endpoint: string; body: Record<string, unknown>; at: number }[] = [];

  private readonly now: () => number;
  private readonly enforce: boolean;
  private readonly timeZone: string;
  private readonly lastCall = new Map<string, number>();

  constructor(opts: MockOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.enforce = opts.enforceRateLimits ?? true;
    this.timeZone = opts.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.gateways = [
      {
        id: MOCK_IDS.backyard,
        name: 'Backyard Gateway',
        status: 'Connected',
        taplinkers: [
          tl(MOCK_IDS.frontLawn, 'Front Lawn', { battery: 84, signal: 72 }),
          tl(MOCK_IDS.veggies, 'Veggie Beds', {
            battery: 14,
            signal: 61,
            flow: null,
            alarms: ['noWater'],
          }),
          tl(MOCK_IDS.dripA, 'Drip Line A', { battery: 67, signal: 55, flow: 900 }),
          tl(MOCK_IDS.dripB, 'Drip Line B', { battery: 67, signal: 55, flow: 1100 }),
        ],
      },
      {
        id: MOCK_IDS.garage,
        name: 'Garage Gateway',
        status: 'Connected',
        taplinkers: [
          tl(MOCK_IDS.sideYard, 'Side Yard', { battery: 51, signal: 18, workMode: 'T' }),
          tl(MOCK_IDS.backFence, 'Back Fence', {
            status: 'Disconnected',
            battery: 3,
            signal: 0,
            workMode: 'N',
          }),
        ],
      },
    ];
    this.seedHistory(mulberry32(opts.seed ?? 42));
    if (opts.seedRunning ?? true) {
      const lawn = this.find(MOCK_IDS.frontLawn);
      if (lawn) this.startRun(lawn, 10 * 60, true, this.now() - 3 * 60_000);
    }
  }

  /** A Transport for createLinkTapClient. Responses are JSON round-tripped like the real wire. */
  transport(): Transport {
    return async (endpoint, body) => JSON.parse(JSON.stringify(this.handle(endpoint, body)));
  }

  // ---- test/dev controls ------------------------------------------------------------------------

  find(taplinkerId: string): MockTaplinker | undefined {
    for (const g of this.gateways) {
      const t = g.taplinkers.find((x) => x.id === taplinkerId);
      if (t) return t;
    }
    return undefined;
  }

  gatewayOf(taplinkerId: string): MockGateway | undefined {
    return this.gateways.find((g) => g.taplinkers.some((t) => t.id === taplinkerId));
  }

  setGatewayOnline(gatewayId: string, online: boolean) {
    const g = this.gateways.find((x) => x.id === gatewayId);
    if (g) g.status = online ? 'Connected' : 'Disconnected';
  }

  // ---- protocol ---------------------------------------------------------------------------------

  handle(endpoint: string, body: Record<string, unknown>): unknown {
    const at = this.now();
    this.calls.push({ endpoint, body, at });
    this.tick();

    const authed =
      typeof body.username === 'string' &&
      body.username !== '' &&
      typeof body.apiKey === 'string' &&
      body.apiKey !== '';
    // Real gotcha: getWateringStatus answers "ok, status null" even with bad credentials.
    if (!authed && endpoint === 'getWateringStatus') return { result: 'ok', status: null };
    if (!authed) return err('Invalid username or apiKey');

    const bucket = ENDPOINT_BUCKET[endpoint];
    if (!bucket && endpoint !== 'setWebHookUrl' && endpoint !== 'deleteWebHookUrl') {
      return err(`Unknown API: ${endpoint}`);
    }
    if (bucket && this.enforce) {
      const key = bucket === 'status' ? `status:${String(body.taplinkerId)}` : bucket;
      const last = this.lastCall.get(key);
      if (last !== undefined && at - last < LINKTAP_LIMITS[bucket].intervalMs) {
        return err('The API is called too frequently. Please try again later.');
      }
      this.lastCall.set(key, at);
    }

    switch (endpoint) {
      case 'getAllDevices':
      case 'listDevices':
        return { result: 'ok', devices: this.gateways.map((g) => this.renderGateway(g)) };
      case 'setWebHookUrl':
        this.webhookUrl = String(body.webHookUrl ?? body.url ?? '');
        return { result: 'ok' };
      case 'deleteWebHookUrl':
        this.webhookUrl = null;
        return { result: 'ok' };
    }

    const resolved = this.resolve(body);
    if (typeof resolved === 'string') return err(resolved);
    const { gateway, taplinker } = resolved;

    switch (endpoint) {
      case 'getWateringStatus':
        return { result: 'ok', status: taplinker.run ? this.renderWatering(taplinker) : null };
      case 'getWateringHistory':
        return { result: 'ok', history: this.renderHistory(taplinker) };
    }

    // Everything below is a command and needs the device reachable.
    if (gateway.status !== 'Connected') return err('Gateway is offline');
    if (taplinker.status !== 'Connected') return err('Taplinker is offline');

    switch (endpoint) {
      case 'activateInstantMode': {
        if (body.action === true || body.action === 'true') {
          const sec = Number(body.duration ?? 0) * 60 + Number(body.durationSec ?? 0);
          if (!(Number(body.duration) >= 1 && Number(body.duration) <= 1439)) {
            return err('Invalid duration');
          }
          if (taplinker.alarms.has('noWater') || taplinker.alarms.has('valveBroken')) {
            return err('Device has an active alarm; dismiss it first');
          }
          this.startRun(taplinker, sec, body.autoBack !== false, at);
        } else {
          this.finishRun(taplinker, at);
        }
        return { result: 'ok' };
      }
      case 'pauseWateringPlan': {
        const h = Number(body.pauseDuration);
        if (!(h === -1 || (h >= 0.1 && h <= 240))) return err('Invalid pauseDuration');
        return { result: 'ok' };
      }
      case 'dismissAlarm': {
        const alarm = String(body.alarm);
        if (!DISMISSABLE.has(alarm)) return err('Invalid alarm');
        taplinker.alarms.delete(alarm as AlarmFlag);
        return { result: 'ok' };
      }
    }

    const mode = MODE_ENDPOINTS[endpoint];
    if (mode) {
      taplinker.workMode = mode;
      return { result: 'ok' };
    }
    return err(`Unknown API: ${endpoint}`);
  }

  // ---- internals --------------------------------------------------------------------------------

  private resolve(body: Record<string, unknown>) {
    const gatewayId = String(body.gatewayId ?? '');
    const taplinkerId = String(body.taplinkerId ?? '');
    const gateway = this.gateways.find((g) => g.id === baseId(gatewayId));
    if (!gateway) return 'Gateway not found';
    const taplinker = gateway.taplinkers.find((t) => t.id === taplinkerId);
    if (!taplinker) return 'Taplinker not found';
    return { gateway, taplinker };
  }

  private startRun(t: MockTaplinker, totalSec: number, autoBack: boolean, at: number) {
    if (t.run) this.finishRun(t, at);
    t.run = { startedAt: at, totalSec, autoBack, prevMode: t.workMode };
    t.workMode = 'M';
  }

  private finishRun(t: MockTaplinker, at: number) {
    if (!t.run) return;
    const elapsed = Math.max(
      0,
      Math.min(t.run.totalSec, Math.round((at - t.run.startedAt) / 1000)),
    );
    t.history.push({
      startedAt: t.run.startedAt,
      durationSec: elapsed,
      volumeMl: t.flow === null ? null : Math.round((t.flow * elapsed) / 60),
    });
    if (t.run.autoBack) t.workMode = t.run.prevMode;
    t.run = null;
  }

  /** Complete runs whose time is up. */
  private tick() {
    const at = this.now();
    for (const g of this.gateways) {
      for (const t of g.taplinkers) {
        if (t.run && at >= t.run.startedAt + t.run.totalSec * 1000) {
          this.finishRun(t, t.run.startedAt + t.run.totalSec * 1000);
        }
      }
    }
  }

  private seedHistory(rand: () => number) {
    const day = 86_400_000;
    const now = this.now();
    for (const g of this.gateways) {
      for (const [i, t] of g.taplinkers.entries()) {
        for (let d = 30; d >= 1; d--) {
          // Water roughly every other day, staggered by device, at 6am-ish.
          if ((d + i) % 2 === 1 && rand() < 0.85) {
            const startedAt = now - d * day + Math.round((rand() - 0.5) * 3_600_000) + i * 900_000;
            const durationSec = (5 + Math.round(rand() * 15)) * 60;
            t.history.push({
              startedAt,
              durationSec,
              volumeMl: t.flow === null ? null : Math.round((t.flow * durationSec) / 60),
            });
          }
        }
      }
    }
  }

  private renderWatering(t: MockTaplinker) {
    if (!t.run) return null;
    const elapsedSec = (this.now() - t.run.startedAt) / 1000;
    const remainingSec = Math.max(0, t.run.totalSec - elapsedSec);
    const min = (s: number) => Math.round((s / 60) * 100) / 100;
    return {
      remaining: min(remainingSec),
      total: min(t.run.totalSec),
      onDuration: min(remainingSec),
      vel: t.flow,
      vol: t.flow === null ? null : Math.round((t.flow * elapsedSec) / 60),
    };
  }

  private renderGateway(g: MockGateway) {
    return {
      gatewayId: g.id,
      name: g.name,
      location: 'Home',
      status: g.status,
      version: 'S1.2.3',
      taplinker: g.taplinkers.map((t) => {
        const reachable = g.status === 'Connected' && t.status === 'Connected';
        return {
          taplinkerId: t.id,
          taplinkerName: t.name,
          location: 'Home',
          status: reachable ? 'Connected' : 'Disconnected',
          batteryStatus: `${t.battery}%`,
          signal: `${reachable ? t.signal : 0}%`,
          workMode: t.workMode,
          watering: this.renderWatering(t),
          noWater: t.alarms.has('noWater'),
          valveBroken: t.alarms.has('valveBroken'),
          fallFlag: t.alarms.has('fallFlag'),
          leakFlag: t.alarms.has('leakFlag'),
          clogFlag: t.alarms.has('clogFlag'),
          pcFlag: t.alarms.has('pcFlag'),
          pbFlag: t.alarms.has('pbFlag'),
          freezeFlag: t.alarms.has('freezeFlag'),
        };
      }),
    };
  }

  private renderHistory(t: MockTaplinker) {
    const cutoff = this.now() - 30 * 86_400_000;
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: this.timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    return t.history
      .filter((h) => h.startedAt >= cutoff)
      .map((h) => {
        const p = Object.fromEntries(
          fmt.formatToParts(new Date(h.startedAt)).map((x) => [x.type, x.value]),
        );
        return {
          Y: `${p.year}${p.month}${p.day}`,
          H: Number(p.hour),
          M: Number(p.minute),
          ss: Number(p.second),
          D: Math.floor(h.durationSec / 60),
          S: h.durationSec % 60,
          vol: h.volumeMl,
        };
      });
  }
}

function err(message: string) {
  return { result: 'error', message };
}
