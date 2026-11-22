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

/**
 * Phase 0 created an empty `settings` table by hand, with no migration record, so the first
 * migration would fail on CREATE TABLE. Drop it if it's still empty and unmigrated.
 */
function dropPhase0Bootstrap(sqlite: Database.Database) {
  const has = (name: string) =>
    sqlite.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(name);
  if (!has('settings') || has('__drizzle_migrations')) return;
  const { n } = sqlite.prepare('select count(*) as n from settings').get() as { n: number };
  if (n === 0) sqlite.exec('DROP TABLE settings');
}

export function openDb(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  dropPhase0Bootstrap(sqlite);
  migrate(db, { migrationsFolder: migrationsFolder() });
  return { sqlite, db };
}

export type Db = ReturnType<typeof openDb>['db'];
export { schema };
