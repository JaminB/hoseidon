import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const envSchema = z.object({
  PORT: z.coerce.number().int().default(8787),
  DATABASE_PATH: z.string().default('./data/hoseidon.sqlite'),
  LINKTAP_MOCK: bool.default(true),
  LINKTAP_USERNAME: z.string().default(''),
  LINKTAP_API_KEY: z.string().default(''),
  SESSION_SECRET: z.string().default(''),
  ADMIN_PASSWORD: z.string().default(''),
  /**
   * Comma-separated Google account emails that are always admins (and can't be removed). With
   * GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET set it turns on Google sign-in and turns password
   * sign-in off.
   */
  ADMIN_EMAIL: z.string().default(''),
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  PUBLIC_URL: z.string().default('http://localhost:8787'),
  WEBHOOK_SECRET: z.string().default(''),
  WEB_DIST: z.string().default('../web/dist'),
  /** Behind a reverse proxy or Cloudflare Tunnel: trust CF-Connecting-IP / X-Forwarded-For. */
  TRUST_PROXY: bool.default(false),
  /**
   * Cloudflare only: run the poller and scheduler. With LINKTAP_MOCK=false it must be set to
   * true on purpose (cutover switch), so two Hoseidons never drive one LinkTap account.
   * Unset = on in mock mode, off with real taps.
   */
  ENGINE_ENABLED: bool.optional(),
  /** Cloudflare only: default schedule time zone (there is no TZ there). */
  TZ: z.string().optional(),
});

export type Config = z.infer<typeof envSchema>;

/** Trim + lowercase, the one form emails are stored and compared in. */
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** ADMIN_EMAIL as a list of normalized addresses (anything without an "@" is ignored). */
export function adminEmails(config: Pick<Config, 'ADMIN_EMAIL'>): string[] {
  const list = config.ADMIN_EMAIL.split(',').map(normalizeEmail);
  return [...new Set(list.filter((e) => /^[^\s@]+@[^\s@]+$/.test(e)))];
}

/** Google sign-in is on (and password sign-in off) when the client and an admin are configured. */
export function googleSignInConfigured(
  config: Pick<Config, 'GOOGLE_CLIENT_ID' | 'GOOGLE_CLIENT_SECRET' | 'ADMIN_EMAIL'>,
): boolean {
  return !!config.GOOGLE_CLIENT_ID && !!config.GOOGLE_CLIENT_SECRET && adminEmails(config).length > 0;
}

/** Values copied from .env.example, which must never protect a real deployment. */
const PLACEHOLDERS = new Set(['change-me', 'change-me-too', 'change-me-to-a-long-random-string']);

/**
 * Problems that make a live (non-mock) deployment unsafe: well-known or too-short secrets. Empty
 * values are not flagged here (an empty password or webhook secret just disables that feature).
 */
export function insecureConfig(
  config: Config,
  opts: {
    /** Workers hash with fast PBKDF2, so the password itself must be long and random there. */
    minAdminPassword?: number;
    /** Some way to sign in must be set up: Google sign-in, or ADMIN_PASSWORD (Workers). */
    requireSignIn?: boolean;
  } = {},
): string[] {
  const google = googleSignInConfigured(config);
  const check = (name: string, value: string, min: number) =>
    value && (PLACEHOLDERS.has(value) || value.length < min)
      ? [`${name} is a placeholder or shorter than ${min} characters`]
      : [];
  return [
    // With Google sign-in on, ADMIN_PASSWORD is ignored, so its strength doesn't matter.
    ...(google ? [] : check('ADMIN_PASSWORD', config.ADMIN_PASSWORD, opts.minAdminPassword ?? 12)),
    ...(opts.requireSignIn && !google && !config.ADMIN_PASSWORD
      ? [
          'no sign-in is set up: set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and ADMIN_EMAIL (Google sign-in) or ADMIN_PASSWORD',
        ]
      : []),
    ...check('WEBHOOK_SECRET', config.WEBHOOK_SECRET, 16),
    ...check('SESSION_SECRET', config.SESSION_SECRET, 16),
  ];
}

/** Is the scheduler/poller allowed to run? See ENGINE_ENABLED. */
export function engineEnabled(config: Config): boolean {
  return config.ENGINE_ENABLED ?? config.LINKTAP_MOCK;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // Treat empty strings (e.g. blank lines in .env) as unset so defaults apply.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  return envSchema.parse(cleaned);
}
