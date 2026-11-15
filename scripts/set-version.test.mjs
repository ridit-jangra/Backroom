// Tests for scripts/set-version.mjs. Each test copies the five real files and the script
// into a scratch git repository and runs the CLI there, so the repo itself is never touched.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FILES, isValidVersion, readVersions } from './set-version.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const GIT = ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false'];

let dir;

function git(...args) {
  return execFileSync('git', [...GIT, ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function run(...args) {
  return spawnSync(process.execPath, [join(dir, 'scripts/set-version.mjs'), ...args], {
    cwd: dir,
    encoding: 'utf8',
  });
}

const read = (rel) => readFileSync(join(dir, rel), 'utf8');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'set-version-'));
  for (const rel of ['scripts/set-version.mjs', ...FILES.map((f) => f.rel)]) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    copyFileSync(join(REPO, rel), join(dir, rel));
  }
  // Pin a known starting version so the expected rewrites are exact.
  const pin = run('0.1.0', '--force');
  assert.equal(pin.status, 0, pin.stderr);
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('validates versions', () => {
  for (const ok of ['0.0.0', '1.2.3', '10.20.30', '1.0.0-rc.1', '1.0.0-beta', '1.0.0-0.3.7', '1.0.0-x-y.7']) {
    assert.ok(isValidVersion(ok), ok);
  }
  for (const bad of ['', '1', '1.2', 'v1.2.3', '01.2.3', '1.02.3', '1.2.3-', '1.2.3-01', '1.2.3+build', '1.2.3 ', ' 1.2.3', '1.2.3\n', '1.2.3-a..b', '1.2.3-a_b', '1.2.3.4']) {
    assert.ok(!isValidVersion(bad), JSON.stringify(bad));
  }
});

test('rewrites exactly the version text in all five files', () => {
  const before = Object.fromEntries(FILES.map((f) => [f.rel, read(f.rel)]));
  const r = run('2.3.4-beta.1');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), [
    'updated   apps/desktop/package.json: 0.1.0 -> 2.3.4-beta.1',
    'updated   apps/desktop/src-tauri/tauri.conf.json: 0.1.0 -> 2.3.4-beta.1',
    'updated   apps/desktop/src-tauri/Cargo.toml: 0.1.0 -> 2.3.4-beta.1',
    'updated   apps/desktop/src-tauri/Cargo.lock: 0.1.0 -> 2.3.4-beta.1',
    'updated   package-lock.json: 0.1.0 -> 2.3.4-beta.1',
  ]);
  // The diff is exactly one changed line per file.
  const diff = git('diff', '-U0', '--no-color');
  const changed = diff.split('\n').filter((l) => /^[-+][^-+]/.test(l));
  assert.deepEqual(changed, [
    '-  "version": "0.1.0",',
    '+  "version": "2.3.4-beta.1",',
    '-version = "0.1.0"',
    '+version = "2.3.4-beta.1"',
    '-version = "0.1.0"',
    '+version = "2.3.4-beta.1"',
    '-  "version": "0.1.0",',
    '+  "version": "2.3.4-beta.1",',
    '-      "version": "0.1.0",',
    '+      "version": "2.3.4-beta.1",',
  ]);
  // Cargo.lock: the edited line is the one right after `name = "backroom-desktop"`.
  assert.match(read('apps/desktop/src-tauri/Cargo.lock'), /\[\[package\]\]\nname = "backroom-desktop"\nversion = "2\.3\.4-beta\.1"\n/);
  assert.match(read('apps/desktop/src-tauri/Cargo.toml'), /\[package\]\nname = "backroom-desktop"\nversion = "2\.3\.4-beta\.1"\n/);
  assert.equal(JSON.parse(read('package-lock.json')).packages['apps/desktop'].version, '2.3.4-beta.1');
  // Other dependencies' versions are untouched.
  for (const f of FILES) assert.equal(read(f.rel).length, before[f.rel].length + '2.3.4-beta.1'.length - '0.1.0'.length, f.rel);
  assert.deepEqual(
    readVersions(dir).map((v) => v.version),
    FILES.map(() => '2.3.4-beta.1'),
  );
});

test('is idempotent', () => {
  assert.equal(run('3.0.0').status, 0);
  git('commit', '-q', '-am', 'bump');
  const again = run('3.0.0');
  assert.equal(again.status, 0, again.stderr);
  assert.ok(again.stdout.split('\n').filter(Boolean).every((l) => l.startsWith('unchanged ')), again.stdout);
  assert.equal(git('status', '--porcelain'), '');
});

test('refuses a dirty tree unless --force', () => {
  writeFileSync(join(dir, 'stray.txt'), 'x');
  const r = run('1.0.0');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /uncommitted changes/);
  assert.equal(git('status', '--porcelain'), '?? stray.txt\n');
  const forced = run('1.0.0', '--force');
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(read('apps/desktop/package.json'), /"version": "1\.0\.0"/);
});

test('refuses invalid versions and leaves every file alone', () => {
  for (const bad of ['1.2', 'v1.2.3', '1.2.3+meta', '1.2.3-', 'latest', '"1.2.3"', '1.2.3\n']) {
    const r = run(bad);
    assert.equal(r.status, 1, bad);
    assert.match(r.stderr, /not a valid version/, bad);
  }
  assert.equal(run().status, 1);
  assert.equal(run('1.2.3', '--publish').status, 1);
  assert.equal(git('status', '--porcelain'), '');
});

test('--check passes only when every file carries the version', () => {
  const ok = run('0.1.0', '--check');
  assert.equal(ok.status, 0, ok.stderr);
  const wrong = run('0.2.0', '--check');
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /version mismatch, expected 0\.2\.0/);
  // One file out of step is caught.
  const p = 'apps/desktop/src-tauri/Cargo.toml';
  writeFileSync(join(dir, p), read(p).replace('version = "0.1.0"', 'version = "0.1.1"'));
  const drift = run('0.1.0', '--check');
  assert.equal(drift.status, 1);
  assert.match(drift.stderr, /apps\/desktop\/src-tauri\/Cargo\.toml=0\.1\.1/);
});

test('fails without writing anything when a file cannot be edited', () => {
  const p = 'apps/desktop/src-tauri/Cargo.lock';
  writeFileSync(join(dir, p), read(p).replace('name = "backroom-desktop"', 'name = "something-else"'));
  git('commit', '-q', '-am', 'break lock');
  const r = run('4.0.0');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /backroom-desktop block not found/);
  assert.equal(git('status', '--porcelain'), '');
});

test('never takes a version line from the next block', () => {
  const p = 'apps/desktop/src-tauri/Cargo.lock';
  writeFileSync(join(dir, p), read(p).replace(/(name = "backroom-desktop"\n)version = "0\.1\.0"\n/, '$1'));
  git('commit', '-q', '-am', 'drop version');
  const r = run('4.0.0');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no version line in the backroom-desktop block/);
  assert.equal(git('status', '--porcelain'), '');
});
