import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import type { D1Database, D1ExecResult, D1Meta, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';

/**
 * A D1-compatible database over one `node:sqlite` connection: the subset the worker uses
 * (`prepare().bind().first()/all()/run()/raw()`, `batch()`, `exec()`), with D1's result shapes and the semantics the
 * app relies on. Behaviour was matched against wrangler's local D1 (miniflare) statement by statement:
 *
 * - Results: `{ success: true, results, meta }`; `run()` also carries rows. Blobs read back as arrays of numbers.
 * - Binding: numbers (bound as REAL, as D1 does), strings, null, ArrayBuffer/typed arrays; booleans become 1/0
 *   (D1 accepts them). `undefined`, bigint and other objects are `D1_TYPE_ERROR`s. The number of values must match
 *   the statement's parameters.
 * - At most 100 parameters per statement, as on D1 (SQLite's variable limit is lowered to 100 on purpose: the app
 *   chunks IN lists around it, and tests must fail here exactly where D1 would fail).
 * - `batch()` is one transaction: all statements or none.
 * - `meta.changes` is the statement's own row count (`sqlite3_changes()`), without the rows FTS triggers write.
 *   (Wrangler's local D1 adds trigger rows; the app never depends on that and avoids it where it matters.)
 * - Errors: `D1_ERROR: <sqlite message>: SQLITE_<CODE>` with an Error `cause`, raised when the statement runs
 *   (D1 prepares lazily), so `prepare()` itself never throws.
 *
 * node:sqlite is synchronous: every call runs to completion inside one microtask, so statements and batches from
 * concurrent requests never interleave.
 *
 * Deliberate differences from real D1 (all checked against the app's call sites):
 * - `meta.changes` counts the statement's own rows only; D1 also counts the rows FTS triggers write (files and
 *   messages). Every app check is `=== 0`, `> 0` or `=== 1` on tables without triggers, so results are identical.
 * - INTEGERs beyond 2^53 make the read throw (node:sqlite ERR_OUT_OF_RANGE) instead of returning a lossy number.
 *   The app cannot write such values (zod caps integers; ids are text).
 * - Booleans bind as the numbers 1/0 (D1 accepts them too, also as REAL).
 * - Commits are synchronous and fsynced (synchronous=FULL), so a write blocks the event loop for its duration: one
 *   writer, no parallelism. Fine for one team's chat; heavy batch jobs would stall requests.
 * - Not runnable with Node's built-in type stripping (it uses TypeScript parameter properties and imports worker
 *   sources by relative path); the server is bundled with esbuild.
 */

export const D1_MAX_BOUND_PARAMETERS = 100;
const BUSY_TIMEOUT_MS = 5000;
const STATEMENT_CACHE_SIZE = 256;

export type NodeD1Database = D1Database & {
  /** The underlying connection, for the migration runner and maintenance (checkpoint, shutdown). */
  readonly sqlite: DatabaseSync;
  close(): void;
};

type Row = Record<string, unknown>;

const SQLITE_CODES: Record<number, string> = {
  1: 'ERROR', 2: 'INTERNAL', 3: 'PERM', 4: 'ABORT', 5: 'BUSY', 6: 'LOCKED', 7: 'NOMEM', 8: 'READONLY', 9: 'INTERRUPT',
  10: 'IOERR', 11: 'CORRUPT', 12: 'NOTFOUND', 13: 'FULL', 14: 'CANTOPEN', 15: 'PROTOCOL', 16: 'EMPTY', 17: 'SCHEMA',
  18: 'TOOBIG', 19: 'CONSTRAINT', 20: 'MISMATCH', 21: 'MISUSE', 22: 'NOLFS', 23: 'AUTH', 24: 'FORMAT', 25: 'RANGE',
  26: 'NOTADB',
};

class D1Error extends Error {}

function d1Error(e: unknown): Error {
  if (e instanceof D1Error) return e;
  const err = e instanceof Error ? e : new Error(String(e));
  const errcode = (err as { errcode?: unknown }).errcode;
  const name = typeof errcode === 'number' ? (SQLITE_CODES[errcode & 0xff] ?? 'ERROR') : 'ERROR';
  const detail = `${err.message}: SQLITE_${name}`;
  return new D1Error(`D1_ERROR: ${detail}`, { cause: new Error(detail) });
}

const wrongBindings = () => new D1Error('D1_ERROR: Wrong number of parameter bindings for SQL query.');

function typeError(v: unknown): D1Error {
  return new D1Error(`D1_TYPE_ERROR: Type '${typeof v}' not supported for value '${String(v)}'`);
}

/** D1's value conversion. */
function toSqlite(v: unknown): SQLInputValue {
  if (v === null || typeof v === 'number' || typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 1 : 0; // a JS number, so REAL like every number (D1 does the same)
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  throw typeError(v);
}

/** Blobs come back from D1 as plain arrays of numbers; rows are plain objects. */
function fromSqlite(v: unknown): unknown {
  return v instanceof Uint8Array ? Array.from(v) : v;
}

function plainRow(r: Row): Row {
  const out: Row = {};
  for (const k in r) out[k] = fromSqlite(r[k]);
  return out;
}

/**
 * The parameter count SQLite gives a statement: the highest `?NNN` index, with each bare `?` taking the next index
 * and each named parameter (`:a`, `@a`, `$a`) its own slot. String literals, quoted identifiers and comments are
 * skipped. Also counts the statements (top-level `;`-separated, non-empty), which `exec()` reports.
 */
export function scanSql(sql: string): { params: number; statements: number } {
  let max = 0;
  const named = new Set<string>();
  let statements = 0;
  let pending = false;
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i]!;
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      i++;
      while (i < n) {
        if (sql[i] === close) {
          if (close !== ']' && sql[i + 1] === close) {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      i++;
      pending = true;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === ';') {
      if (pending) statements++;
      pending = false;
      i++;
      continue;
    }
    if (c === '?') {
      let j = i + 1;
      while (j < n && sql[j]! >= '0' && sql[j]! <= '9') j++;
      max = j > i + 1 ? Math.max(max, Number(sql.slice(i + 1, j))) : max + 1;
      i = j;
      pending = true;
      continue;
    }
    if ((c === ':' || c === '@' || c === '$') && /[A-Za-z_]/.test(sql[i + 1] ?? '')) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j]!)) j++;
      const name = sql.slice(i, j);
      if (!named.has(name)) {
        named.add(name);
        max += 1;
      }
      i = j;
      pending = true;
      continue;
    }
    if (!/\s/.test(c)) pending = true;
    i++;
  }
  if (pending) statements++;
  return { params: max, statements };
}

type Prepared = { stmt: StatementSync; params: number; returnsRows: boolean };

class NodeD1PreparedStatement {
  constructor(
    private readonly owner: NodeD1,
    readonly sql: string,
    readonly values: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): NodeD1PreparedStatement {
    return new NodeD1PreparedStatement(this.owner, this.sql, values.map(toSqlite));
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    const row = this.owner.firstRow(this);
    if (row === null) return null;
    if (colName === undefined) return row as T;
    if (!Object.hasOwn(row, colName)) throw new D1Error(`D1_COLUMN_NOTFOUND: Column not found (${colName})`);
    return row[colName] as T;
  }

  async run<T = Row>(): Promise<D1Result<T>> {
    return this.owner.execute(this) as D1Result<T>;
  }

  async all<T = Row>(): Promise<D1Result<T>> {
    return this.owner.execute(this) as D1Result<T>;
  }

  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    return this.owner.rawRows(this, options?.columnNames === true) as T[];
  }
}

class NodeD1 {
  readonly sqlite: DatabaseSync;
  private readonly cache = new Map<string, Prepared>();
  private readonly metaStmt: StatementSync;
  private readonly totalStmt: StatementSync;

  constructor(path: string) {
    this.sqlite = new DatabaseSync(path, { enableForeignKeyConstraints: false, timeout: BUSY_TIMEOUT_MS });
    this.sqlite.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    this.sqlite.exec('PRAGMA journal_mode = WAL'); // in-memory databases stay 'memory'
    // FULL: every commit is fsynced, so a power loss cannot drop an acknowledged message (WAL keeps it cheap).
    this.sqlite.exec('PRAGMA synchronous = FULL');
    this.sqlite.exec('PRAGMA foreign_keys = OFF'); // the schema has no foreign keys by design (R1)
    this.sqlite.limits.variableNumber = D1_MAX_BOUND_PARAMETERS;
    this.totalStmt = this.sqlite.prepare('SELECT total_changes() AS t');
    this.metaStmt = this.sqlite.prepare(
      'SELECT total_changes() AS t, changes() AS c, last_insert_rowid() AS r, (SELECT page_count FROM pragma_page_count()) * (SELECT page_size FROM pragma_page_size()) AS s',
    );
  }

  private prepared(sql: string): Prepared {
    const hit = this.cache.get(sql);
    if (hit) {
      // Map order doubles as LRU order.
      this.cache.delete(sql);
      this.cache.set(sql, hit);
      return hit;
    }
    const stmt = this.sqlite.prepare(sql);
    const p: Prepared = { stmt, params: scanSql(sql).params, returnsRows: stmt.columns().length > 0 };
    this.cache.set(sql, p);
    if (this.cache.size > STATEMENT_CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
    return p;
  }

  private check(s: NodeD1PreparedStatement): Prepared {
    const p = this.prepared(s.sql);
    if (s.values.length !== p.params) throw wrongBindings();
    return p;
  }

  firstRow(s: NodeD1PreparedStatement): Row | null {
    try {
      const p = this.check(s);
      // RETURNING statements make all their changes on the first step, so stepping once is enough for writes too.
      const row = p.stmt.get(...s.values) as Row | undefined;
      return row === undefined ? null : plainRow(row);
    } catch (e) {
      throw d1Error(e);
    }
  }

  rawRows(s: NodeD1PreparedStatement, columnNames: boolean): unknown[][] {
    try {
      const p = this.check(s);
      p.stmt.setReturnArrays(true);
      try {
        const rows = (p.stmt.all(...s.values) as unknown as unknown[][]).map((r) => r.map(fromSqlite));
        return columnNames ? [p.stmt.columns().map((c) => c.name), ...rows] : rows;
      } finally {
        p.stmt.setReturnArrays(false);
      }
    } catch (e) {
      throw d1Error(e);
    }
  }

  /** One statement with D1's meta. Throws the raw SQLite error (callers wrap it). */
  executeRaw(s: NodeD1PreparedStatement): D1Result<Row> {
    const p = this.check(s);
    const start = performance.now();
    const before = (this.totalStmt.get() as { t: number }).t;
    let results: Row[];
    if (p.returnsRows) results = (p.stmt.all(...s.values) as Row[]).map(plainRow);
    else {
      p.stmt.run(...s.values);
      results = [];
    }
    const m = this.metaStmt.get() as { t: number; c: number; r: number; s: number };
    const changedDb = m.t !== before;
    // changes() keeps the last write's count across later reads; only trust it when this statement wrote.
    const changes = changedDb ? m.c : 0;
    const meta: D1Meta & Record<string, unknown> = {
      served_by: 'node:sqlite',
      duration: performance.now() - start,
      changes,
      last_row_id: m.r,
      changed_db: changedDb,
      size_after: m.s,
      rows_read: results.length,
      rows_written: changes,
    };
    return { success: true, results, meta };
  }

  execute(s: NodeD1PreparedStatement): D1Result<Row> {
    try {
      return this.executeRaw(s);
    } catch (e) {
      throw d1Error(e);
    }
  }

  batch(statements: NodeD1PreparedStatement[]): D1Result<Row>[] {
    if (statements.length === 0) return [];
    const out: D1Result<Row>[] = [];
    let began = false;
    try {
      this.sqlite.exec('BEGIN IMMEDIATE');
      began = true;
      for (const s of statements) out.push(this.executeRaw(s));
      this.sqlite.exec('COMMIT');
    } catch (e) {
      if (began && this.sqlite.isTransaction) {
        try {
          this.sqlite.exec('ROLLBACK');
        } catch {
          // The original error is what the caller needs; a failed rollback must not replace it.
        }
      }
      throw d1Error(e);
    }
    return out;
  }

  exec(sql: string): D1ExecResult {
    const start = performance.now();
    try {
      this.sqlite.exec(sql);
    } catch (e) {
      throw d1Error(e);
    }
    return { count: scanSql(sql).statements, duration: performance.now() - start };
  }

  close(): void {
    this.cache.clear();
    if (this.sqlite.isOpen) this.sqlite.close();
  }
}

/** Opens (creating if needed) the SQLite database at `path` (`:memory:` for tests) behind the D1 interface. */
export function createD1(path: string): NodeD1Database {
  const impl = new NodeD1(path);
  const db = {
    sqlite: impl.sqlite,
    prepare: (query: string) => new NodeD1PreparedStatement(impl, query) as unknown as D1PreparedStatement,
    batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
      for (const s of statements) {
        if (!(s instanceof NodeD1PreparedStatement)) throw new TypeError('batch() takes statements from this database');
      }
      return impl.batch(statements as unknown as NodeD1PreparedStatement[]) as D1Result<T>[];
    },
    exec: async (query: string) => impl.exec(query),
    withSession: () => {
      throw new Error('D1 sessions are not supported on the Node server');
    },
    dump: async () => {
      throw new Error('dump() is not supported on the Node server');
    },
    close: () => impl.close(),
  };
  return db as unknown as NodeD1Database;
}
