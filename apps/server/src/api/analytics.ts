import { eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { WEATHER_ATTRIBUTION, type Analytics, type WeatherResponse } from '@hoseidon/shared';
import { analyze } from '../analytics/aggregate';
import type { Db } from '../db';
import { devices, gateways } from '../db/schema';
import { addDays, dateInZone, diffDays, isLocalDate, isValidTimeZone } from '../weather/dates';
import type { OpenMeteoProvider } from '../weather/open-meteo';
import { HttpError, onApiError } from './http';

export interface AnalyticsApiDeps {
  db: Db;
  weather?: OpenMeteoProvider;
  /** Fallback time zone for gateways that have none. */
  timeZone: string;
}

const MAX_DAYS = 400;

/** `from`/`to` query params as local dates; defaults are relative to today in `tz`. */
function dateWindow(c: Context, tz: string, defaults: { back: number; ahead: number }) {
  const today = dateInZone(new Date(), tz);
  const from = c.req.query('from') ?? addDays(today, -defaults.back);
  const to = c.req.query('to') ?? addDays(today, defaults.ahead);
  if (!isLocalDate(from) || !isLocalDate(to))
    throw new HttpError(400, 'from/to must be YYYY-MM-DD');
  if (to < from || diffDays(to, from) >= MAX_DAYS) {
    throw new HttpError(400, `range must be 1-${MAX_DAYS} days`);
  }
  return { today, from, to };
}

export function analyticsRoutes({ db, weather, timeZone }: AnalyticsApiDeps) {
  const api = new Hono();
  api.onError(onApiError);

  const zoneOf = (gatewayTz: string | null) =>
    gatewayTz && isValidTimeZone(gatewayTz) ? gatewayTz : timeZone;

  api.get('/weather/:gatewayId', async (c) => {
    const gw = db
      .select()
      .from(gateways)
      .where(eq(gateways.id, c.req.param('gatewayId')))
      .get();
    if (!gw) throw new HttpError(404, 'gateway not found');
    const tz = zoneOf(gw.timezone);
    const { today, from, to } = dateWindow(c, tz, { back: 7, ahead: 7 });
    const located = weather && gw.lat !== null && gw.lon !== null;
    const days = located
      ? await weather.range({ lat: gw.lat!, lon: gw.lon!, timezone: tz }, from, to)
      : [];
    const body: WeatherResponse = {
      gatewayId: gw.id,
      available: !!located,
      timezone: located ? tz : null,
      today,
      days,
      attribution: WEATHER_ATTRIBUTION,
    };
    return c.json(body);
  });

  api.get('/analytics/devices/:id', (c) => {
    const row = db
      .select({ device: devices, tz: gateways.timezone })
      .from(devices)
      .leftJoin(gateways, eq(devices.gatewayId, gateways.id))
      .where(eq(devices.id, c.req.param('id')))
      .get();
    if (!row) throw new HttpError(404, 'device not found');
    const tz = zoneOf(row.tz);
    const { from, to } = dateWindow(c, tz, { back: 29, ahead: 0 });
    const name = row.device.name ?? row.device.linktapName;
    const analytics: Analytics = analyze(db, [{ id: row.device.id, name }], from, to, tz);
    // The per-device breakdown is only meaningful for the summary.
    return c.json({ ...analytics, devices: undefined });
  });

  api.get('/analytics/summary', (c) => {
    const { from, to } = dateWindow(c, timeZone, { back: 29, ahead: 0 });
    const all = db
      .select()
      .from(devices)
      .all()
      .map((d) => ({ id: d.id, name: d.name ?? d.linktapName }));
    return c.json(analyze(db, all, from, to, timeZone));
  });

  return api;
}
