import { z } from 'zod';

export const USER_ROLES = ['admin', 'member'] as const;
export const userRoleSchema = z.enum(USER_ROLES);
export type UserRole = z.infer<typeof userRoleSchema>;

/** What the login page needs to know, and whether (and as whom) this browser is signed in. */
export const authSessionSchema = z.object({
  authenticated: z.boolean(),
  /** False while no way to sign in is set up (no Google sign-in and no ADMIN_PASSWORD). */
  configured: z.boolean(),
  /** A passkey is registered, so the login page can offer it. */
  passkeys: z.boolean(),
  /** "Sign in with Google" is available: navigate to GOOGLE_SIGNIN_START. */
  google: z.boolean().default(false),
  /** Password sign-in is available (only while Google sign-in is not configured). */
  password: z.boolean().default(true),
  /** The signed-in user. All null when signed out; email is null for the password admin. */
  email: z.string().nullable().default(null),
  name: z.string().nullable().default(null),
  picture: z.string().nullable().default(null),
  role: userRoleSchema.nullable().default(null),
});
export type AuthSession = z.infer<typeof authSessionSchema>;

/** Browser navigation (not fetch) that starts Google sign-in; `?next=/path` returns there. */
export const GOOGLE_SIGNIN_START = '/api/auth/google/start';

/**
 * After a failed Google sign-in the server redirects to `/?signin=<reason>`.
 * Success redirects to `next` (default `/`) with no query.
 */
export const SIGNIN_ERRORS = [
  'not_invited',
  'cancelled',
  'expired',
  'failed',
  'not_configured',
] as const;
export const signinErrorSchema = z.enum(SIGNIN_ERRORS);
export type SigninError = z.infer<typeof signinErrorSchema>;
export const SIGNIN_ERROR_MESSAGE: Record<SigninError, string> = {
  not_invited:
    "That Google account isn't invited to this Hoseidon. Ask the admin to add your email address.",
  cancelled: 'Google sign-in was cancelled.',
  expired: 'The sign-in took too long or was already used. Please try again.',
  failed: 'Google sign-in failed. Please try again.',
  not_configured: 'Google sign-in is not set up on this server.',
};

/** An allowlisted account (admin API). */
export const userSchema = z.object({
  email: z.string(),
  role: userRoleSchema,
  name: z.string().nullable(),
  picture: z.string().nullable(),
  addedBy: z.string().nullable(),
  createdAt: z.iso.datetime(),
  lastLoginAt: z.iso.datetime().nullable(),
  disabled: z.boolean(),
  /** Listed in ADMIN_EMAIL: always an admin, can't be removed, demoted or disabled. */
  protected: z.boolean(),
});
export type User = z.infer<typeof userSchema>;

export const userInputSchema = z.object({
  /** Trimmed and lowercased before it is checked. */
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  role: userRoleSchema.default('member'),
});
export type UserInput = z.input<typeof userInputSchema>;

export const userPatchSchema = z
  .object({ role: userRoleSchema, disabled: z.boolean() })
  .partial()
  .refine((p) => p.role !== undefined || p.disabled !== undefined, 'nothing to change');
export type UserPatch = z.infer<typeof userPatchSchema>;

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
