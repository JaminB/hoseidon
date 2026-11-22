import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import type * as schema from './schema';

/**
 * The database the core runs on: any synchronous Drizzle SQLite database with our schema. Both
 * better-sqlite3 (Node, db/index.ts) and Durable Object SQLite (`drizzle-orm/durable-sqlite`,
 * apps/worker) are sync, so the same query code runs on either.
 */
export type Db = BaseSQLiteDatabase<'sync', unknown, typeof schema>;
