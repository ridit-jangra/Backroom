import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { NodeD1Database } from './d1';

/** The table wrangler's `d1 migrations apply` keeps, created the same way so either tool can read it. */
const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS d1_migrations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`;

/**
 * Applies the `.sql` files in `dir` that `d1_migrations` does not list yet, in file-name order. Each file runs in
 * its own transaction together with its `d1_migrations` row, so a file is applied entirely or not at all. The first
 * failure rolls that file back and stops the run (later files are not attempted). Returns the names applied now.
 */
export async function applyMigrations(db: NodeD1Database, dir: string): Promise<string[]> {
  const sqlite = db.sqlite;
  sqlite.exec(CREATE_TABLE);
  const done = new Set((sqlite.prepare('SELECT name FROM d1_migrations').all() as { name: string }[]).map((r) => r.name));
  const files = (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isFile() && e.name.endsWith('.sql'))
    .map((e) => e.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const applied: string[] = [];
  for (const name of files) {
    if (done.has(name)) continue;
    const sql = await readFile(join(dir, name), 'utf8');
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      sqlite.exec(sql);
      sqlite.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(name);
      sqlite.exec('COMMIT');
    } catch (e) {
      if (sqlite.isTransaction) sqlite.exec('ROLLBACK');
      throw new Error(`migration ${name} failed: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
    applied.push(name);
  }
  return applied;
}

/** The `.sql` files in `dir` that `d1_migrations` does not list (all of them for a database never migrated). */
export async function pendingMigrations(db: NodeD1Database, dir: string): Promise<string[]> {
  const sqlite = db.sqlite;
  const hasTable = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'").get() !== undefined;
  const done = hasTable ? new Set((sqlite.prepare('SELECT name FROM d1_migrations').all() as { name: string }[]).map((r) => r.name)) : new Set<string>();
  return (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isFile() && e.name.endsWith('.sql') && !done.has(e.name))
    .map((e) => e.name)
    .sort();
}
