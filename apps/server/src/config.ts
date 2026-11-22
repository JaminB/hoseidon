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
  PUBLIC_URL: z.string().default('http://localhost:8787'),
  WEBHOOK_SECRET: z.string().default(''),
  WEB_DIST: z.string().default('../web/dist'),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat empty strings (e.g. blank lines in .env) as unset so defaults apply.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  return envSchema.parse(cleaned);
}
