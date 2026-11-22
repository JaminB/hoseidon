import { describe, expect, it } from 'vitest';
import { DEFAULT_SKIP_RULES } from '@hoseidon/shared';
import { planOccurrence } from './plan';
import { evaluateSkipRules, type WeatherOutlook } from './weather';

const at = new Date('2026-06-10T06:00:00Z');
const gw: Record<string, string> = { a: 'G1', b: 'G1', c: 'G2' };
const gatewayOf = (id: string) => gw[id] ?? null;
const summary = (slots: ReturnType<typeof planOccurrence>) =>
  slots.map(
    (s) =>
      `${s.deviceId}${s.cycle} ${s.start.toISOString().slice(11, 16)}-${s.end.toISOString().slice(11, 16)}`,
  );

describe('planOccurrence', () => {
  it('runs zones on one gateway back to back and other gateways in parallel', () => {
    const slots = planOccurrence({
      items: [
        { deviceId: 'a', seconds: 600 },
        { deviceId: 'b', seconds: 300 },
        { deviceId: 'c', seconds: 900 },
      ],
      cycleSoak: null,
      sequential: true,
      occurrenceAt: at,
      gatewayOf,
    });
    expect(summary(slots)).toEqual(['a1 06:00-06:10', 'b1 06:10-06:15', 'c1 06:00-06:15']);
  });

  it('starts everything at once when not sequential', () => {
    const slots = planOccurrence({
      items: [
        { deviceId: 'a', seconds: 600 },
        { deviceId: 'b', seconds: 300 },
      ],
      cycleSoak: null,
      sequential: false,
      occurrenceAt: at,
      gatewayOf,
    });
    expect(summary(slots)).toEqual(['a1 06:00-06:10', 'b1 06:00-06:05']);
  });

  it('splits cycles and waits out the soak', () => {
    const slots = planOccurrence({
      items: [
        { deviceId: 'a', seconds: 1200 },
        { deviceId: 'b', seconds: 600 },
      ],
      cycleSoak: { cycles: 2, soakMinutes: 20 },
      sequential: true,
      occurrenceAt: at,
      gatewayOf,
    });
    // a1 10m, b1 5m; a2 waits for a1 + 20m soak (06:30); b2 follows a2.
    expect(summary(slots)).toEqual([
      'a1 06:00-06:10',
      'b1 06:10-06:15',
      'a2 06:30-06:40',
      'b2 06:40-06:45',
    ]);
    expect(slots.map((s) => s.baseSeconds)).toEqual([600, 300, 600, 300]);
  });

  it('applies scale and quantizing per device', () => {
    const slots = planOccurrence({
      items: [{ deviceId: 'a', seconds: 600 }],
      cycleSoak: { cycles: 3, soakMinutes: 0 },
      sequential: true,
      occurrenceAt: at,
      gatewayOf,
      scale: 1.1,
      quantize: (s) => Math.round(s / 60) * 60,
    });
    // 600 / 3 = 200 s * 1.1 = 220 s -> 4 min.
    expect(slots.map((s) => [s.baseSeconds, s.seconds])).toEqual([
      [200, 240],
      [200, 240],
      [200, 240],
    ]);
  });
});

describe('evaluateSkipRules', () => {
  const outlook: WeatherOutlook = {
    rainMm: 8,
    minTempC: 4,
    maxWindKph: 20,
    et0Mm: 3,
    et0BaselineMm: 4,
  };
  const rules = (r: Partial<typeof DEFAULT_SKIP_RULES>) => ({ ...DEFAULT_SKIP_RULES, ...r });

  it('never skips without data or rules', () => {
    expect(evaluateSkipRules(rules({ rainForecastMm: 1 }), null)).toEqual({
      skip: null,
      scale: 1,
      note: null,
    });
    expect(evaluateSkipRules(DEFAULT_SKIP_RULES, outlook).skip).toBeNull();
    expect(
      evaluateSkipRules(rules({ rainForecastMm: 1 }), { ...outlook, rainMm: null }).skip,
    ).toBeNull();
  });

  it('skips for rain above the threshold', () => {
    expect(evaluateSkipRules(rules({ rainForecastMm: 5 }), outlook).skip).toBe(
      '8 mm rain forecast',
    );
    expect(evaluateSkipRules(rules({ rainForecastMm: 8 }), outlook).skip).toBeNull();
  });

  it('skips for freeze and wind', () => {
    expect(evaluateSkipRules(rules({ freezeC: 4 }), outlook).skip).toBe(
      'Freeze risk (low of 4 °C)',
    );
    expect(evaluateSkipRules(rules({ freezeC: 2 }), outlook).skip).toBeNull();
    expect(evaluateSkipRules(rules({ windKph: 20 }), outlook).skip).toBe('High wind (20 km/h)');
  });

  it('scales by ET₀ within the limits', () => {
    const r = evaluateSkipRules(rules({ etScaling: true }), outlook);
    expect(r).toMatchObject({ skip: null, scale: 0.75 });
    expect(r.note).toContain('75%');
    expect(
      evaluateSkipRules(rules({ etScaling: true, maxScale: 1.2 }), { ...outlook, et0Mm: 8 }).scale,
    ).toBe(1.2);
    expect(
      evaluateSkipRules(rules({ etScaling: true, minScale: 0.8 }), { ...outlook, et0Mm: 1 }).scale,
    ).toBe(0.8);
    expect(
      evaluateSkipRules(rules({ etScaling: true }), { ...outlook, et0BaselineMm: 0 }).scale,
    ).toBe(1);
  });

  it('checks rain before scaling', () => {
    expect(evaluateSkipRules(rules({ etScaling: true, rainForecastMm: 2 }), outlook).skip).toBe(
      '8 mm rain forecast',
    );
  });
});
