import { describe, expect, it } from 'vitest';
import {
  cToTemp,
  defaultUnits,
  formatDepth,
  formatFlow,
  formatTemp,
  formatVolume,
  mlToVolume,
} from './units';

describe('defaultUnits', () => {
  it('is imperial for en-US and metric elsewhere', () => {
    expect(defaultUnits('en-US')).toBe('imperial');
    expect(defaultUnits('en-GB')).toBe('metric');
    expect(defaultUnits('de-DE')).toBe('metric');
    expect(defaultUnits('')).toBe('metric');
  });
});

describe('metric formatting', () => {
  it('scales liters', () => {
    expect(formatVolume(4_200, 'metric')).toBe('4.2 L');
    expect(formatVolume(48_000, 'metric')).toBe('48 L');
    expect(formatVolume(1_250_000, 'metric')).toBe('1,250 L');
    expect(formatVolume(25_000_000, 'metric')).toBe('25.0 kL');
  });
  it('formats depth, temperature and flow', () => {
    expect(formatDepth(4.26, 'metric')).toBe('4.3 mm');
    expect(formatDepth(null, 'metric')).toBe('—');
    expect(formatTemp(20.4, 'metric')).toBe('20°');
    expect(formatTemp(null, 'metric')).toBe('—');
    expect(formatFlow(1_234, 'metric')).toBe('1.2 L/min');
  });
});

describe('imperial formatting', () => {
  it('converts to gallons', () => {
    expect(mlToVolume(3785.411784, 'imperial')).toBeCloseTo(1, 6);
    expect(formatVolume(18_927, 'imperial')).toBe('5.0 gal');
    expect(formatVolume(1_000_000, 'imperial')).toBe('264 gal');
    expect(formatVolume(60_000_000, 'imperial')).toBe('15.9k gal');
  });
  it('converts inches, fahrenheit and flow', () => {
    expect(formatDepth(25.4, 'imperial')).toBe('1 in');
    expect(formatDepth(4.3, 'imperial')).toBe('0.17 in');
    expect(cToTemp(100, 'imperial')).toBe(212);
    expect(formatTemp(20, 'imperial')).toBe('68°');
    expect(formatFlow(3785.411784, 'imperial')).toBe('1 gal/min');
  });
});
