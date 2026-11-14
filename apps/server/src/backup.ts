/**
 * `--backup <dir>`: a backup that is safe while the server runs.
 *
 * 1. Database: node:sqlite's online backup API copies `DATA_DIR/backroom.sqlite` from a read-only connection into
 *    `<dir>/backroom-<UTC timestamp>.sqlite.partial` in ONE step (a single read transaction, so the copy is a
 *    consistent snapshot; in WAL mode the server's writes carry on meanwhile). The copy is checked with
 *    `PRAGMA integrity_check`; only an "ok" copy is renamed into place (mode 600). Anything else removes it and fails.
 * 2. Blobs: `DATA_DIR/blobs` is mirrored into `<dir>/blobs`. Data files are immutable and named by etag, so a file
 *    already present is skipped. Sidecars (`*.json`) are replaced by the server with a rename, so a changed one is
 *    refreshed. Hardlinks are used when `<dir>` is on the same filesystem (no extra space, and a hardlink survives
 *    the server deleting its own name), copies otherwise. `blobs/.tmp` (uploads in flight) is never copied. The
 *    mirror is taken after the snapshot, so every blob the snapshot references is in it, unless the file was
 *    deleted in between. Files the server later deletes stay in the mirror.
 * 3. Pruning: only after a verified snapshot, the newest `keep` snapshots are kept.
 *
 * It never takes `server.lock`, never sweeps, never migrates and never writes inside DATA_DIR. Logs carry counts,
 * sizes and the snapshot path only: never blob file names (they hold keys) or any database content.
 */
import { randomBytes } from 'node:crypto';
import { constants, existsSync, linkSync } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readFile, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import type { Log } from './log';

export class BackupError extends Error {
  override name = 'BackupError';
}

const SNAPSHOT_RE = /^backroom-\d{8}T\d{6}Z\.sqlite$/;
/** Pages per backup step: large enough that the whole database is copied in one step (one read transaction). */
const ONE_STEP = 2 ** 31 - 1;

export function snapshotName(d: Date): string {
  const ts = d.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
  return `backroom-${ts}.sqlite`;
}

/** The default snapshot: node:sqlite's online backup from a read-only connection. */
export async function sqliteSnapshot(src: string, dest: string): Promise<void> {
  const db = new DatabaseSync(src, { readOnly: true, timeout: 5000 });
  try {
    await sqliteBackup(db, dest, { rate: ONE_STEP });
  } finally {
    db.close();
  }
}

/**
 * Makes a snapshot a standalone file (rollback journal, so no -wal/-shm files appear next to it; the server switches
 * a restored copy back to WAL when it opens it) and runs `PRAGMA integrity_check`: true only for the single row
 * "ok". Unreadable files are false.
 */
export function finishSnapshot(file: string): boolean {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode=DELETE');
    const rows = db.prepare('PRAGMA integrity_check').all() as { integrity_check: unknown }[];
    return rows.length === 1 && rows[0]!.integrity_check === 'ok';
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

export interface MirrorCounts {
  linked: number;
  copied: number;
  unchanged: number;
}

type LinkFn = (existing: string, created: string) => void;

const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code;

async function sameBytes(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([readFile(a), readFile(b)]);
  return x.equals(y);
}

/**
 * Mirrors `src` into `dest` (see the header). `link` is injectable so tests can simulate another filesystem.
 * Writes go to a temp name first and are renamed into place, so an interrupted run leaves no half-written file
 * under a real name.
 */
export async function mirrorBlobs(src: string, dest: string, opts: { link?: LinkFn } = {}): Promise<MirrorCounts> {
  const link = opts.link ?? linkSync;
  const counts: MirrorCounts = { linked: 0, copied: 0, unchanged: 0 };
  let canLink = true;

  const place = async (from: string, to: string): Promise<void> => {
    const tmp = `${to}.${randomBytes(6).toString('hex')}.partial`;
    if (canLink) {
      try {
        link(from, tmp);
        await rename(tmp, to);
        counts.linked++;
        return;
      } catch (e) {
        await unlink(tmp).catch(() => {});
        // Another filesystem (or one without hardlinks): copy from now on.
        if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EMLINK'].includes(errCode(e) ?? '')) throw e;
        canLink = false;
      }
    }
    await copyFile(from, tmp, constants.COPYFILE_FICLONE);
    await chmod(tmp, 0o600);
    await rename(tmp, to);
    counts.copied++;
  };

  const walk = async (from: string, to: string, top: boolean): Promise<void> => {
    await mkdir(to, { recursive: true, mode: 0o700 });
    let names: string[];
    try {
      names = await readdir(from);
    } catch (e) {
      if (errCode(e) === 'ENOENT') return;
      throw e;
    }
    for (const name of names.sort()) {
      if (top && name === '.tmp') continue;
      if (name.endsWith('.partial')) continue;
      const f = join(from, name);
      const t = join(to, name);
      let s;
      try {
        s = await lstat(f);
      } catch (e) {
        if (errCode(e) === 'ENOENT') continue; // deleted by the server while we walked
        throw e;
      }
      if (s.isDirectory()) {
        await walk(f, t, false);
        continue;
      }
      if (!s.isFile()) continue;
      let d;
      try {
        d = await stat(t);
      } catch (e) {
        if (errCode(e) !== 'ENOENT') throw e;
        d = null;
      }
      if (d) {
        const isSidecar = name.endsWith('.json');
        const unchanged = d.ino === s.ino && d.dev === s.dev
          ? true
          : isSidecar
            ? d.size === s.size && (await sameBytes(f, t).catch(() => false))
            : d.size === s.size; // data files are immutable, named by a unique etag
        if (unchanged) {
          counts.unchanged++;
          continue;
        }
      }
      try {
        await place(f, t);
      } catch (e) {
        if (errCode(e) === 'ENOENT') continue; // deleted by the server while we walked
        throw e;
      }
    }
  };

  await walk(src, dest, true);
  return counts;
}

/** Removes all but the newest `keep` snapshots (by name, which sorts by time). Returns the names removed. */
export async function pruneSnapshots(dir: string, keep: number): Promise<string[]> {
  const names = (await readdir(dir)).filter((n) => SNAPSHOT_RE.test(n)).sort();
  const remove = names.slice(0, Math.max(0, names.length - keep));
  for (const n of remove) await rm(join(dir, n), { force: true });
  return remove;
}

export interface BackupOptions {
  dataDir: string;
  outDir: string;
  keep: number;
  log: Log;
  now?: () => Date;
  /** Injectable for tests (e.g. a snapshot that comes out corrupt). */
  snapshot?: (src: string, dest: string) => Promise<void>;
  link?: LinkFn;
}

export interface BackupResult {
  snapshot: string;
  bytes: number;
  integrity: 'ok';
  blobs: MirrorCounts;
  pruned: number;
}

export async function runBackup(opts: BackupOptions): Promise<BackupResult> {
  const t0 = Date.now();
  const dbPath = join(opts.dataDir, 'backroom.sqlite');
  if (!existsSync(dbPath)) throw new BackupError(`no database at ${dbPath}: nothing to back up`);

  await mkdir(opts.outDir, { recursive: true, mode: 0o700 });
  await chmod(opts.outDir, 0o700);
  const name = snapshotName((opts.now ?? (() => new Date()))());
  const final = join(opts.outDir, name);
  if (existsSync(final)) throw new BackupError(`${final} already exists`);
  const partial = `${final}.partial`;
  await rm(partial, { force: true });

  try {
    await (opts.snapshot ?? sqliteSnapshot)(dbPath, partial);
    if (!finishSnapshot(partial)) throw new BackupError('the snapshot failed PRAGMA integrity_check (the database may be damaged); no snapshot was kept');
    await chmod(partial, 0o600);
    await rename(partial, final);
  } catch (e) {
    await rm(partial, { force: true });
    for (const suffix of ['-wal', '-shm', '-journal']) await rm(`${partial}${suffix}`, { force: true });
    if (e instanceof BackupError) throw e;
    throw new BackupError(`the database snapshot failed (${(e as { code?: string } | null)?.code ?? (e as Error)?.name ?? 'error'})`, { cause: e });
  }
  const bytes = (await stat(final)).size;
  opts.log('info', 'backup_snapshot', { snapshot: final, bytes, integrity: 'ok' });

  const blobs = await mirrorBlobs(join(opts.dataDir, 'blobs'), join(opts.outDir, 'blobs'), { link: opts.link });
  const pruned = (await pruneSnapshots(opts.outDir, opts.keep)).length;
  opts.log('info', 'backup_done', { snapshot: final, bytes, blobs, pruned, keep: opts.keep, ms: Date.now() - t0 });
  return { snapshot: final, bytes, integrity: 'ok', blobs, pruned };
}
