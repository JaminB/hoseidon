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
import { rawGatewaySchema } from './schemas';

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
    expect(out).toEqual([
      { startedAt: new Date('2026-11-01T07:00:05Z'), durationSec: 300, volumeMl: null },
      { startedAt: new Date('2026-11-02T06:15:00Z'), durationSec: 630, volumeMl: 39900 },
    ]);
  });
});
