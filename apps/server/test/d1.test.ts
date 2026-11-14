import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { D1_MAX_BOUND_PARAMETERS, type NodeD1Database, createD1 } from '../src/platform/d1';
import { tempDir } from './helpers';

// Expected shapes come from probing wrangler's D1 (miniflare) with the same statements; see the task report.

let db: NodeD1Database;
beforeEach(() => {
  db = createD1(':memory:');
});
afterEach(() => db.close());

async function setupTable(): Promise<void> {
  await db.prepare('CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT UNIQUE, n REAL, b BLOB)').run();
}

describe('statement results', () => {
  it('run/all return { success, results, meta } with the D1 meta fields', async () => {
    await setupTable();
    const ins = await db.prepare("INSERT INTO t (body) VALUES ('x')").run();
    expect(ins.success).toBe(true);
    expect(ins.results).toEqual([]);
    expect(ins.meta).toMatchObject({ changes: 1, last_row_id: 1, changed_db: true, rows_written: 1 });
    for (const k of ['duration', 'size_after', 'rows_read', 'rows_written', 'last_row_id', 'changes'] as const) {
      expect(typeof ins.meta[k], k).toBe('number');
    }
    const sel = await db.prepare('SELECT id, body FROM t').all();
    expect(sel.results).toEqual([{ id: 1, body: 'x' }]);
    expect(sel.meta).toMatchObject({ changes: 0, changed_db: false, rows_read: 1, last_row_id: 1 });
    // run() on a SELECT also carries its rows, like D1.
    expect((await db.prepare('SELECT body FROM t').run()).results).toEqual([{ body: 'x' }]);
  });

  it('results are plain objects (toEqual-able), last duplicate column wins', async () => {
    const r = await db.prepare('SELECT 1 AS a, 2 AS a').all();
    expect(r.results).toEqual([{ a: 2 }]);
    expect(Object.getPrototypeOf(r.results[0])).toBe(Object.prototype);
  });

  it('first() is the first row or null; first(col) is that column, null without rows, an error for a missing column', async () => {
    expect(await db.prepare('SELECT 1 AS a, 2 AS b').first()).toEqual({ a: 1, b: 2 });
    expect(await db.prepare('SELECT 1 AS a WHERE 0').first()).toBeNull();
    expect(await db.prepare('SELECT 1 AS a, 2 AS b').first('b')).toBe(2);
    expect(await db.prepare('SELECT 1 AS a WHERE 0').first('a')).toBeNull();
    await expect(db.prepare('SELECT 1 AS a').first('zz')).rejects.toThrow('D1_COLUMN_NOTFOUND: Column not found (zz)');
  });

  it('raw() returns arrays, with the column names first when asked (also without rows)', async () => {
    expect(await db.prepare('SELECT 1 AS a, 2 AS b').raw()).toEqual([[1, 2]]);
    expect(await db.prepare('SELECT 1 AS a, 2 AS b').raw({ columnNames: true })).toEqual([['a', 'b'], [1, 2]]);
    expect(await db.prepare('SELECT 1 AS a, 2 AS b WHERE 0').raw({ columnNames: true })).toEqual([['a', 'b']]);
  });

  it('RETURNING rows come back from all() and first(), with changes counted', async () => {
    await setupTable();
    const r = await db.prepare("INSERT INTO t (body) VALUES ('y') RETURNING id, body").all();
    expect(r.results).toEqual([{ id: 1, body: 'y' }]);
    expect(r.meta.changes).toBe(1);
    expect(r.meta.last_row_id).toBe(1);
    expect(await db.prepare("UPDATE t SET body = 'z' WHERE id = 1 RETURNING body").first()).toEqual({ body: 'z' });
    expect(await db.prepare("UPDATE t SET body = 'q' WHERE id = 99 RETURNING body").first()).toBeNull();
  });

  it('a SELECT after a write reports changes 0 (not the previous statement\'s count)', async () => {
    await setupTable();
    await db.prepare("INSERT INTO t (body) VALUES ('a'), ('b'), ('c')").run();
    expect((await db.prepare('SELECT * FROM t').all()).meta.changes).toBe(0);
    expect((await db.prepare('CREATE TABLE u (x)').run()).meta.changes).toBe(0);
  });
});

describe('binding', () => {
  it('numbers (bound as REAL, like D1), strings, null, ArrayBuffer and Uint8Array; blobs read back as number arrays like D1', async () => {
    const r = await db
      .prepare('SELECT ? AS i, typeof(?1) AS ti, ? AS f, typeof(?2) AS tf, ? AS s, ? AS z, ? AS ab, typeof(?5) AS tab, ? AS u8')
      .bind(7, 1.5, 'hi', null, new Uint8Array([1, 2]).buffer, new Uint8Array([3, 4, 5]))
      .first();
    expect(r).toEqual({ i: 7, ti: 'real', f: 1.5, tf: 'real', s: 'hi', z: null, ab: [1, 2], tab: 'blob', u8: [3, 4, 5] });
  });

  it('integer columns still store integers (column affinity), and integral REAL binds work for LIMIT', async () => {
    await setupTable();
    await db.prepare('INSERT INTO t (id, body) VALUES (?, ?)').bind(5, 'x').run();
    expect(await db.prepare('SELECT typeof(id) AS ty FROM t').first('ty')).toBe('integer');
    expect(await db.prepare('SELECT body FROM t LIMIT ? OFFSET ?').bind(1, 0).raw()).toEqual([['x']]);
  });

  it('a Uint8Array view binds only its own bytes', async () => {
    const backing = new Uint8Array([9, 9, 1, 2, 9]);
    expect(await db.prepare('SELECT ? AS v').bind(backing.subarray(2, 4)).first('v')).toEqual([1, 2]);
  });

  it('booleans bind as the numbers 1 and 0 (D1 accepts them, as REAL)', async () => {
    expect(await db.prepare('SELECT ? AS t, ? AS f, typeof(?1) AS ty').bind(true, false).first()).toEqual({ t: 1, f: 0, ty: 'real' });
  });

  it('undefined, bigint and plain objects are D1_TYPE_ERRORs', async () => {
    for (const [v, type] of [
      [undefined, 'undefined'],
      [10n, 'bigint'],
      [{ a: 1 }, 'object'],
    ] as const) {
      await expect(async () => db.prepare('SELECT ? AS x').bind(v).first()).rejects.toThrow(`D1_TYPE_ERROR: Type '${type}' not supported`);
    }
  });

  it('bind() returns a new statement; the prepared one stays unbound', async () => {
    const base = db.prepare('SELECT ? AS x');
    const a = base.bind(1);
    const b = base.bind(2);
    expect(await a.first('x')).toBe(1);
    expect(await b.first('x')).toBe(2);
    await expect(base.first()).rejects.toThrow('Wrong number of parameter bindings');
  });

  it('the number of values must match the parameters (too few, too many, none)', async () => {
    await expect(db.prepare('SELECT ? AS a, ? AS b').bind(1).first()).rejects.toThrow('D1_ERROR: Wrong number of parameter bindings for SQL query.');
    await expect(db.prepare('SELECT ? AS a').bind(1, 2).first()).rejects.toThrow('Wrong number of parameter bindings');
    expect(await db.prepare('SELECT 1 AS a').first('a')).toBe(1);
  });

  it('numbered parameters (?1 ?2, repeated, out of order) count by their highest index', async () => {
    expect(await db.prepare('SELECT ?2 AS a, ?1 AS b, ?2 AS c').bind('x', 'y').first()).toEqual({ a: 'y', b: 'x', c: 'y' });
    await expect(db.prepare('SELECT ?3 AS a').bind(1).first()).rejects.toThrow('Wrong number of parameter bindings');
  });

  it('question marks inside string literals, quoted identifiers and comments are not parameters', async () => {
    const sql = `SELECT '?' AS "a?", ? AS b -- what?
      /* and ?3 here */ , 'it''s ?' AS c`;
    expect(await db.prepare(sql).bind(5).first()).toEqual({ 'a?': '?', b: 5, c: "it's ?" });
  });

  it(`keeps D1's limit of ${D1_MAX_BOUND_PARAMETERS} bound parameters per statement`, async () => {
    expect(D1_MAX_BOUND_PARAMETERS).toBe(100);
    const list = (n: number) => Array.from({ length: n }, () => '?').join(',');
    const ok = await db.prepare(`SELECT ${list(100)}`).bind(...Array.from({ length: 100 }, (_, i) => i)).raw();
    expect(ok[0]).toHaveLength(100);
    await expect(db.prepare(`SELECT ${list(101)}`).bind(...Array.from({ length: 101 }, (_, i) => i)).raw()).rejects.toThrow(
      /D1_ERROR: too many SQL variables/,
    );
    await expect(db.prepare('SELECT ?101 AS x').bind(...Array.from({ length: 101 }, () => 1)).first()).rejects.toThrow(/D1_ERROR/);
  });
});

describe('errors', () => {
  it('SQL errors reject (lazily, at execution) with the D1 message shape and an Error cause', async () => {
    const stmt = db.prepare('SELECT * FROM nosuch'); // no throw here: D1 prepares lazily
    const e = (await stmt.all().catch((x: unknown) => x)) as Error;
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe('D1_ERROR: no such table: nosuch: SQLITE_ERROR');
    expect(e.cause).toBeInstanceOf(Error);
    expect((e.cause as Error).message).toBe('no such table: nosuch: SQLITE_ERROR');
  });

  it('constraint errors keep SQLite\'s text, which the app matches (e.g. UNIQUE constraint failed: t.body)', async () => {
    await setupTable();
    await db.prepare("INSERT INTO t (body) VALUES ('dup')").run();
    const e = (await db.prepare("INSERT INTO t (body) VALUES ('dup')").run().catch((x: unknown) => x)) as Error;
    expect(e.message).toBe('D1_ERROR: UNIQUE constraint failed: t.body: SQLITE_CONSTRAINT');
  });
});

describe('batch', () => {
  it('runs every statement in order and returns one result per statement', async () => {
    await setupTable();
    const r = await db.batch([
      db.prepare("INSERT INTO t (body) VALUES ('a')"),
      db.prepare('INSERT INTO t (body) VALUES (?)').bind('b'),
      db.prepare('SELECT body FROM t ORDER BY id'),
    ]);
    expect(r).toHaveLength(3);
    expect(r[0]!.meta.changes).toBe(1);
    expect(r[1]!.meta.last_row_id).toBe(2);
    expect(r[2]!.results).toEqual([{ body: 'a' }, { body: 'b' }]);
    expect(await db.batch([])).toEqual([]);
  });

  it('is atomic: a failing statement rolls back the statements before it', async () => {
    await setupTable();
    await db.prepare("INSERT INTO t (body) VALUES ('keep')").run();
    const e = (await db
      .batch([
        db.prepare("INSERT INTO t (body) VALUES ('gone1')"),
        db.prepare("UPDATE t SET body = 'changed' WHERE body = 'keep'"),
        db.prepare("INSERT INTO t (body) VALUES ('keep')"), // succeeds: the old row is 'changed' by now
        db.prepare('INSERT INTO nosuch VALUES (1)'),
      ])
      .catch((x: unknown) => x)) as Error;
    expect(e.message).toBe('D1_ERROR: no such table: nosuch: SQLITE_ERROR');
    expect(await db.prepare('SELECT body FROM t').raw()).toEqual([['keep']]);
  });

  it('rolls back on a bind error or a constraint error too, and the database stays usable', async () => {
    await setupTable();
    await expect(
      db.batch([db.prepare("INSERT INTO t (body) VALUES ('x')"), db.prepare('SELECT ? AS a, ? AS b').bind(1)]),
    ).rejects.toThrow('Wrong number of parameter bindings');
    await expect(
      db.batch([db.prepare("INSERT INTO t (body) VALUES ('y')"), db.prepare("INSERT INTO t (body) VALUES ('y')")]),
    ).rejects.toThrow('UNIQUE constraint failed: t.body');
    expect(await db.prepare('SELECT COUNT(*) AS n FROM t').first('n')).toBe(0);
    await db.batch([db.prepare("INSERT INTO t (body) VALUES ('z')")]);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM t').first('n')).toBe(1);
  });

  it('concurrent batches never interleave', async () => {
    await setupTable();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        db.batch([
          db.prepare('INSERT INTO t (body) VALUES (?)').bind(`a${i}`),
          db.prepare('INSERT INTO t (body) VALUES (?)').bind(`b${i}`),
        ]),
      ),
    );
    const rows = (await db.prepare('SELECT body FROM t ORDER BY id').raw()) as string[][];
    for (let i = 0; i < rows.length; i += 2) expect(rows[i + 1]![0]!.slice(1)).toBe(rows[i]![0]!.slice(1));
  });
});

describe('exec', () => {
  it('runs several statements and reports a count and duration', async () => {
    const r = await db.exec('CREATE TABLE e (x);\nINSERT INTO e VALUES (1);\nINSERT INTO e VALUES (2);');
    expect(r.count).toBe(3);
    expect(typeof r.duration).toBe('number');
    expect(await db.prepare('SELECT COUNT(*) AS n FROM e').first('n')).toBe(2);
    await expect(db.exec('SELECT * FROM nosuch')).rejects.toThrow('D1_ERROR: no such table: nosuch');
  });
});

describe('connection settings', () => {
  it('a file database runs in WAL mode with a busy timeout, foreign keys off, and FTS5 available', async () => {
    const file = createD1(join(tempDir(), 'db.sqlite'));
    try {
      expect(await file.prepare('PRAGMA journal_mode').first('journal_mode')).toBe('wal');
      expect(await file.prepare('PRAGMA busy_timeout').first('timeout')).toBeGreaterThanOrEqual(5000);
      expect(await file.prepare('PRAGMA foreign_keys').first('foreign_keys')).toBe(0);
      await file.exec('CREATE VIRTUAL TABLE f USING fts5(body)');
    } finally {
      file.close();
    }
  });

  it('data survives closing and reopening the file', async () => {
    const path = join(tempDir(), 'db.sqlite');
    const a = createD1(path);
    await a.exec('CREATE TABLE k (v TEXT)');
    await a.prepare('INSERT INTO k VALUES (?)').bind('persisted').run();
    a.close();
    const b = createD1(path);
    expect(await b.prepare('SELECT v FROM k').first('v')).toBe('persisted');
    b.close();
  });
});
