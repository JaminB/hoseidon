import { describe, expect, it, vi } from 'vitest';
import { harness } from '../test-utils';
import { resolveTimeZone } from './settings';

const send = (method: string, body?: unknown) => ({
  method,
  headers: { 'content-type': 'application/json', 'x-hoseidon-csrf': '1' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

describe('time zone setting', () => {
  it('defaults to the active zone, saves a valid one, and rejects junk', async () => {
    const { app, db } = harness();
    expect(await (await app.request('/api/settings')).json()).toEqual({
      timeZone: 'UTC',
      activeTimeZone: 'UTC',
    });
    const saved = await app.request('/api/settings', send('PATCH', { timeZone: 'America/Denver' }));
    expect(await saved.json()).toEqual({ timeZone: 'America/Denver', activeTimeZone: 'UTC' });
    expect(resolveTimeZone(db, 'UTC')).toBe('America/Denver');
    const bad = await app.request('/api/settings', send('PATCH', { timeZone: 'Mars/Olympus' }));
    expect(bad.status).toBe(400);
  });
});

describe('LinkTap connection test', () => {
  it('talks to the mock, never the real cloud', async () => {
    const { app } = harness();
    const res = await app.request('/api/linktap/test', send('POST'));
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, mock: true, cached: false });
    expect(json.gateways).toBeGreaterThan(0);
    expect(json.devices).toBeGreaterThan(0);
    expect(json.message).toMatch(/mock/i);
  });

  it('reports a failure instead of throwing', async () => {
    const { app, client } = harness();
    vi.spyOn(client, 'getAllDevices').mockRejectedValue(new Error('bad key'));
    const json = await (await app.request('/api/linktap/test', send('POST'))).json();
    expect(json).toMatchObject({ ok: false, message: 'bad key' });
  });

  it('reuses the last poll while LinkTap rate-limits getAllDevices', async () => {
    const { app, client, poller } = harness();
    await poller.pollDevices();
    vi.spyOn(client, 'nextAvailableAt').mockReturnValue(new Date(Date.now() + 200_000));
    const spy = vi.spyOn(client, 'getAllDevices');
    const json = await (await app.request('/api/linktap/test', send('POST'))).json();
    expect(spy).not.toHaveBeenCalled();
    expect(json).toMatchObject({ ok: true, cached: true });
    expect(json.devices).toBeGreaterThan(0);
  });
});

describe('webhook registration', () => {
  const live = {
    LINKTAP_MOCK: 'false',
    LINKTAP_USERNAME: 'u',
    LINKTAP_API_KEY: 'k',
    PUBLIC_URL: 'https://hose.example.com/',
    WEBHOOK_SECRET: 'sekret',
  };

  it('shows the URL but refuses to register in mock mode', async () => {
    const { app, client } = harness({ env: { PUBLIC_URL: 'https://hose.example.com' } });
    const spy = vi.spyOn(client, 'setWebHookUrl');
    const info = await (await app.request('/api/linktap/webhook')).json();
    expect(info.url).toBe('https://hose.example.com/hooks/linktap/s3cret');
    expect(info.blockedReason).toMatch(/mock/i);
    const res = await app.request('/api/linktap/webhook/register', send('POST', { confirm: true }));
    expect(res.status).toBe(409);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses without a public https URL', async () => {
    const { app, client } = harness({ env: { ...live, PUBLIC_URL: 'http://localhost:8787' } });
    const spy = vi.spyOn(client, 'setWebHookUrl');
    const info = await (await app.request('/api/linktap/webhook')).json();
    expect(info.blockedReason).toMatch(/PUBLIC_URL/);
    expect(
      (await app.request('/api/linktap/webhook/register', send('POST', { confirm: true }))).status,
    ).toBe(409);
    expect(spy).not.toHaveBeenCalled();
  });

  it('registers the secret URL once confirmed', async () => {
    const { app, client } = harness({ env: live });
    const spy = vi.spyOn(client, 'setWebHookUrl').mockResolvedValue();
    const unconfirmed = await app.request('/api/linktap/webhook/register', send('POST', {}));
    expect(unconfirmed.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
    const res = await app.request('/api/linktap/webhook/register', send('POST', { confirm: true }));
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith('https://hose.example.com/hooks/linktap/sekret');
  });

  it('surfaces a LinkTap failure as 502', async () => {
    const { app, client } = harness({ env: live });
    const { LinkTapError } = await import('../linktap/client');
    vi.spyOn(client, 'setWebHookUrl').mockRejectedValue(new LinkTapError('setWebHookUrl', 'nope'));
    const res = await app.request('/api/linktap/webhook/register', send('POST', { confirm: true }));
    expect(res.status).toBe(502);
  });
});
