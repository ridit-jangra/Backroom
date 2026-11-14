/**
 * `--backup <dir>`: an online SQLite snapshot (node:sqlite backup()), verified with PRAGMA integrity_check, plus an
 * incremental mirror of the blobs folder (hardlinks on the same filesystem, copies otherwise; never `.tmp`), then
 * pruning to the newest `--keep` snapshots.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { BackupError, mirrorBlobs, pruneSnapshots, runBackup, snapshotName } from '../src/backup';
import type { Log } from '../src/log';
import { storedFiles, tempDir } from './helpers';

const KEY_NAME = 'ws~01JCLUBHACK0000000000000WS~files~01JFILE00000000000000000AA';
const ETAG = '0123456789abcdef0123456789abcdef';

function captureLog(): { log: Log; text: () => string } {
  const lines: string[] = [];
  return { log: (level, code, fields = {}) => lines.push(JSON.stringify({ level, code, ...fields })), text: () => lines.join('\n') };
}

/** A data dir with a WAL database holding `rows` rows and a blobs folder with one blob and a leftover temp file. */
function makeDataDir(rows = 10): string {
  const dir = tempDir('backroom-backup-data-');
  const db = new DatabaseSync(join(dir, 'backroom.sqlite'));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(id INTEGER PRIMARY KEY, body TEXT); CREATE TABLE secrets(email TEXT);");
  const ins = db.prepare('INSERT INTO t(body) VALUES (?)');
  for (let i = 0; i < rows; i++) ins.run(`row ${i} ${'x'.repeat(200)}`);
  db.prepare('INSERT INTO secrets VALUES (?)').run('someone@example.org');
  db.close();
  const shard = join(dir, 'blobs', 'ab');
  mkdirSync(shard, { recursive: true });
  writeFileSync(join(shard, `${KEY_NAME}.json`), JSON.stringify({ contentType: 'image/png', size: 5, etag: ETAG }));
  writeFileSync(join(shard, `${KEY_NAME}.${ETAG}`), 'hello');
  mkdirSync(join(dir, 'blobs', '.tmp'));
  writeFileSync(join(dir, 'blobs', '.tmp', 'upload-in-progress'), 'partial');
  return dir;
}

function count(file: string, table = 't'): number {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

const snapshots = (dir: string) => readdirSync(dir).filter((n) => /^backroom-\d{8}T\d{6}Z\.sqlite$/.test(n)).sort();

describe('snapshotName', () => {
  it('is backroom-<UTC timestamp>.sqlite', () => {
    expect(snapshotName(new Date('2026-11-14T04:05:06.789Z'))).toBe('backroom-20261114T040506Z.sqlite');
  });
});

describe('runBackup', () => {
  it('writes a verified snapshot and mirrors the blobs (hardlinks on one filesystem, .tmp skipped)', async () => {
    const data = makeDataDir();
    const out = join(tempDir('backroom-backup-out-'), 'backups');
    const { log } = captureLog();
    const r = await runBackup({ dataDir: data, outDir: out, keep: 7, log, now: () => new Date('2026-11-14T04:00:00Z') });
    expect(r.snapshot).toBe(join(out, 'backroom-20261114T040000Z.sqlite'));
    expect(r.integrity).toBe('ok');
    expect(count(r.snapshot)).toBe(10);
    expect(statSync(r.snapshot).mode & 0o777).toBe(0o600);
    expect(statSync(out).mode & 0o777).toBe(0o700);
    // No leftovers next to the snapshot (no -wal/-shm, no partial file).
    expect(readdirSync(out).sort()).toEqual(['backroom-20261114T040000Z.sqlite', 'blobs']);
    expect(storedFiles(join(out, 'blobs'))).toEqual([`ab/${KEY_NAME}.${ETAG}`, `ab/${KEY_NAME}.json`]);
    const src = statSync(join(data, 'blobs', 'ab', `${KEY_NAME}.${ETAG}`));
    const dst = statSync(join(out, 'blobs', 'ab', `${KEY_NAME}.${ETAG}`));
    expect(dst.ino).toBe(src.ino);
    expect(r.blobs).toEqual({ linked: 2, copied: 0, unchanged: 0 });
  });

  it('is incremental: a second run links only new files and refreshes a replaced sidecar', async () => {
    const data = makeDataDir();
    const out = tempDir('backroom-backup-out-');
    const { log } = captureLog();
    let t = Date.parse('2026-11-14T04:00:00Z');
    const now = () => new Date((t += 1000));
    await runBackup({ dataDir: data, outDir: out, keep: 7, log, now });
    const shard = join(data, 'blobs', 'ab');
    writeFileSync(join(shard, `${KEY_NAME}x.json`), '{}');
    // The server replaces a sidecar by rename (a new inode); the mirror must follow.
    writeFileSync(join(shard, 'new.json'), JSON.stringify({ contentType: 'text/plain', size: 5, etag: ETAG }));
    renameSync(join(shard, 'new.json'), join(shard, `${KEY_NAME}.json`));
    const r = await runBackup({ dataDir: data, outDir: out, keep: 7, log, now });
    expect(r.blobs).toEqual({ linked: 2, copied: 0, unchanged: 1 });
    expect(readFileSync(join(out, 'blobs', 'ab', `${KEY_NAME}.json`), 'utf8')).toContain('text/plain');
    expect(snapshots(out)).toHaveLength(2);
  });

  it('copies instead of linking across filesystems (EXDEV), and skips data files already copied', async () => {
    const data = makeDataDir();
    const out = tempDir('backroom-backup-out-');
    const exdev = () => {
      throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
    };
    const first = await mirrorBlobs(join(data, 'blobs'), join(out, 'blobs'), { link: exdev });
    expect(first).toEqual({ linked: 0, copied: 2, unchanged: 0 });
    const src = statSync(join(data, 'blobs', 'ab', `${KEY_NAME}.${ETAG}`));
    const dst = statSync(join(out, 'blobs', 'ab', `${KEY_NAME}.${ETAG}`));
    expect(dst.ino).not.toBe(src.ino);
    expect(readFileSync(join(out, 'blobs', 'ab', `${KEY_NAME}.${ETAG}`), 'utf8')).toBe('hello');
    expect(storedFiles(join(out, 'blobs'))).toEqual([`ab/${KEY_NAME}.${ETAG}`, `ab/${KEY_NAME}.json`]);
    const second = await mirrorBlobs(join(data, 'blobs'), join(out, 'blobs'), { link: exdev });
    expect(second).toEqual({ linked: 0, copied: 0, unchanged: 2 });
  });

  it('takes a consistent snapshot while another process keeps writing', { timeout: 60_000 }, async () => {
    const data = makeDataDir(20_000); // a few MB, so the backup overlaps the writer
    const dbPath = join(data, 'backroom.sqlite');
    const out = tempDir('backroom-backup-out-');
    const writer = spawn(
      process.execPath,
      [
        '-e',
        `const { DatabaseSync } = require('node:sqlite');
         const db = new DatabaseSync(process.argv[1], { timeout: 5000 });
         const ins = db.prepare('INSERT INTO t(body) VALUES (?)');
         let n = 0;
         const tick = () => { for (let i = 0; i < 50; i++) ins.run('w' + (n++)); if (n === 50) process.stdout.write('writing\\n'); setImmediate(tick); };
         tick();
         process.on('SIGTERM', () => { db.close(); process.exit(0); });`,
        dbPath,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    try {
      await new Promise<void>((resolve) => writer.stdout!.once('data', () => resolve()));
      const before = count(dbPath);
      const r = await runBackup({ dataDir: data, outDir: out, keep: 7, log: captureLog().log });
      const after = count(dbPath);
      expect(r.integrity).toBe('ok');
      const n = count(r.snapshot);
      expect(n).toBeGreaterThanOrEqual(before);
      expect(n).toBeLessThanOrEqual(after);
      expect(after).toBeGreaterThan(before); // the writer really was active during the backup
    } finally {
      writer.kill('SIGTERM');
      await new Promise((r) => writer.once('exit', r));
    }
  });

  it('a snapshot that fails PRAGMA integrity_check is removed, reported as an error, and nothing is pruned', async () => {
    const data = makeDataDir();
    const out = tempDir('backroom-backup-out-');
    for (const ts of ['20261101T040000Z', '20261102T040000Z']) writeFileSync(join(out, `backroom-${ts}.sqlite`), 'old');
    const { log, text } = captureLog();
    const corrupt = async (_src: string, dest: string) => {
      writeFileSync(dest, Buffer.alloc(8192, 0x42)); // not a database
    };
    await expect(runBackup({ dataDir: data, outDir: out, keep: 1, log, snapshot: corrupt })).rejects.toBeInstanceOf(BackupError);
    expect(snapshots(out)).toEqual(['backroom-20261101T040000Z.sqlite', 'backroom-20261102T040000Z.sqlite']);
    expect(readdirSync(out).filter((n) => n.includes('partial'))).toEqual([]);
    expect(text()).not.toContain('integrity_ok');
  });

  it('a damaged page in a structurally valid file also fails the check', async () => {
    const data = makeDataDir(2_000);
    const out = tempDir('backroom-backup-out-');
    const damage = async (src: string, dest: string) => {
      const { backup } = await import('node:sqlite');
      const db = new DatabaseSync(src, { readOnly: true });
      await backup(db, dest);
      db.close();
      const buf = readFileSync(dest);
      const pageSize = buf.readUInt16BE(16) === 1 ? 65536 : buf.readUInt16BE(16);
      // Scribble over pages 3 and 4 (b-tree pages of table t), keeping page 1 (the header and schema) intact.
      buf.fill(0xff, pageSize * 2, pageSize * 4);
      writeFileSync(dest, buf);
    };
    await expect(runBackup({ dataDir: data, outDir: out, keep: 7, log: captureLog().log, snapshot: damage })).rejects.toBeInstanceOf(BackupError);
    expect(snapshots(out)).toEqual([]);
  });

  it('refuses a data dir without a database and creates nothing there', async () => {
    const data = tempDir('backroom-backup-empty-');
    const out = join(tempDir('backroom-backup-out-'), 'b');
    await expect(runBackup({ dataDir: data, outDir: out, keep: 7, log: captureLog().log })).rejects.toThrow(/no database/);
    expect(existsSync(join(data, 'backroom.sqlite'))).toBe(false);
  });

  it('never takes server.lock, never touches blobs/.tmp, never migrates', async () => {
    const data = makeDataDir();
    writeFileSync(join(data, 'server.lock'), 'held by a live server');
    const out = tempDir('backroom-backup-out-');
    await runBackup({ dataDir: data, outDir: out, keep: 7, log: captureLog().log });
    expect(readFileSync(join(data, 'server.lock'), 'utf8')).toBe('held by a live server');
    expect(readFileSync(join(data, 'blobs', '.tmp', 'upload-in-progress'), 'utf8')).toBe('partial');
    const db = new DatabaseSync(join(data, 'backroom.sqlite'), { readOnly: true });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'd1_migrations'").get()).toBeUndefined();
    db.close();
  });

  it('logs no blob names, keys, emails or row contents', async () => {
    const data = makeDataDir();
    const out = tempDir('backroom-backup-out-');
    const { log, text } = captureLog();
    await runBackup({ dataDir: data, outDir: out, keep: 7, log });
    const t = text();
    expect(t).toContain('backup_done');
    for (const s of [KEY_NAME, ETAG, '01JFILE', 'someone@example.org', 'row 1', 'upload-in-progress']) expect(t).not.toContain(s);
  });
});

describe('pruneSnapshots', () => {
  it('keeps the newest n snapshots and leaves everything else alone', async () => {
    const out = tempDir('backroom-backup-prune-');
    const names = ['20261101T040000Z', '20261103T040000Z', '20261102T040000Z', '20261104T040000Z'].map((t) => `backroom-${t}.sqlite`);
    for (const n of names) writeFileSync(join(out, n), 'x');
    writeFileSync(join(out, 'notes.txt'), 'keep me');
    writeFileSync(join(out, 'backroom-latest.sqlite'), 'not a snapshot name');
    mkdirSync(join(out, 'blobs'));
    const removed = await pruneSnapshots(out, 2);
    expect(removed.sort()).toEqual(['backroom-20261101T040000Z.sqlite', 'backroom-20261102T040000Z.sqlite']);
    expect(readdirSync(out).sort()).toEqual(['backroom-20261103T040000Z.sqlite', 'backroom-20261104T040000Z.sqlite', 'backroom-latest.sqlite', 'blobs', 'notes.txt']);
  });

  it('runBackup prunes after a successful snapshot (default keep counts the new one)', async () => {
    const data = makeDataDir();
    const out = tempDir('backroom-backup-out-');
    for (let d = 1; d <= 9; d++) writeFileSync(join(out, `backroom-202611${String(d).padStart(2, '0')}T040000Z.sqlite`), 'old');
    const r = await runBackup({ dataDir: data, outDir: out, keep: 7, log: captureLog().log, now: () => new Date('2026-11-14T04:00:00Z') });
    expect(r.pruned).toBe(3);
    const left = snapshots(out);
    expect(left).toHaveLength(7);
    expect(left.at(-1)).toBe('backroom-20261114T040000Z.sqlite');
    expect(left[0]).toBe('backroom-20261104T040000Z.sqlite');
  });
});
