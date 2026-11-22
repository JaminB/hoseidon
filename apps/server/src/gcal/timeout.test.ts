import { describe, expect, it } from 'vitest';
import { geocodeLocality } from '../linktap/location';
import { CalendarApi } from './calendar';
import { exchangeCode, refreshAccessToken, revokeToken } from './oauth';

/** A hung Google or geocoding call would stall the Durable Object's one alarm handler. */
function spy(body: unknown = {}) {
  const signals: (AbortSignal | null | undefined)[] = [];
  const fetchFn = (async (_url: unknown, init?: RequestInit) => {
    signals.push(init?.signal);
    return Response.json(body);
  }) as typeof fetch;
  return { signals, fetchFn };
}
const client = { clientId: 'id', clientSecret: 's', redirectUri: 'https://x/cb' };
const token = { access_token: 'a', expires_in: 3600 };

describe('outbound timeouts', () => {
  it('put an AbortSignal on every Google and geocode call', async () => {
    const a = spy(token);
    await exchangeCode(a.fetchFn, client, 'c', 'v');
    await refreshAccessToken(a.fetchFn, client, 'r');
    await revokeToken(a.fetchFn, 't');
    const b = spy({ items: [] });
    await new CalendarApi({ fetch: b.fetchFn, token: async () => 't' }).instances(
      'cal',
      'ev',
      new Date(0),
      new Date(1),
    );
    const c = spy({ results: [] });
    await geocodeLocality('Springfield', c.fetchFn);
    for (const s of [...a.signals, ...b.signals, ...c.signals])
      expect(s).toBeInstanceOf(AbortSignal);
    expect(a.signals).toHaveLength(3);
    expect(b.signals).toHaveLength(1);
    expect(c.signals).toHaveLength(1);
  });
});
