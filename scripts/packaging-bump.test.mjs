// Tests for scripts/packaging-bump.mjs. Each test copies the script, its helpers, packaging/ and
// LICENSE into a scratch directory and runs the CLI there, so the repo itself is never touched.
// No test uses the network: every run passes a local --sums file and --source-sha256.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const ZERO = '0'.repeat(64);
const WINGET = 'packaging/winget/manifests/r/Ridit/Backroom';
const REL = 'https://github.com/ridit-jangra/Backroom/releases/download';

let dir;

const h = (c) => c.repeat(64);
// Distinct fake hashes per asset, so a swapped hash is caught.
const HASHES = {
  deb: h('a'),
  rpm: h('b'),
  appimage: h('c'),
  exe: h('d'),
  msi: h('e'),
  dmg: h('f'),
};
const SOURCE = '1'.repeat(64);

function sums(version, { omit = [], extra = [], override = {} } = {}) {
  const v = version;
  const rows = [
    ['rpm', `Backroom-${v}-1.x86_64.rpm`],
    ['appimage', `Backroom_${v}_amd64.AppImage`],
    ['deb', `Backroom_${v}_amd64.deb`],
    ['dmg', `Backroom_${v}_universal.dmg`],
    ['msi', `Backroom_${v}_x64_en-US.msi`],
    ['exe', `Backroom_${v}_x64-setup.exe`],
  ];
  const lines = rows
    .filter(([k]) => !omit.includes(k))
    .map(([k, name]) => `${override[k] ?? HASHES[k]}  ${name}`);
  return [...lines, ...extra].join('\n') + '\n';
}

function writeSums(text, name = 'SHA256SUMS') {
  const p = join(dir, 'work', name);
  mkdirSync(join(dir, 'work'), { recursive: true });
  writeFileSync(p, text);
  return p;
}

function run(...args) {
  return spawnSync(process.execPath, [join(dir, 'scripts/packaging-bump.mjs'), ...args], {
    cwd: dir,
    encoding: 'utf8',
  });
}

/** Every file under packaging/ with its content, for "nothing was written" checks. */
function snapshot() {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = readFileSync(p, 'utf8');
    }
  };
  walk(join(dir, 'packaging'));
  return out;
}

const read = (rel) => readFileSync(join(dir, rel), 'utf8');
const licenseSha = () => createHash('sha256').update(readFileSync(join(dir, 'LICENSE'))).digest('hex');

/** Lines that differ between two texts of equal line count: [[old, new], ...]. */
function changedLines(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  assert.equal(a.length, b.length, 'line count changed');
  return a.flatMap((l, i) => (l === b[i] ? [] : [[l, b[i]]]));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'packaging-bump-'));
  for (const rel of ['scripts/packaging-bump.mjs', 'scripts/packaging-lib.mjs', 'scripts/set-version.mjs']) {
    cpSync(join(REPO, rel), join(dir, rel));
  }
  cpSync(join(REPO, 'scripts/fixtures/placeholder/packaging'), join(dir, 'packaging'), { recursive: true });
  cpSync(join(REPO, 'LICENSE'), join(dir, 'LICENSE'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('the committed placeholder state passes --check as "not yet released"', () => {
  const r = run('--check');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /not yet released/);
});

test('bump rewrites exactly the version and checksum text in every manifest', () => {
  const before = snapshot();
  const r = run('1.2.3', '--sums', writeSums(sums('1.2.3')), '--source-sha256', SOURCE);
  assert.equal(r.status, 0, r.stderr);
  const lic = licenseSha();

  assert.deepEqual(changedLines(before['packaging/aur/backroom-bin/PKGBUILD'], read('packaging/aur/backroom-bin/PKGBUILD')), [
    ['pkgver=0.0.0', 'pkgver=1.2.3'],
    [`sha256sums=('${ZERO}'`, `sha256sums=('${HASHES.deb}'`],
    [`            '${ZERO}')`, `            '${lic}')`],
  ]);
  assert.deepEqual(changedLines(before['packaging/aur/backroom-bin/.SRCINFO'], read('packaging/aur/backroom-bin/.SRCINFO')), [
    ['\tpkgver = 0.0.0', '\tpkgver = 1.2.3'],
    ['\tnoextract = Backroom_0.0.0_amd64.deb', '\tnoextract = Backroom_1.2.3_amd64.deb'],
    [
      `\tsource = Backroom_0.0.0_amd64.deb::${REL}/v0.0.0/Backroom_0.0.0_amd64.deb`,
      `\tsource = Backroom_1.2.3_amd64.deb::${REL}/v1.2.3/Backroom_1.2.3_amd64.deb`,
    ],
    [
      '\tsource = backroom-LICENSE-0.0.0::https://raw.githubusercontent.com/ridit-jangra/Backroom/v0.0.0/LICENSE',
      '\tsource = backroom-LICENSE-1.2.3::https://raw.githubusercontent.com/ridit-jangra/Backroom/v1.2.3/LICENSE',
    ],
    [`\tsha256sums = ${ZERO}`, `\tsha256sums = ${HASHES.deb}`],
    [`\tsha256sums = ${ZERO}`, `\tsha256sums = ${lic}`],
  ]);
  assert.deepEqual(changedLines(before['packaging/aur/backroom/PKGBUILD'], read('packaging/aur/backroom/PKGBUILD')), [
    ['pkgver=0.0.0', 'pkgver=1.2.3'],
    [`sha256sums=('${ZERO}')`, `sha256sums=('${SOURCE}')`],
  ]);
  assert.deepEqual(changedLines(before['packaging/aur/backroom/.SRCINFO'], read('packaging/aur/backroom/.SRCINFO')), [
    ['\tpkgver = 0.0.0', '\tpkgver = 1.2.3'],
    [
      '\tsource = backroom-0.0.0.tar.gz::https://github.com/ridit-jangra/Backroom/archive/refs/tags/v0.0.0.tar.gz',
      '\tsource = backroom-1.2.3.tar.gz::https://github.com/ridit-jangra/Backroom/archive/refs/tags/v1.2.3.tar.gz',
    ],
    [`\tsha256sums = ${ZERO}`, `\tsha256sums = ${SOURCE}`],
  ]);
  assert.deepEqual(changedLines(before['packaging/homebrew/backroom.rb'], read('packaging/homebrew/backroom.rb')), [
    ['  version "0.0.0"', '  version "1.2.3"'],
    [`  sha256 "${ZERO}"`, `  sha256 "${HASHES.dmg}"`],
  ]);
  assert.deepEqual(changedLines(before['packaging/scoop/backroom.json'], read('packaging/scoop/backroom.json')), [
    ['    "version": "0.0.0",', '    "version": "1.2.3",'],
    [
      `            "url": "${REL}/v0.0.0/Backroom_0.0.0_x64-setup.exe#/setup.exe",`,
      `            "url": "${REL}/v1.2.3/Backroom_1.2.3_x64-setup.exe#/setup.exe",`,
    ],
    [`            "hash": "${ZERO}"`, `            "hash": "${HASHES.exe}"`],
  ]);

  // winget: the version directory is renamed and the three files edited.
  assert.ok(!existsSync(join(dir, WINGET, '0.0.0')), 'old winget directory removed');
  const w = (f) => [before[`${WINGET}/0.0.0/${f}`], read(`${WINGET}/1.2.3/${f}`)];
  assert.deepEqual(changedLines(...w('Ridit.Backroom.yaml')), [['PackageVersion: 0.0.0', 'PackageVersion: 1.2.3']]);
  assert.deepEqual(changedLines(...w('Ridit.Backroom.installer.yaml')), [
    ['PackageVersion: 0.0.0', 'PackageVersion: 1.2.3'],
    [
      `  InstallerUrl: ${REL}/v0.0.0/Backroom_0.0.0_x64-setup.exe`,
      `  InstallerUrl: ${REL}/v1.2.3/Backroom_1.2.3_x64-setup.exe`,
    ],
    [`  InstallerSha256: ${ZERO}`, `  InstallerSha256: ${HASHES.exe.toUpperCase()}`],
  ]);
  assert.deepEqual(changedLines(...w('Ridit.Backroom.locale.en-US.yaml')), [
    ['PackageVersion: 0.0.0', 'PackageVersion: 1.2.3'],
    [
      'ReleaseNotesUrl: https://github.com/ridit-jangra/Backroom/releases/tag/v0.0.0',
      'ReleaseNotesUrl: https://github.com/ridit-jangra/Backroom/releases/tag/v1.2.3',
    ],
  ]);
  assert.deepEqual(readdirSync(join(dir, WINGET)), ['1.2.3']);

  // The summary is diff-like: file headers with -/+ lines.
  assert.match(r.stdout, /^--- packaging\/homebrew\/backroom\.rb$/m);
  assert.match(r.stdout, /^-  version "0\.0\.0"$/m);
  assert.match(r.stdout, /^\+  version "1\.2\.3"$/m);
  assert.match(r.stdout, /rename .*0\.0\.0 -> .*1\.2\.3/);
});

test('--check passes after a bump and fails on any mismatch', () => {
  const s = writeSums(sums('1.2.3'));
  assert.equal(run('1.2.3', '--sums', s, '--source-sha256', SOURCE).status, 0);

  const ok = run('--check', '--sums', s, '--source-sha256', SOURCE);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /1\.2\.3/);
  assert.equal(run('--check', '1.2.3', '--sums', s, '--source-sha256', SOURCE).status, 0);

  // Wrong version argument.
  const v = run('--check', '1.2.4', '--sums', s, '--source-sha256', SOURCE);
  assert.equal(v.status, 1);
  assert.match(v.stderr, /1\.2\.4/);

  // A different exe hash: Scoop and winget are both reported.
  const other = writeSums(sums('1.2.3', { override: { exe: h('9') } }), 'OTHER');
  const bad = run('--check', '--sums', other, '--source-sha256', SOURCE);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /scoop/);
  assert.match(bad.stderr, /winget/);
  assert.doesNotMatch(bad.stderr, /homebrew/);

  // A different source tarball hash.
  const src = run('--check', '--sums', s, '--source-sha256', '2'.repeat(64));
  assert.equal(src.status, 1);
  assert.match(src.stderr, /packaging\/aur\/backroom\/PKGBUILD/);
});

test('--check fails when .SRCINFO is stale relative to the PKGBUILD', () => {
  const s = writeSums(sums('1.2.3'));
  assert.equal(run('1.2.3', '--sums', s, '--source-sha256', SOURCE).status, 0);
  const p = join(dir, 'packaging/aur/backroom-bin/.SRCINFO');
  writeFileSync(p, readFileSync(p, 'utf8').replace('\tpkgrel = 1', '\tpkgrel = 2'));
  const r = run('--check', '--sums', s, '--source-sha256', SOURCE);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /backroom-bin\/\.SRCINFO/);
});

test('a second bump with the same inputs changes nothing', () => {
  const s = writeSums(sums('1.2.3'));
  assert.equal(run('1.2.3', '--sums', s, '--source-sha256', SOURCE).status, 0);
  const once = snapshot();
  const r = run('1.2.3', '--sums', s, '--source-sha256', SOURCE);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(snapshot(), once);
  assert.match(r.stdout, /no changes/);
});

test('bumping to a new version resets pkgrel to 1', () => {
  const s = writeSums(sums('1.2.3'));
  assert.equal(run('1.2.3', '--sums', s, '--source-sha256', SOURCE).status, 0);
  for (const pkg of ['backroom-bin', 'backroom']) {
    for (const [f, from, to] of [
      ['PKGBUILD', 'pkgrel=1', 'pkgrel=2'],
      ['.SRCINFO', '\tpkgrel = 1', '\tpkgrel = 2'],
    ]) {
      const p = join(dir, 'packaging/aur', pkg, f);
      writeFileSync(p, readFileSync(p, 'utf8').replace(from, to));
    }
  }
  // Same version keeps the maintainer's pkgrel.
  assert.equal(run('1.2.3', '--sums', s, '--source-sha256', SOURCE).status, 0);
  assert.match(read('packaging/aur/backroom/PKGBUILD'), /^pkgrel=2$/m);

  const r = run('1.2.4', '--sums', writeSums(sums('1.2.4'), 'S2'), '--source-sha256', SOURCE);
  assert.equal(r.status, 0, r.stderr);
  for (const pkg of ['backroom-bin', 'backroom']) {
    assert.match(read(`packaging/aur/${pkg}/PKGBUILD`), /^pkgrel=1$/m);
    assert.match(read(`packaging/aur/${pkg}/.SRCINFO`), /^\tpkgrel = 1$/m);
  }
  assert.deepEqual(readdirSync(join(dir, WINGET)), ['1.2.4']);
});

test('refuses pre-release and invalid versions without writing anything', () => {
  const before = snapshot();
  for (const v of ['1.2.3-beta.1', '1.2.3-rc.1', '0.0.0', '1.2', 'v1.2.3', '256.0.0', '1.2.3+build']) {
    const r = run(v, '--sums', writeSums(sums(v)), '--source-sha256', SOURCE);
    assert.equal(r.status, 1, v);
    assert.match(r.stderr, /packaging-bump:/, v);
  }
  const pre = run('1.2.3-beta.1', '--sums', writeSums(sums('1.2.3-beta.1')), '--source-sha256', SOURCE);
  assert.match(pre.stderr, /pre-release/);
  assert.deepEqual(snapshot(), before);
});

test('refuses a SHA256SUMS without a needed asset, naming it, without writing anything', () => {
  const before = snapshot();
  for (const [omit, name] of [
    ['deb', 'Backroom_1.2.3_amd64.deb'],
    ['exe', 'Backroom_1.2.3_x64-setup.exe'],
    ['dmg', 'Backroom_1.2.3_universal.dmg'],
  ]) {
    const r = run('1.2.3', '--sums', writeSums(sums('1.2.3', { omit: [omit] })), '--source-sha256', SOURCE);
    assert.equal(r.status, 1, omit);
    assert.ok(r.stderr.includes(name), r.stderr);
  }
  // Assets the manifests do not use may be absent (as for a pre-release's rpm/msi).
  const r = run('1.2.3', '--sums', writeSums(sums('1.2.3', { omit: ['rpm', 'msi', 'appimage'] })), '--source-sha256', SOURCE);
  assert.equal(r.status, 0, r.stderr);
  assert.notDeepEqual(snapshot(), before);
});

test('refuses malformed SHA256SUMS content and bad --source-sha256 without writing anything', () => {
  const before = snapshot();
  const cases = [
    sums('1.2.3', { override: { deb: 'xyz' } }),
    sums('1.2.3', { override: { exe: h('A') } }), // upper case: sha256sum writes lower case
    sums('1.2.3', { extra: [`${h('a')}  Backroom_1.2.3_amd64.deb`] }), // duplicate name
    sums('1.2.3', { extra: [`${h('a')}  ../evil`] }),
    sums('1.2.3', { extra: ['garbage'] }),
  ];
  for (const text of cases) {
    const r = run('1.2.3', '--sums', writeSums(text), '--source-sha256', SOURCE);
    assert.equal(r.status, 1, text);
  }
  for (const bad of ['', '123', 'g'.repeat(64), ZERO]) {
    const r = run('1.2.3', '--sums', writeSums(sums('1.2.3')), '--source-sha256', bad);
    assert.equal(r.status, 1, bad);
  }
  assert.deepEqual(snapshot(), before);
});

test('a local --sums without --source-sha256 is refused (no network use)', () => {
  const before = snapshot();
  const r = run('1.2.3', '--sums', writeSums(sums('1.2.3')));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--source-sha256/);
  assert.deepEqual(snapshot(), before);
});

test('the placeholder check fails when the placeholder state is broken', () => {
  // A real hash with the placeholder version.
  const p = join(dir, 'packaging/homebrew/backroom.rb');
  writeFileSync(p, readFileSync(p, 'utf8').replace(`sha256 "${ZERO}"`, `sha256 "${h('f')}"`));
  const r = run('--check');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /homebrew/);
});

test('--check fails when manifests disagree on the version', () => {
  const p = join(dir, 'packaging/scoop/backroom.json');
  writeFileSync(p, readFileSync(p, 'utf8').replace('"version": "0.0.0"', '"version": "1.0.0"'));
  const r = run('--check');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /scoop/);
});

test('rejects unknown options and bad usage', () => {
  for (const args of [[], ['--nope'], ['1.2.3', '1.2.4'], ['--sums'], ['--check', '--check']]) {
    const r = run(...args);
    assert.equal(r.status, 1, args.join(' '));
  }
});

test('the bumped .SRCINFO files equal makepkg --printsrcinfo output', { skip: !hasMakepkg() && 'makepkg not installed' }, () => {
  assert.equal(run('1.2.3', '--sums', writeSums(sums('1.2.3')), '--source-sha256', SOURCE).status, 0);
  for (const pkg of ['backroom-bin', 'backroom']) {
    const cwd = join(dir, 'packaging/aur', pkg);
    const r = spawnSync('makepkg', ['--printsrcinfo'], { cwd, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(read(`packaging/aur/${pkg}/.SRCINFO`), r.stdout, pkg);
  }
});

function hasMakepkg() {
  return spawnSync('makepkg', ['--version'], { encoding: 'utf8' }).status === 0;
}
