import { describe, expect, it } from 'vitest';
import { healthSchema } from '@hoseidon/shared';
import { createApp } from './app';
import { loadConfig } from './config';
import { openDb } from './db';

describe('app', () => {
  const config = loadConfig({ LINKTAP_MOCK: 'true', WEB_DIST: './nonexistent' });
  const app = createApp(config);

  it('serves /api/health', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(healthSchema.parse(await res.json()).mock).toBe(true);
  });

  it('404s unknown api routes as JSON', async () => {
    const res = await app.request('/api/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });
});

describe('config', () => {
  it('treats blank env values as unset', () => {
    expect(loadConfig({ PORT: '' }).PORT).toBe(8787);
  });
});

describe('db', () => {
  it('bootstraps the settings table', () => {
    const { sqlite } = openDb(':memory:');
    expect(sqlite.prepare('select count(*) c from settings').get()).toEqual({ c: 0 });
  });
});
