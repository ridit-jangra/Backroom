import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type NodeD1Database, createD1 } from '../src/platform/d1';
import { applyMigrations, pendingMigrations } from '../src/platform/migrate';
import { MIGRATIONS_DIR, tempDir } from './helpers';

let db: NodeD1Database;
beforeEach(() => {
  db = createD1(':memory:');
});
afterEach(() => db.close());

const names = async () => ((await db.prepare('SELECT name FROM d1_migrations ORDER BY id').raw()) as string[][]).map((r) => r[0]);

describe('applyMigrations', () => {
  it('applies every worker migration in name order and records them in a wrangler-compatible d1_migrations', async () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    expect(files.length).toBeGreaterThanOrEqual(8);
    expect(await applyMigrations(db, MIGRATIONS_DIR)).toEqual(files);
    expect(await names()).toEqual(files);
    const cols = ((await db.prepare("SELECT name FROM pragma_table_info('d1_migrations') ORDER BY cid").raw()) as string[][]).map((r) => r[0]);
    expect(cols).toEqual(['id', 'name', 'applied_at']);
    expect(await db.prepare('SELECT applied_at FROM d1_migrations LIMIT 1').first('applied_at')).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    // The schema really is there: seeded workspace, FTS tables, and the last migration's columns.
    expect(await db.prepare('SELECT slug FROM workspaces').first('slug')).toBe('clubhack');
    expect(await db.prepare('SELECT thumb_size FROM files LIMIT 0').all()).toMatchObject({ success: true });
  });

  it('is idempotent: a second run applies nothing', async () => {
    await applyMigrations(db, MIGRATIONS_DIR);
    expect(await applyMigrations(db, MIGRATIONS_DIR)).toEqual([]);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM workspaces').first('n')).toBe(1);
  });

  it('applies only new files, ignores non-.sql files, and sorts by name', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, '0002_b.sql'), 'INSERT INTO a VALUES (2);');
    writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE a (v INTEGER);\nINSERT INTO a VALUES (1);');
    writeFileSync(join(dir, 'README.md'), 'not sql');
    expect(await applyMigrations(db, dir)).toEqual(['0001_a.sql', '0002_b.sql']);
    writeFileSync(join(dir, '0003_c.sql'), 'INSERT INTO a VALUES (3);');
    expect(await applyMigrations(db, dir)).toEqual(['0003_c.sql']);
    expect(await db.prepare('SELECT group_concat(v) AS v FROM a').first('v')).toBe('1,2,3');
  });

  it('a failing file is rolled back entirely, not recorded, and stops the run', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, '0001_ok.sql'), 'CREATE TABLE a (v INTEGER);');
    writeFileSync(join(dir, '0002_bad.sql'), 'INSERT INTO a VALUES (1);\nINSERT INTO nosuch VALUES (1);');
    writeFileSync(join(dir, '0003_later.sql'), 'INSERT INTO a VALUES (3);');
    await expect(applyMigrations(db, dir)).rejects.toThrow(/0002_bad\.sql.*no such table: nosuch/);
    expect(await names()).toEqual(['0001_ok.sql']);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM a').first('n')).toBe(0);
    // Fixed file: the next run picks up where it stopped.
    writeFileSync(join(dir, '0002_bad.sql'), 'INSERT INTO a VALUES (2);');
    expect(await applyMigrations(db, dir)).toEqual(['0002_bad.sql', '0003_later.sql']);
  });

  it('reuses a d1_migrations table that wrangler created', async () => {
    await db.exec(
      `CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);
       INSERT INTO d1_migrations (name) VALUES ('0001_a.sql');`,
    );
    const dir = tempDir();
    writeFileSync(join(dir, '0001_a.sql'), 'this would fail if it ran');
    writeFileSync(join(dir, '0002_b.sql'), 'CREATE TABLE b (v);');
    expect(await applyMigrations(db, dir)).toEqual(['0002_b.sql']);
  });
});

describe('pendingMigrations', () => {
  it('lists every file for a fresh database, none after applying, and never changes the database', async () => {
    const all = readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith('.sql')).sort();
    expect(await pendingMigrations(db, MIGRATIONS_DIR)).toEqual(all);
    expect(db.sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'd1_migrations'").get()).toBeUndefined();
    await applyMigrations(db, MIGRATIONS_DIR);
    expect(await pendingMigrations(db, MIGRATIONS_DIR)).toEqual([]);
  });
});
