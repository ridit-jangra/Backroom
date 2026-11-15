// Tests for scripts/packaging-validate.mjs (offline structural checks of every manifest).
// Each test works on a scratch copy of packaging/, so the repo itself is never touched.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseYaml, renderSrcinfo, validateAll } from './packaging-validate.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const WDIR = 'packaging/winget/manifests/r/Ridit/Backroom/0.0.0';
const hasBash = spawnSync('bash', ['--version']).status === 0;
const hasMakepkg = spawnSync('makepkg', ['--version']).status === 0;

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'packaging-validate-'));
  cpSync(join(REPO, 'scripts/fixtures/placeholder/packaging'), join(dir, 'packaging'), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function edit(rel, from, to) {
  const p = join(dir, rel);
  const text = readFileSync(p, 'utf8');
  assert.ok(text.includes(from), `${rel} does not contain ${JSON.stringify(from)}`);
  writeFileSync(p, text.replace(from, to));
}

/** validateAll's problems, as one string, after `mutate` ran on the scratch copy. */
function problems(mutate = () => {}) {
  mutate();
  return validateAll(dir).join('\n');
}

test('the committed manifests are valid', () => {
  assert.equal(problems(), '');
});

test('the CLI exits 0 on the repo and prints a summary', () => {
  const r = spawnSync(process.execPath, [join(REPO, 'scripts/packaging-validate.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ok/);
});

describe('parseYaml (the restricted subset the winget manifests use)', () => {
  test('mappings, nested mappings, scalar lists and lists of mappings', () => {
    const doc = parseYaml(
      [
        '# comment',
        '',
        'A: one',
        'B: "two: quoted"',
        "C: 'three'",
        'D:',
        '  E: /S',
        'L:',
        '- x',
        '- y',
        'M:',
        '- K: 1',
        '  J: https://example.com/a#b',
        'N: trailing # comment',
      ].join('\n'),
    );
    assert.deepEqual(doc, {
      A: 'one',
      B: 'two: quoted',
      C: 'three',
      D: { E: '/S' },
      L: ['x', 'y'],
      M: [{ K: '1', J: 'https://example.com/a#b' }],
      N: 'trailing',
    });
  });

  test('rejects what the subset does not support', () => {
    for (const bad of [
      'A: 1\nA: 2', // duplicate key
      'A:\n\tB: 1', // tab
      'A: &x 1', // anchor
      'A: *x', // alias
      'A: |\n  text', // block scalar
      'A: [1, 2]', // flow sequence
      'A: {b: 1}', // flow mapping
      'A: "unterminated',
      'just text',
      '  A: 1', // indented root
      'A:\n  - x\n B: 1', // bad indentation
      '---\nA: 1', // document marker
    ]) {
      assert.throws(() => parseYaml(bad), undefined, JSON.stringify(bad));
    }
  });
});

describe('winget', () => {
  test('missing required field', () => {
    assert.match(problems(() => edit(`${WDIR}/Ridit.Backroom.locale.en-US.yaml`, 'License: MIT\n', '')), /License/);
  });
  test('bad identifier', () => {
    assert.match(
      problems(() => edit(`${WDIR}/Ridit.Backroom.yaml`, 'PackageIdentifier: Ridit.Backroom', 'PackageIdentifier: Ridit Backroom')),
      /PackageIdentifier/,
    );
  });
  test('bad sha256', () => {
    assert.match(problems(() => edit(`${WDIR}/Ridit.Backroom.installer.yaml`, `InstallerSha256: ${'0'.repeat(64)}`, 'InstallerSha256: 1234')), /InstallerSha256/);
  });
  test('non-https installer url', () => {
    assert.match(problems(() => edit(`${WDIR}/Ridit.Backroom.installer.yaml`, 'InstallerUrl: https://', 'InstallerUrl: ftp://')), /InstallerUrl/);
  });
  test('versions disagree between files', () => {
    assert.match(problems(() => edit(`${WDIR}/Ridit.Backroom.installer.yaml`, 'PackageVersion: 0.0.0', 'PackageVersion: 0.0.1')), /PackageVersion/);
  });
  test('directory name differs from PackageVersion', () => {
    assert.match(
      problems(() => renameSync(join(dir, WDIR), join(dir, 'packaging/winget/manifests/r/Ridit/Backroom/9.9.9'))),
      /directory/,
    );
  });
  test('wrong installer type, scope and architecture', () => {
    const p = problems(() => {
      edit(`${WDIR}/Ridit.Backroom.installer.yaml`, 'InstallerType: nullsoft', 'InstallerType: exe');
      edit(`${WDIR}/Ridit.Backroom.installer.yaml`, 'Scope: user', 'Scope: machine');
      edit(`${WDIR}/Ridit.Backroom.installer.yaml`, 'Architecture: x64', 'Architecture: x86');
    });
    assert.match(p, /InstallerType/);
    assert.match(p, /Scope/);
    assert.match(p, /Architecture/);
  });
  test('ManifestType and schema comment must match the file', () => {
    const p = problems(() => {
      edit(`${WDIR}/Ridit.Backroom.yaml`, 'ManifestType: version', 'ManifestType: installer');
      edit(`${WDIR}/Ridit.Backroom.locale.en-US.yaml`, 'defaultLocale.1.9.0', 'defaultLocale.1.6.0');
    });
    assert.match(p, /ManifestType/);
    assert.match(p, /schema/);
  });
  test('short description length', () => {
    assert.match(
      problems(() => edit(`${WDIR}/Ridit.Backroom.locale.en-US.yaml`, 'ShortDescription: Desktop app for Backroom, a self-hosted team chat.', 'ShortDescription: ab')),
      /ShortDescription/,
    );
  });
});

describe('scoop', () => {
  const S = 'packaging/scoop/backroom.json';
  test('invalid JSON', () => {
    assert.match(problems(() => edit(S, '"license": "MIT",', '"license": "MIT"')), /scoop/);
  });
  test('missing autoupdate hash url', () => {
    assert.match(problems(() => edit(S, '"url": "https://github.com/ridit-jangra/Backroom/releases/download/v$version/SHA256SUMS",', '')), /scoop/);
  });
  test('non-canonical formatting (the bump script edits it as text)', () => {
    assert.match(problems(() => edit(S, '    "license": "MIT",', '  "license":   "MIT",')), /format/);
  });
  test('bad hash', () => {
    assert.match(problems(() => edit(S, `"hash": "${'0'.repeat(64)}"`, '"hash": "abc"')), /hash/);
  });
  test('installer must run silently into $dir', () => {
    assert.match(problems(() => edit(S, '"/D=$dir"', '"/D=C:\\\\x"')), /installer/);
  });
});

describe('homebrew cask', () => {
  const C = 'packaging/homebrew/backroom.rb';
  test('unbalanced do/end', () => {
    assert.match(problems(() => edit(C, '    strategy :github_latest\n  end\n', '    strategy :github_latest\n')), /do\/end/);
  });
  test('missing zap stanza', () => {
    assert.match(problems(() => edit(C, '  zap trash: [', '  trash: [')), /zap/);
  });
  test('bad sha256', () => {
    assert.match(problems(() => edit(C, `sha256 "${'0'.repeat(64)}"`, 'sha256 "abc"')), /sha256/);
  });
  test('url must template the version', () => {
    assert.match(problems(() => edit(C, 'download/v#{version}/', 'download/v0.0.0/')), /url/);
  });
  test('unterminated heredoc', () => {
    assert.match(problems(() => edit(C, '  EOS\n', '')), /heredoc|EOS/);
  });
  test('unbalanced quotes', () => {
    assert.match(problems(() => edit(C, 'name "Backroom"', 'name "Backroom')), /quote/);
  });
});

describe('PKGBUILD and .SRCINFO', { skip: !hasBash && 'bash not installed' }, () => {
  const B = 'packaging/aur/backroom-bin';
  test('bash syntax error', () => {
    assert.match(problems(() => edit(`${B}/PKGBUILD`, 'prepare() {', 'prepare() {{ (')), /PKGBUILD/);
  });
  test('stale .SRCINFO', () => {
    assert.match(problems(() => edit(`${B}/PKGBUILD`, "pkgdesc='Desktop app", "pkgdesc='A desktop app")), /\.SRCINFO/);
  });
  test('sums count differs from sources', () => {
    const p = problems(() => {
      edit(`${B}/PKGBUILD`, `sha256sums=('${'0'.repeat(64)}'\n            '${'0'.repeat(64)}')`, `sha256sums=('${'0'.repeat(64)}')`);
    });
    assert.match(p, /sha256sums/);
  });
  test('backroom-bin must provide and conflict with backroom', () => {
    assert.match(problems(() => edit(`${B}/PKGBUILD`, "provides=('backroom')\n", '')), /provides/);
  });
  test('the from-source package must use the tag tarball', () => {
    assert.match(problems(() => edit('packaging/aur/backroom/PKGBUILD', '/archive/refs/tags/v${pkgver}.tar.gz', '/archive/main.tar.gz')), /source/);
  });

  test('renderSrcinfo matches makepkg --printsrcinfo for both packages', { skip: !hasMakepkg && 'makepkg not installed' }, () => {
    for (const pkg of ['backroom-bin', 'backroom']) {
      const cwd = join(dir, 'packaging/aur', pkg);
      const r = spawnSync('makepkg', ['--printsrcinfo'], { cwd, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(renderSrcinfo(cwd), r.stdout, pkg);
    }
  });
});
