/**
 * scripts/run-forever.sh: the supervisor for hosts without systemd. Restarts a crashed child with backoff, appends
 * its output to a log file that is rotated by size, forwards SIGTERM/SIGINT to the child and exits with it.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from './helpers';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '../../../scripts/run-forever.sh');

/** Supervisors started by a test; afterEach kills any still running (and their children, through the log dir). */
const started = new Set<ChildProcess>();
afterEach(() => {
  for (const p of started) if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
  started.clear();
});

function start(dir: string, child: string, env: Record<string, string> = {}): { p: ChildProcess; exit: Promise<number | null> } {
  const file = join(dir, 'child.cjs');
  writeFileSync(file, child);
  const p = spawn('sh', [SCRIPT, process.execPath, file], {
    cwd: dir,
    env: { PATH: process.env.PATH, LOG_FILE: join(dir, 'server.log'), ...env },
    stdio: 'ignore',
  });
  started.add(p);
  return { p, exit: new Promise((r) => p.on('exit', (code) => r(code))) };
}

const log = (dir: string, name = 'server.log') => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : '');

describe('scripts/run-forever.sh', () => {
  it('restarts a crashing child with backoff, then forwards SIGTERM and exits with the child', { timeout: 30_000 }, async () => {
    const dir = tempDir('backroom-run-forever-');
    // Crashes on its first two runs, then stays up and exits 0 on SIGTERM.
    const { p, exit } = start(
      dir,
      `const fs = require('node:fs');
       const n = Number(fs.existsSync('runs') ? fs.readFileSync('runs', 'utf8') : 0) + 1;
       fs.writeFileSync('runs', String(n));
       console.log('child run ' + n);
       if (n <= 2) process.exit(3);
       process.on('SIGTERM', () => { console.log('child got SIGTERM'); process.exit(0); });
       setInterval(() => {}, 1000);`,
    );
    await vi.waitFor(() => expect(log(dir)).toContain('child run 3'), { timeout: 15_000, interval: 100 });
    const text = log(dir);
    expect(text).toMatch(/exited with status 3; restarting in 1s/);
    expect(text).toMatch(/exited with status 3; restarting in 2s/);
    p.kill('SIGTERM');
    expect(await exit).toBe(0);
    expect(log(dir)).toContain('child got SIGTERM');
    expect(readFileSync(join(dir, 'runs'), 'utf8')).toBe('3');
  });

  it('rotates the log file by size and keeps LOG_KEEP old files', { timeout: 30_000 }, async () => {
    const dir = tempDir('backroom-run-forever-');
    const { p, exit } = start(
      dir,
      `process.on('SIGTERM', () => process.exit(0));
       setInterval(() => console.log('x'.repeat(1000)), 5);`,
      { LOG_MAX_BYTES: '20000', LOG_KEEP: '2', LOG_CHECK_SECONDS: '1' },
    );
    await vi.waitFor(() => expect(existsSync(join(dir, 'server.log.2'))).toBe(true), { timeout: 15_000, interval: 200 });
    p.kill('SIGTERM');
    expect(await exit).toBe(0);
    expect(existsSync(join(dir, 'server.log.3'))).toBe(false);
    expect(log(dir, 'server.log.1').length).toBeGreaterThan(0);
  });

  it('exits 2 with a message when LOG_FILE cannot be written, without starting the command', async () => {
    const dir = tempDir('backroom-run-forever-');
    writeFileSync(join(dir, 'child.cjs'), "require('node:fs').writeFileSync('started', 'yes');");
    const p = spawn('sh', [SCRIPT, process.execPath, join(dir, 'child.cjs')], {
      cwd: dir,
      env: { PATH: process.env.PATH, LOG_FILE: join(dir, 'no-such-dir', 'server.log') },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    p.stderr!.on('data', (d) => (err += d));
    expect(await new Promise((r) => p.on('exit', r))).toBe(2);
    expect(err).toMatch(/cannot write to LOG_FILE/);
    expect(existsSync(join(dir, 'started'))).toBe(false);
  });

  it('a SIGTERM that arrives before the child is started still stops everything', { timeout: 30_000 }, async () => {
    const dir = tempDir('backroom-run-forever-');
    // A slow `wc` makes the log-size check before each start take 2 s: the signal lands in that window.
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const realWc = execFileSync('sh', ['-c', 'command -v wc'], { encoding: 'utf8' }).trim();
    writeFileSync(join(bin, 'wc'), `#!/bin/sh\nsleep 2\nexec ${realWc} "$@"\n`);
    chmodSync(join(bin, 'wc'), 0o755);
    writeFileSync(join(dir, 'server.log'), 'existing\n');
    const { p, exit } = start(
      dir,
      `require('node:fs').writeFileSync('child.pid', String(process.pid));
       process.on('SIGTERM', () => process.exit(0));
       setInterval(() => {}, 1000);`,
      { PATH: `${bin}:${process.env.PATH}` },
    );
    await new Promise((r) => setTimeout(r, 700));
    p.kill('SIGTERM');
    const code = await Promise.race([exit, new Promise((r) => setTimeout(() => r('still running'), 10_000))]);
    if (code === 'still running') p.kill('SIGKILL');
    expect(code).not.toBe('still running');
    if (existsSync(join(dir, 'child.pid'))) {
      const pid = Number(readFileSync(join(dir, 'child.pid'), 'utf8'));
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5_000 });
    }
  });

  it('refuses to run without a command', async () => {
    const p = spawn('sh', [SCRIPT], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr!.on('data', (d) => (err += d));
    expect(await new Promise((r) => p.on('exit', r))).toBe(2);
    expect(err).toMatch(/usage/i);
  });
});
