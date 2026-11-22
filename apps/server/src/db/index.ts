import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema';

/**
 * Migrations live in apps/server/drizzle. From source (src/db/index.ts) that's ../../drizzle; from
 * the tsup bundle (dist/index.js, and /app/dist in Docker) it's ../drizzle.
 */
function migrationsFolder(): string {
  const candidates = ['../drizzle', '../../drizzle'].map((p) =>
    fileURLToPath(new URL(p, import.meta.url)),
  );
  const found = candidates.find((p) => existsSync(`${p}/meta/_journal.json`));
  if (!found) throw new Error(`Drizzle migrations not found (looked in ${candidates.join(', ')})`);
  return found;
}

export function openDb(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: migrationsFolder() });
  return { sqlite, db };
}

export type Db = ReturnType<typeof openDb>['db'];
export { schema };
