import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  baseId,
  isPlanMode,
  normalizeGateway,
  normalizeHistory,
  normalizeTaplinker,
  normalizeWatering,
  outletOf,
  parsePercent,
  splitDuration,
  toFlag,
  toWorkMode,
  zonedTimeToDate,
} from './normalize';
import {
  getAllDevicesSchema,
  getWateringHistorySchema,
  getWateringStatusSchema,
  rawGatewaySchema,
} from './schemas';

describe('ids', () => {
  it('keeps the first 16 chars as the base id', () => {
    expect(baseId('A1B2C3D4E5F60013_2')).toBe('A1B2C3D4E5F60013');
    expect(baseId(' A1B2C3D4E5F60013 ')).toBe('A1B2C3D4E5F60013');
  });

  it('reads the outlet from multi-outlet ids', () => {
    expect(outletOf('A1B2C3D4E5F60013_2')).toBe(2);
    expect(outletOf('A1B2C3D4E5F60013')).toBeNull();
  });
});

describe('scalars', () => {
  it('parses percentages', () => {
    expect(parsePercent('66%')).toBe(66);
    expect(parsePercent(80)).toBe(80);
    expect(parsePercent('n/a')).toBeNull();
    expect(parsePercent(undefined)).toBeNull();
  });

  it('parses flags in every shape LinkTap uses', () => {
    expect([true, 1, 'true', '1'].map(toFlag)).toEqual([true, true, true, true]);
    expect([false, 0, 'false', null, undefined].map(toFlag)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it('accepts known work modes only', () => {
    expect(toWorkMode('T')).toBe('T');
    expect(toWorkMode(' M ')).toBe('M');
    expect(toWorkMode('Z')).toBeNull();
    expect(isPlanMode('T')).toBe(true);
    expect(isPlanMode('M')).toBe(false);
    expect(isPlanMode('N')).toBe(false);
    expect(isPlanMode(null)).toBe(false);
  });

  it('splits seconds into minutes + seconds', () => {
    expect(splitDuration(90)).toEqual({ duration: 1, durationSec: 30 });
    expect(splitDuration(600)).toEqual({ duration: 10, durationSec: 0 });
  });
});

describe('normalizeWatering', () => {
  it('converts minutes to seconds and keeps G2 flow/volume', () => {
    expect(normalizeWatering({ remaining: 2.5, total: '10', vel: 3800, vol: 28500 })).toEqual({
      remainingSec: 150,
      totalSec: 600,
      flowMlPerMin: 3800,
      volumeMl: 28500,
    });
  });

  it('falls back to onDuration (getWateringStatus shape)', () => {
    expect(normalizeWatering({ onDuration: 1, total: 5 })?.remainingSec).toBe(60);
  });

  it('returns null when not watering', () => {
    expect(normalizeWatering(null)).toBeNull();
  });
});

describe('normalizeTaplinker / normalizeGateway', () => {
  it('tolerates a sparse record', () => {
    const t = normalizeTaplinker({ taplinkerId: 'B1C2D3E4F5A60013_1' }, 'A1B2C3D4E5F60001XYZ');
    expect(t).toMatchObject({
      id: 'B1C2D3E4F5A60013_1',
      gatewayId: 'A1B2C3D4E5F60001',
      outlet: 1,
      name: 'B1C2D3E4F5A60013_1',
      online: false,
      batteryPct: null,
      signalPct: null,
      workMode: null,
      watering: null,
      alarms: [],
    });
  });

  it('normalizes a full getAllDevices gateway and keeps unknown keys in raw', () => {
    const raw = rawGatewaySchema.parse({
      gatewayId: 'A1B2C3D4E5F60001',
      name: 'Backyard',
      status: 'Connected',
      mystery: 42,
      taplinker: [
        {
          taplinkerId: 'B1C2D3E4F5A60011',
          taplinkerName: 'Lawn',
          status: 'Connected',
          batteryStatus: '80%',
          signal: '66%',
          workMode: 'M',
          watering: null,
          noWater: true,
          fallFlag: 'false',
          valveBroken: 0,
          newFlag: true,
        },
      ],
    });
    const gw = normalizeGateway(raw);
    expect(gw.online).toBe(true);
    expect(gw.raw).toMatchObject({ mystery: 42 });
    expect(gw.taplinkers[0]).toMatchObject({
      batteryPct: 80,
      signalPct: 66,
      workMode: 'M',
      online: true,
      alarms: ['noWater'],
    });
    expect(gw.taplinkers[0]?.raw).toMatchObject({ newFlag: true });
  });
});

describe('history', () => {
  it('converts gateway-local wall time to UTC', () => {
    // 06:00 in New York on 2026-07-01 is EDT (UTC-4).
    expect(zonedTimeToDate(2026, 7, 1, 6, 0, 0, 'America/New_York').toISOString()).toBe(
      '2026-07-01T10:00:00.000Z',
    );
    // ...and EST (UTC-5) in January.
    expect(zonedTimeToDate(2026, 1, 15, 6, 0, 0, 'America/New_York').toISOString()).toBe(
      '2026-01-15T11:00:00.000Z',
    );
  });

  it('handles the DST spring-forward day', () => {
    // 2026-03-08 06:30 New York is after the 2am jump, so EDT.
    expect(zonedTimeToDate(2026, 3, 8, 6, 30, 0, 'America/New_York').toISOString()).toBe(
      '2026-03-08T10:30:00.000Z',
    );
  });

  it('parses records, sorts them, and drops malformed ones', () => {
    const out = normalizeHistory(
      [
        { Y: '20261102', H: 6, M: 15, ss: 0, D: 10, S: 30, vol: 39900 },
        { Y: 20261101, H: '7', M: '0', ss: '5', D: 5, S: 0, vol: null },
        { Y: 'garbage', H: 1, M: 1, ss: 1, D: 1, S: 1, vol: 1 },
        { Y: '20260230', H: 6, M: 0, ss: 0, D: 1, S: 0, vol: 1 },
      ],
      'UTC',
    );
    // The record's time is the END of the run.
    expect(out).toEqual([
      {
        startedAt: new Date('2026-11-01T06:55:05Z'),
        endedAt: new Date('2026-11-01T07:00:05Z'),
        durationSec: 300,
        volumeMl: null,
        mode: null,
      },
      {
        startedAt: new Date('2026-11-02T06:04:30Z'),
        endedAt: new Date('2026-11-02T06:15:00Z'),
        durationSec: 630,
        volumeMl: 39900,
        mode: null,
      },
    ]);
  });

  it('prefers createdAt for the end time when it agrees with the local time', () => {
    const [e] = normalizeHistory(
      [
        {
          Y: '20261115',
          H: 14,
          M: 24,
          ss: 8,
          D: 0,
          S: 11,
          vol: 0,
          cm: 'M',
          createdAt: '2026-11-15T19:24:09.268Z',
        },
      ],
      'America/New_York',
    );
    expect(e?.endedAt.toISOString()).toBe('2026-11-15T19:24:09.268Z');
    expect(e?.startedAt.toISOString()).toBe('2026-11-15T19:23:58.268Z');
    expect(e?.mode).toBe('M');
  });

  it('ignores a batched createdAt that is far from the local time', () => {
    const [e] = normalizeHistory(
      [
        {
          Y: '20261115',
          H: 14,
          M: 25,
          ss: 25,
          D: 0,
          S: 1,
          vol: 0,
          createdAt: '2026-11-18T18:48:01.611Z',
        },
      ],
      'America/New_York',
    );
    expect(e?.endedAt.toISOString()).toBe('2026-11-15T19:25:25.000Z');
  });

  it('uses createdAt only within two minutes of the local time', () => {
    const rec = (createdAt: string) => ({
      Y: '20261115',
      H: 14,
      M: 0,
      ss: 0,
      D: 1,
      S: 0,
      vol: 1,
      createdAt,
    });
    const out = (iso: string) => normalizeHistory([rec(iso)], 'UTC')[0]!.endedAt.toISOString();
    expect(out('2026-11-15T14:01:59Z')).toBe('2026-11-15T14:01:59.000Z');
    expect(out('2026-11-15T14:02:01Z')).toBe('2026-11-15T14:00:00.000Z');
    expect(out('not a date')).toBe('2026-11-15T14:00:00.000Z');
  });

  it('drops runs with no duration', () => {
    const out = normalizeHistory(
      [{ Y: '20261118', H: 18, M: 17, ss: 44, D: 0, S: 0, vol: 0, cm: 'M' }],
      'America/New_York',
    );
    expect(out).toEqual([]);
  });
});

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as unknown;

describe('live API fixtures (sanitized captures from 2026-11-22)', () => {
  const devices = getAllDevicesSchema.parse(fixture('getAllDevices')).devices!;
  const gw = normalizeGateway(devices[0]!);

  it('reads the gateway: firmware version and plus-code location', () => {
    expect(gw).toMatchObject({
      id: 'A1B2C3D4004B1200',
      name: 'Gateway',
      online: true,
      version: 'G0609472606040836I_C0502012507221443',
      location: '849VCWC8+R9 Mountain View, CA, USA',
    });
    expect(gw.taplinkers).toHaveLength(4);
    // Taplinkers say "Not specified"; that is not a location.
    expect(gw.taplinkers[0]?.raw.location).toBe('Not specified');
  });

  it('reads taplinkers: numeric signal, "100%" battery, ValveLinker extras', () => {
    const t = gw.taplinkers[0]!;
    expect(t).toMatchObject({
      id: 'E5F60718004B1200_1',
      outlet: 1,
      online: true,
      signalPct: 88,
      batteryPct: 100,
      workMode: 'M',
      dType: 16,
      flowMeter: true,
      flowMlPerMin: 9911,
      watering: null,
      alarms: [],
    });
    expect(t.plan).toMatchObject({ action: false, duration: 0, Y: 2026, X: 11, Z: 21, H: 19 });
    // Mode N outlets have no plan; vel is still captured.
    expect(gw.taplinkers[3]).toMatchObject({ workMode: 'N', plan: null, flowMlPerMin: 0 });
  });

  it('maps the live `fall` flag (and legacy `fallFlag`) to the fall alarm', () => {
    const raw = (extra: object) =>
      rawGatewaySchema.parse({
        gatewayId: 'A1B2C3D4004B1200',
        taplinker: [{ taplinkerId: 'E5F60718004B1200_1', ...extra }],
      });
    const alarms = (extra: object) => normalizeGateway(raw(extra)).taplinkers[0]!.alarms;
    expect(alarms({ fall: true })).toEqual(['fallFlag']);
    expect(alarms({ fallFlag: true })).toEqual(['fallFlag']);
    expect(alarms({ fall: false, valveBroken: false, noWater: false })).toEqual([]);
    expect(
      alarms({ valveBroken: true, noWater: true, leakFlag: true, clogFlag: true }).sort(),
    ).toEqual(['clogFlag', 'leakFlag', 'noWater', 'valveBroken']);
    // pcFlag/pbFlag are absent in live data and only appear on some firmware.
    expect(alarms({ pcFlag: 1, pbFlag: 'true' }).sort()).toEqual(['pbFlag', 'pcFlag']);
  });

  it('treats an idle getWateringStatus (status: null) as not watering', () => {
    const res = getWateringStatusSchema.parse(fixture('getWateringStatus'));
    expect(normalizeWatering(res.status)).toBeNull();
  });

  it('normalizes the live history (records under `status`)', () => {
    const res = getWateringHistorySchema.parse(fixture('getWateringHistory'));
    const out = normalizeHistory(res.status ?? [], 'America/New_York');
    // 0:00 entries are dropped, the rest kept.
    expect(out.every((e) => e.durationSec > 0)).toBe(true);
    const run = out.find((e) => e.durationSec === 1800)!;
    expect(run.volumeMl).toBe(294219);
    // createdAt 19:16:59.557Z agrees with local 14:16:58 EST.
    expect(run.endedAt.toISOString()).toBe('2026-11-18T19:16:59.557Z');
    // The 11-15 entries were batched to 11-18; the local time wins.
    const batched = out.find((e) => e.durationSec === 47)!;
    expect(batched.endedAt.toISOString()).toBe('2026-11-15T19:26:15.000Z');
    expect(out.some((e) => e.mode === 'M')).toBe(true);
  });
});
