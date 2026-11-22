import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const workerDir = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * wrangler.jsonc with the static assets pointed at a tiny fixture, so the tests don't need the
 * web app built first. Everything else (DO binding, SQLite migration, cron, flags) is the real
 * config. `name` keeps parallel test files apart.
 */
export function testConfig(name: string): string {
  const raw = readFileSync(join(workerDir, 'wrangler.jsonc'), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,(\s*[}\]])/g, '$1');
  const config = JSON.parse(raw) as Record<string, unknown> & { assets: Record<string, unknown> };
  const dir = join(workerDir, '.wrangler', name);
  const assets = join(dir, 'assets');
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(assets, 'index.html'), '<!doctype html><title>Hoseidon</title><div id=root>');
  const path = join(dir, 'wrangler.json');
  delete config.$schema;
  writeFileSync(
    path,
    JSON.stringify({
      ...config,
      main: join(workerDir, 'src/index.ts'),
      assets: { ...config.assets, directory: assets },
    }),
  );
  return path;
}
