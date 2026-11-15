import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';

export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

const here = path.dirname(fileURLToPath(import.meta.url));

/** Real Postgres when a URL is given; embedded Postgres (PGlite) otherwise. */
export async function openDb(url?: string, dataDir?: string): Promise<Db> {
  let db: Db;
  if (url) {
    const pool = new pg.Pool({ connectionString: url });
    db = {
      query: async (sql, params) => (await pool.query(sql, params as any[])).rows,
      exec: async (sql) => void (await pool.query(sql)),
      close: () => pool.end(),
    };
  } else {
    if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
    const lite = new PGlite(dataDir);
    await lite.waitReady;
    db = {
      query: async (sql, params) => (await lite.query(sql, params as any[])).rows as any[],
      exec: async (sql) => void (await lite.exec(sql)),
      close: () => lite.close(),
    };
  }
  await migrate(db);
  return db;
}

async function migrate(db: Db) {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY)');
  const dir = path.join(here, 'migrations');
  for (const file of fs.readdirSync(dir).sort()) {
    const done = await db.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
    if (done.length) continue;
    await db.exec(fs.readFileSync(path.join(dir, file), 'utf8'));
    await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
  }
}
