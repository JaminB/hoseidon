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
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  PUBLIC_URL: z.string().default('http://localhost:8787'),
  WEBHOOK_SECRET: z.string().default(''),
  WEB_DIST: z.string().default('../web/dist'),
  /** Behind a reverse proxy or Cloudflare Tunnel: trust CF-Connecting-IP / X-Forwarded-For. */
  TRUST_PROXY: bool.default(false),
});

export type Config = z.infer<typeof envSchema>;

/** Values copied from .env.example, which must never protect a real deployment. */
const PLACEHOLDERS = new Set(['change-me', 'change-me-too', 'change-me-to-a-long-random-string']);

/**
 * Problems that make a live (non-mock) deployment unsafe: well-known or too-short secrets. Empty
 * values are not flagged here (an empty password or webhook secret just disables that feature).
 */
export function insecureConfig(config: Config): string[] {
  const check = (name: string, value: string, min: number) =>
    value && (PLACEHOLDERS.has(value) || value.length < min)
      ? [`${name} is a placeholder or shorter than ${min} characters`]
      : [];
  return [
    ...check('ADMIN_PASSWORD', config.ADMIN_PASSWORD, 12),
    ...check('WEBHOOK_SECRET', config.WEBHOOK_SECRET, 16),
    ...check('SESSION_SECRET', config.SESSION_SECRET, 16),
  ];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat empty strings (e.g. blank lines in .env) as unset so defaults apply.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  return envSchema.parse(cleaned);
}
