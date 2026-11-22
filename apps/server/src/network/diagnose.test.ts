import { describe, expect, it } from 'vitest';
import { diagnose, type DiagnoseInput } from './diagnose';

const NOW = Date.UTC(2026, 5, 1, 12);
const MIN = 60_000;

const healthy = (over: Partial<DiagnoseInput> = {}): DiagnoseInput => ({
  now: NOW,
  device: {
    id: 'd1',
    name: 'Front Lawn',
    online: true,
    lastSeenAt: NOW,
    signalPct: 80,
    batteryPct: 90,
    alarms: [],
    workMode: 'M',
  },
  gateway: { name: 'Backyard', online: true, lastSeenAt: NOW },
  weakSignalPct: 40,
  lastSnapshotAt: NOW - 2 * MIN,
  failedStarts: [],
  webhook: { configured: true, lastEventAt: NOW - 60 * MIN },
  cloud: { lastOkAt: NOW - 2 * MIN, lastErrorAt: null, lastError: null },
  batteryDaysLeft: null,
  ...over,
});

const status = (d: ReturnType<typeof diagnose>, id: string) =>
  d.checks.find((c) => c.id === id)?.status;

describe('diagnose', () => {
  it('passes everything for a healthy timer, with no fixes', () => {
    const d = diagnose(healthy());
    expect(d.verdict).toBe('ok');
    expect(d.checks).toHaveLength(10);
    expect(d.checks.every((c) => c.status === 'pass' && c.fix === null)).toBe(true);
  });

  it('blames the gateway when it is offline, and leaves signal unknown', () => {
    const d = diagnose(
      healthy({
        gateway: { name: 'Backyard', online: false, lastSeenAt: NOW - 90 * MIN },
        device: { ...healthy().device, online: false },
      }),
    );
    expect(d.verdict).toBe('fail');
    expect(status(d, 'gateway')).toBe('fail');
    expect(d.checks.find((c) => c.id === 'gateway')?.detail).toContain('Last seen 2 h ago');
    expect(d.checks.find((c) => c.id === 'device')?.detail).toContain('its gateway');
    expect(status(d, 'signal')).toBe('unknown');
    expect(d.summary).toContain('Start with');
  });

  it('flags an offline timer behind an online gateway', () => {
    const d = diagnose(healthy({ device: { ...healthy().device, online: false } }));
    expect(status(d, 'gateway')).toBe('pass');
    expect(status(d, 'device')).toBe('fail');
    expect(d.checks.find((c) => c.id === 'device')?.fix).toMatch(/batteries/);
  });

  it('uses the configured threshold for signal, and escalates when very weak', () => {
    expect(
      status(diagnose(healthy({ device: { ...healthy().device, signalPct: 45 } })), 'signal'),
    ).toBe('pass');
    expect(
      status(
        diagnose(healthy({ device: { ...healthy().device, signalPct: 45 }, weakSignalPct: 60 })),
        'signal',
      ),
    ).toBe('warn');
    expect(
      status(diagnose(healthy({ device: { ...healthy().device, signalPct: 10 } })), 'signal'),
    ).toBe('fail');
  });

  it('grades battery and mentions days left', () => {
    const warn = diagnose(
      healthy({ device: { ...healthy().device, batteryPct: 15 }, batteryDaysLeft: 9 }),
    );
    expect(status(warn, 'battery')).toBe('warn');
    expect(warn.checks.find((c) => c.id === 'battery')?.detail).toContain('9 days');
    expect(
      status(diagnose(healthy({ device: { ...healthy().device, batteryPct: 5 } })), 'battery'),
    ).toBe('fail');
  });

  it('reports alarms and LinkTap plan conflicts', () => {
    const d = diagnose(
      healthy({ device: { ...healthy().device, alarms: ['noWater'], workMode: 'T' } }),
    );
    expect(status(d, 'alarms')).toBe('fail');
    expect(status(d, 'plan')).toBe('warn');
    expect(d.verdict).toBe('fail');
  });

  it('grades data age: fresh, stale, very stale, never', () => {
    const at = (ms: number | null) =>
      status(diagnose(healthy({ lastSnapshotAt: ms })), 'freshness');
    expect(at(NOW - 4 * MIN)).toBe('pass');
    expect(at(NOW - 40 * MIN)).toBe('warn');
    expect(at(NOW - 5 * 60 * MIN)).toBe('fail');
    expect(at(null)).toBe('fail');
  });

  it('fails the cloud check only while the latest call is an error', () => {
    const failing = healthy({
      cloud: { lastOkAt: NOW - 30 * MIN, lastErrorAt: NOW - MIN, lastError: 'bad key' },
    });
    expect(status(diagnose(failing), 'cloud')).toBe('fail');
    expect(diagnose(failing).checks.find((c) => c.id === 'cloud')?.detail).toContain('bad key');
    const recovered = healthy({
      cloud: { lastOkAt: NOW - MIN, lastErrorAt: NOW - 30 * MIN, lastError: 'x' },
    });
    expect(status(diagnose(recovered), 'cloud')).toBe('pass');
    expect(
      status(
        diagnose(healthy({ cloud: { lastOkAt: null, lastErrorAt: null, lastError: null } })),
        'cloud',
      ),
    ).toBe('unknown');
  });

  it('counts recent failed starts', () => {
    const d = diagnose(
      healthy({ failedStarts: [{ at: NOW - 3 * 60 * MIN, error: 'timer offline' }] }),
    );
    expect(status(d, 'starts')).toBe('fail');
    expect(d.checks.find((c) => c.id === 'starts')?.detail).toContain('timer offline');
  });

  it('distinguishes webhook not configured, never received, and working', () => {
    const wh = (webhook: DiagnoseInput['webhook']) => diagnose(healthy({ webhook }));
    expect(status(wh({ configured: false, lastEventAt: null }), 'webhook')).toBe('warn');
    expect(
      wh({ configured: true, lastEventAt: null }).checks.find((c) => c.id === 'webhook')?.detail,
    ).toContain('never called');
    expect(status(wh({ configured: true, lastEventAt: NOW }), 'webhook')).toBe('pass');
    // Warnings alone give a "warn" verdict.
    expect(wh({ configured: false, lastEventAt: null }).verdict).toBe('warn');
  });
});
