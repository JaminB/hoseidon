import { z } from 'zod';
import {
  appSettingsSchema,
  authSessionSchema,
  CSRF_HEADER,
  linktapTestSchema,
  passkeySchema,
  pushStatusSchema,
  webhookInfoSchema,
  type AppSettings,
  type PushPrefs,
  type PushSubscriptionInput,
  analyticsSchema,
  analyticsSummarySchema,
  commandResultSchema,
  deviceSchema,
  diagnosisSchema,
  eventSchema,
  gatewaySchema,
  gatewayWithDevicesSchema,
  gcalStatusSchema,
  healthSchema,
  networkOverviewSchema,
  networkSettingsSchema,
  plannedRunSchema,
  previewOccurrenceSchema,
  scheduleSchema,
  weatherResponseSchema,
  type DismissableAlarm,
  type QuickAddResult,
  type ScheduleInput,
  type SchedulePatch,
} from '@hoseidon/shared';

/** Fired when any call comes back 401, so the app can drop to the login page. */
export const SIGNED_OUT_EVENT = 'hoseidon:signed-out';

/** A non-2xx answer from the Hoseidon API, carrying the server's `error` message. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Skip the "signed out" broadcast on 401 (the login form handles its own). */
  quiet401?: boolean;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
}

async function request<S extends z.ZodType>(
  path: string,
  schema: S,
  { method = 'GET', body, query, quiet401 }: RequestOptions = {},
): Promise<z.infer<S>> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) params.set(k, String(v));
  const qs = params.size ? `?${params}` : '';
  const res = await fetch(`/api${path}${qs}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      // Proves the request came from our own page (see the API guard on the server).
      [CSRF_HEADER]: '1',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && !quiet401) window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, data?.error ?? `${res.status} ${res.statusText}`);
  }
  if (res.status === 204) return schema.parse(null);
  return schema.parse(await res.json());
}

// The quick-add result is a plain interface in shared; a loose schema is enough at the boundary.
const quickAddResultSchema = z.custom<QuickAddResult>(
  (v) => typeof v === 'object' && v !== null && 'draft' in v,
);

const linktapStatusSchema = z.object({
  mock: z.boolean(),
  nextAvailableAt: z.object({ devices: z.string(), history: z.string(), command: z.string() }),
  poller: z
    .object({
      running: z.boolean(),
      last: z.record(
        z.string(),
        z.object({ at: z.string().nullable(), error: z.string().nullable() }),
      ),
    })
    .nullable(),
});
/** WebAuthn options come back as a loose object; @simplewebauthn/browser validates them. */
const challengeSchema = z.object({
  options: z.record(z.string(), z.unknown()),
  challengeId: z.string(),
});

export type LinkTapStatus = z.infer<typeof linktapStatusSchema>;

export const api = {
  session: () => request('/auth/session', authSessionSchema, { quiet401: true }),
  login: (password: string) =>
    request('/auth/login', authSessionSchema, {
      method: 'POST',
      body: { password },
      quiet401: true,
    }),
  logout: () => request('/auth/logout', authSessionSchema, { method: 'POST' }),
  passkeys: () => request('/auth/passkeys', z.array(passkeySchema)),
  deletePasskey: (id: string) =>
    request(`/auth/passkeys/${encodeURIComponent(id)}`, z.array(passkeySchema), {
      method: 'DELETE',
    }),
  passkeyRegisterOptions: () =>
    request('/auth/passkey/register/options', challengeSchema, { method: 'POST' }),
  passkeyRegisterVerify: (challengeId: string, response: unknown, name: string) =>
    request('/auth/passkey/register/verify', z.array(passkeySchema), {
      method: 'POST',
      body: { challengeId, response, name },
    }),
  passkeyLoginOptions: () =>
    request('/auth/passkey/login/options', challengeSchema, { method: 'POST', quiet401: true }),
  passkeyLoginVerify: (challengeId: string, response: unknown) =>
    request('/auth/passkey/login/verify', authSessionSchema, {
      method: 'POST',
      body: { challengeId, response },
      quiet401: true,
    }),

  appSettings: () => request('/settings', appSettingsSchema),
  patchAppSettings: (patch: Partial<Pick<AppSettings, 'timeZone'>>) =>
    request('/settings', appSettingsSchema, { method: 'PATCH', body: patch }),
  push: () => request('/push', pushStatusSchema),
  pushSubscribe: (sub: PushSubscriptionInput) =>
    request('/push/subscribe', pushStatusSchema, { method: 'POST', body: sub }),
  pushUnsubscribe: (endpoint: string) =>
    request('/push/unsubscribe', pushStatusSchema, { method: 'POST', body: { endpoint } }),
  pushPrefs: (prefs: Partial<PushPrefs>) =>
    request('/push/prefs', pushStatusSchema, { method: 'PATCH', body: prefs }),
  pushTest: () =>
    request('/push/test', z.object({ sent: z.number(), failed: z.number() }), { method: 'POST' }),
  linktapTest: () => request('/linktap/test', linktapTestSchema, { method: 'POST' }),
  webhook: () => request('/linktap/webhook', webhookInfoSchema),
  registerWebhook: () =>
    request('/linktap/webhook/register', webhookInfoSchema, {
      method: 'POST',
      body: { confirm: true },
    }),
  health: () => request('/health', healthSchema),
  gateways: () => request('/gateways', z.array(gatewayWithDevicesSchema)),
  patchGateway: (
    id: string,
    patch: {
      name?: string | null;
      lat?: number | null;
      lon?: number | null;
      timezone?: string | null;
    },
  ) => request(`/gateways/${id}`, gatewaySchema, { method: 'PATCH', body: patch }),
  patchDevice: (id: string, patch: { name?: string | null; zone?: string | null }) =>
    request(`/devices/${id}`, deviceSchema, { method: 'PATCH', body: patch }),
  run: (id: string, seconds: number) =>
    request(`/devices/${id}/run`, commandResultSchema, { method: 'POST', body: { seconds } }),
  stop: (id: string) => request(`/devices/${id}/stop`, commandResultSchema, { method: 'POST' }),
  dismissAlarm: (id: string, alarm: DismissableAlarm) =>
    request(`/devices/${id}/dismiss-alarm`, commandResultSchema, {
      method: 'POST',
      body: { alarm },
    }),
  events: (limit = 20) => request('/events', z.array(eventSchema), { query: { limit } }),
  linktapStatus: () => request('/linktap/status', linktapStatusSchema),

  schedules: () => request('/schedules', z.array(scheduleSchema)),
  createSchedule: (input: ScheduleInput) =>
    request('/schedules', scheduleSchema, { method: 'POST', body: input }),
  patchSchedule: (id: number, patch: SchedulePatch) =>
    request(`/schedules/${id}`, scheduleSchema, { method: 'PATCH', body: patch }),
  deleteSchedule: (id: number) => request(`/schedules/${id}`, z.null(), { method: 'DELETE' }),
  preview: (from: Date, to: Date) =>
    request('/schedules/preview', z.array(previewOccurrenceSchema), {
      query: { from: from.toISOString(), to: to.toISOString() },
    }),
  quickAdd: (text: string) =>
    request('/schedules/quick-add', quickAddResultSchema, { method: 'POST', body: { text } }),
  plannedRuns: (from: Date, to: Date) =>
    request('/planned-runs', z.array(plannedRunSchema), {
      query: { from: from.toISOString(), to: to.toISOString() },
    }),
  weather: (gatewayId: string, from: string, to: string) =>
    request(`/weather/${gatewayId}`, weatherResponseSchema, { query: { from, to } }),
  deviceAnalytics: (id: string, from: string, to: string) =>
    request(`/analytics/devices/${id}`, analyticsSchema, { query: { from, to } }),
  analyticsSummary: (from: string, to: string) =>
    request('/analytics/summary', analyticsSummarySchema, { query: { from, to } }),
  networkOverview: (days: number) =>
    request('/network/overview', networkOverviewSchema, { query: { days } }),
  networkSettings: () => request('/network/settings', networkSettingsSchema),
  patchNetworkSettings: (weakSignalPct: number) =>
    request('/network/settings', networkSettingsSchema, {
      method: 'PATCH',
      body: { weakSignalPct },
    }),
  diagnose: (deviceId: string) =>
    request(`/diagnose/${deviceId}`, diagnosisSchema, { method: 'POST' }),
  gcalStatus: () => request('/gcal/status', gcalStatusSchema),
  gcalDisconnect: () => request('/gcal/disconnect', gcalStatusSchema, { method: 'POST' }),
  gcalResync: () => request('/gcal/resync', gcalStatusSchema, { method: 'POST' }),
  gcalSettings: (logRuns: boolean) =>
    request('/gcal/settings', gcalStatusSchema, { method: 'PATCH', body: { logRuns } }),
  skipPlannedRun: (id: number, wholeOccurrence = true) =>
    request(`/planned-runs/${id}/skip`, z.array(plannedRunSchema), {
      method: 'POST',
      body: { wholeOccurrence },
    }),
};

/** The OAuth flow is a full-page navigation: the server redirects to Google and back. */
export const GCAL_CONNECT_URL = '/api/gcal/connect';

/** Open-Meteo geocoding (free, no key, CORS-enabled). Called straight from the browser. */
const geocodeSchema = z.object({
  results: z
    .array(
      z.object({
        id: z.number(),
        name: z.string(),
        latitude: z.number(),
        longitude: z.number(),
        timezone: z.string().optional(),
        country: z.string().optional(),
        country_code: z.string().optional(),
        admin1: z.string().optional(),
        postcodes: z.array(z.string()).optional(),
      }),
    )
    .optional(),
});
export type GeocodeResult = NonNullable<z.infer<typeof geocodeSchema>['results']>[number];

export async function geocode(query: string, signal?: AbortSignal): Promise<GeocodeResult[]> {
  const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
  url.searchParams.set('name', query.trim());
  url.searchParams.set('count', '6');
  url.searchParams.set('language', navigator.language.split('-')[0] ?? 'en');
  url.searchParams.set('format', 'json');
  // A bare ZIP is ambiguous worldwide; bias to the browser's country when it's a postcode.
  const region = navigator.language.split('-')[1];
  if (/^\d{4,6}$/.test(query.trim()) && region) url.searchParams.set('countryCode', region);
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Geocoding failed (${res.status})`);
  return geocodeSchema.parse(await res.json()).results ?? [];
}
