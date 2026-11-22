import { z } from 'zod';

/** What the login page needs to know, and whether this browser is signed in. */
export const authSessionSchema = z.object({
  authenticated: z.boolean(),
  /** False until ADMIN_PASSWORD is set, so nobody can sign in yet. */
  configured: z.boolean(),
  /** A passkey is registered, so the login page can offer it. */
  passkeys: z.boolean(),
});
export type AuthSession = z.infer<typeof authSessionSchema>;

export const loginInputSchema = z.object({ password: z.string().min(1).max(512) });

export const passkeySchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
});
export type Passkey = z.infer<typeof passkeySchema>;

/** Header every mutating /api request must carry. A cross-site form or fetch cannot set it. */
export const CSRF_HEADER = 'x-hoseidon-csrf';

// ---- Web Push ---------------------------------------------------------------------------------

export const PUSH_CATEGORIES = ['alarm', 'offline', 'failed', 'skipped'] as const;
export const pushCategorySchema = z.enum(PUSH_CATEGORIES);
export type PushCategory = z.infer<typeof pushCategorySchema>;

export const PUSH_CATEGORY_LABEL: Record<PushCategory, { label: string; hint: string }> = {
  alarm: { label: 'Alarms', hint: 'No water, broken valve, leak, fall or clog alarms.' },
  offline: { label: 'Offline', hint: 'A gateway or timer stops answering.' },
  failed: { label: 'Failed runs', hint: 'A scheduled run did not start, or was missed.' },
  skipped: { label: 'Skipped runs', hint: 'Rain, freeze or wind held a run back.' },
};

export const pushPrefsSchema = z.object({
  alarm: z.boolean(),
  offline: z.boolean(),
  failed: z.boolean(),
  skipped: z.boolean(),
});
export type PushPrefs = z.infer<typeof pushPrefsSchema>;
export const DEFAULT_PUSH_PREFS: PushPrefs = {
  alarm: true,
  offline: true,
  failed: true,
  skipped: false,
};

export const pushStatusSchema = z.object({
  /** VAPID public key (base64url), for PushManager.subscribe. */
  publicKey: z.string(),
  subscriptions: z.number().int(),
  prefs: pushPrefsSchema,
});
export type PushStatus = z.infer<typeof pushStatusSchema>;

export const pushSubscriptionInputSchema = z.object({
  endpoint: z.url().max(2048),
  keys: z.object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(256) }),
});
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionInputSchema>;

export const pushPayloadSchema = z.object({
  title: z.string(),
  body: z.string(),
  tag: z.string(),
  url: z.string(),
});
export type PushPayload = z.infer<typeof pushPayloadSchema>;

// ---- Settings page ----------------------------------------------------------------------------

export const appSettingsSchema = z.object({
  /** The zone saved in settings (or the server's, if none). */
  timeZone: z.string(),
  /** The zone the running server is actually using. A change needs a restart. */
  activeTimeZone: z.string(),
});
export type AppSettings = z.infer<typeof appSettingsSchema>;
export const appSettingsPatchSchema = z.object({ timeZone: z.string().min(1).max(64) });

export const linktapTestSchema = z.object({
  ok: z.boolean(),
  mock: z.boolean(),
  message: z.string(),
  gateways: z.number().int(),
  devices: z.number().int(),
  /** True when we reused the last poll because LinkTap's 5-minute limit was still running. */
  cached: z.boolean(),
});
export type LinkTapTest = z.infer<typeof linktapTestSchema>;

export const webhookInfoSchema = z.object({
  /** Full URL to register, secret included. Null when WEBHOOK_SECRET is not set. */
  url: z.string().nullable(),
  /** Why registering is not possible right now, or null when it is. */
  blockedReason: z.string().nullable(),
});
export type WebhookInfo = z.infer<typeof webhookInfoSchema>;
