import { Hono } from 'hono';
import { gcalSettingsPatchSchema } from '@hoseidon/shared';
import type { GcalService } from '../gcal/service';
import { body, HttpError, onApiError } from './http';

/**
 * Google Calendar: status, the OAuth round trip, and sync controls.
 * `connect` and `callback` are browser navigations (redirects), the rest are JSON.
 */
export function gcalRoutes({ gcal }: { gcal: GcalService }) {
  const api = new Hono();
  api.onError(onApiError);

  api.get('/gcal/status', (c) => c.json(gcal.status()));

  api.get('/gcal/connect', (c) => {
    if (!gcal.configured)
      return c.redirect(gcal.settingsUrl({ ok: false, reason: 'not_configured' }));
    return c.redirect(gcal.connectUrl());
  });

  api.get('/gcal/callback', async (c) => {
    const result = await gcal.handleCallback({
      code: c.req.query('code'),
      state: c.req.query('state'),
      error: c.req.query('error'),
    });
    return c.redirect(gcal.settingsUrl(result));
  });

  api.post('/gcal/disconnect', async (c) => {
    await gcal.disconnect();
    return c.json(gcal.status());
  });

  api.post('/gcal/resync', async (c) => {
    if (!gcal.status().connected) throw new HttpError(409, 'Google Calendar is not connected');
    await gcal.resync();
    return c.json(gcal.status());
  });

  api.patch('/gcal/settings', async (c) => {
    const { logRuns } = await body(c, gcalSettingsPatchSchema);
    gcal.setLogRuns(logRuns);
    return c.json(gcal.status());
  });

  return api;
}
