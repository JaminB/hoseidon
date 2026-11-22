import { z } from 'zod';

/** Google Calendar one-way sync (Hoseidon -> Google). */

export const GCAL_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
export const GCAL_CALENDAR_NAME = '🔱 Hoseidon';
/** Google expires refresh tokens of apps in "Testing" publishing status after 7 days. */
export const GCAL_TESTING_TOKEN_DAYS = 7;

export const gcalSyncStateSchema = z.enum(['idle', 'pending', 'running', 'backoff', 'paused']);
export type GcalSyncState = z.infer<typeof gcalSyncStateSchema>;

export const gcalStatusSchema = z.object({
  /** GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and a usable SESSION_SECRET are all set. */
  configured: z.boolean(),
  /** Env vars that still need setting. */
  missing: z.array(z.string()),
  /** Paste this into the Google Cloud OAuth client's "Authorized redirect URIs". */
  redirectUri: z.string(),
  connected: z.boolean(),
  /** Google rejected the stored token; the user has to connect again. */
  needsReconnect: z.boolean(),
  calendarId: z.string().nullable(),
  calendarUrl: z.string().nullable(),
  connectedAt: z.string().nullable(),
  /** When a Testing-mode app's token runs out (connectedAt + 7 days). */
  reconnectDueAt: z.string().nullable(),
  lastSyncAt: z.string().nullable(),
  lastError: z.string().nullable(),
  sync: z.object({
    state: gcalSyncStateSchema,
    nextRunAt: z.string().nullable(),
    failures: z.number().int(),
  }),
  events: z.object({
    schedules: z.number().int(),
    skips: z.number().int(),
    logs: z.number().int(),
  }),
  /** Also write finished runs to the calendar as past events. */
  logRuns: z.boolean(),
});
export type GcalStatus = z.infer<typeof gcalStatusSchema>;

export const gcalSettingsPatchSchema = z.object({ logRuns: z.boolean() });
export type GcalSettingsPatch = z.infer<typeof gcalSettingsPatchSchema>;
