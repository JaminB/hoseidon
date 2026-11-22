import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { edgeCheck, MAX_API_BODY, MAX_HOOK_BODY } from '../src/edge';

const req = (path: string, init: RequestInit = {}) =>
  new Request(`https://hose.example.com${path}`, init);

describe('edgeCheck', () => {
  it('passes reads and well-formed mutations through', () => {
    expect(edgeCheck(req('/api/gateways'))).toBeNull();
    expect(
      edgeCheck(
        req('/api/schedules', {
          method: 'POST',
          headers: { 'x-hoseidon-csrf': '1', origin: 'https://hose.example.com' },
        }),
      ),
    ).toBeNull();
    expect(edgeCheck(req('/hooks/linktap/secret', { method: 'POST' }))).toBeNull();
  });

  it('refuses mutations without the CSRF header or from another origin', async () => {
    const missing = edgeCheck(req('/api/auth/login', { method: 'POST' }));
    expect(missing?.status).toBe(403);
    const foreign = edgeCheck(
      req('/api/auth/login', {
        method: 'POST',
        headers: { 'x-hoseidon-csrf': '1', origin: 'https://evil.example.net' },
      }),
    );
    expect(foreign?.status).toBe(403);
    expect(await foreign?.json()).toEqual({ error: 'cross-site request refused' });
    const crossSite = edgeCheck(
      req('/api/auth/login', {
        method: 'POST',
        headers: { 'x-hoseidon-csrf': '1', 'sec-fetch-site': 'cross-site' },
      }),
    );
    expect(crossSite?.status).toBe(403);
  });

  it('caps body sizes and only takes POSTs on /hooks', () => {
    const big = (n: number) => ({ 'content-length': String(n), 'x-hoseidon-csrf': '1' });
    expect(
      edgeCheck(req('/api/x', { method: 'POST', headers: big(MAX_API_BODY + 1) }))?.status,
    ).toBe(413);
    expect(
      edgeCheck(req('/hooks/linktap/s', { method: 'POST', headers: big(MAX_HOOK_BODY + 1) }))
        ?.status,
    ).toBe(413);
    expect(edgeCheck(req('/hooks/linktap/s'))?.status).toBe(404);
  });
});

describe('migrations.gen.ts', () => {
  it('matches apps/server/drizzle (run `pnpm --filter @hoseidon/worker gen` after db:generate)', () => {
    const script = join(dirname(fileURLToPath(import.meta.url)), '../scripts/gen-migrations.mjs');
    expect(() =>
      execFileSync(process.execPath, [script, '--check'], { stdio: 'pipe' }),
    ).not.toThrow();
  });
});
