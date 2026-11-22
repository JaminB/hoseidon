import { describe, expect, it } from 'vitest';
import { insecureConfig, loadConfig } from './config';

describe('insecureConfig', () => {
  it('flags the .env.example placeholders and short secrets', () => {
    const config = loadConfig({
      ADMIN_PASSWORD: 'change-me',
      WEBHOOK_SECRET: 'change-me-too',
      SESSION_SECRET: 'change-me-to-a-long-random-string',
    });
    expect(insecureConfig(config)).toHaveLength(3);
    expect(
      insecureConfig(loadConfig({ ADMIN_PASSWORD: 'short', WEBHOOK_SECRET: 'x'.repeat(15) })),
    ).toHaveLength(2);
  });

  it('accepts strong values and unset ones', () => {
    expect(insecureConfig(loadConfig({}))).toEqual([]);
    expect(
      insecureConfig(
        loadConfig({
          ADMIN_PASSWORD: 'a-long-enough-password',
          WEBHOOK_SECRET: 'w'.repeat(32),
          SESSION_SECRET: 's'.repeat(32),
        }),
      ),
    ).toEqual([]);
  });
});
