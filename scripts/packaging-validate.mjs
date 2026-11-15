#!/usr/bin/env node
// Offline structural checks of every package-manager manifest in packaging/. No network.
//
//   node scripts/packaging-validate.mjs
//
// - AUR PKGBUILDs: `bash -n`, then sourced by bash to read their variables; required values
//   (arch, license, url, provides/conflicts, the exact source URLs for pkgver, one 64-hex
//   sha256 per source), and .SRCINFO must equal what `makepkg --printsrcinfo` prints for the
//   PKGBUILD (rendered here by the same rules; the tests compare it with real makepkg).
// - Homebrew cask: balanced do/end and quotes, terminated heredocs, the required stanzas
//   (Ruby is not needed; this is not a substitute for `brew audit`).
// - Scoop: valid JSON in canonical formatting, required keys, the silent NSIS install.
// - winget: the three manifests in their standard directory, parsed by a strict parser for the
//   small YAML subset they use, checked against the required fields and the patterns of the
//   published 1.9.0 manifest schemas (the rules are written below; nothing is fetched).

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  CASK_URL_LINE,
  PATHS,
  PackagingError,
  REPO_URL,
  WINGET_FILES,
  WINGET_ID,
  WINGET_LOCALE,
  binNoextract,
  binSources,
  scoopUrl,
  srcSources,
  wingetInstallerUrl,
  wingetVersionDirs,
} from './packaging-lib.mjs';

const HEX64 = /^[0-9a-fA-F]{64}$/;

// ---------------------------------------------------------------------------------------------
// A strict parser for the YAML subset of the winget manifests: block mappings, block sequences
// (of scalars or of mappings), plain / single-quoted / double-quoted scalars, comments. Every
// scalar is returned as a string. Anything else (anchors, aliases, tags, flow collections,
// block scalars, multiple documents, tabs, duplicate keys) is an error.

export function parseYaml(text) {
  const lines = [];
  text.split('\n').forEach((raw, i) => {
    if (raw.includes('\t')) throw new Error(`line ${i + 1}: tab character`);
    if (/^\s*(#.*)?$/.test(raw)) return;
    if (/^(---|\.\.\.)(\s|$)/.test(raw)) throw new Error(`line ${i + 1}: document markers are not supported`);
    const indent = raw.length - raw.trimStart().length;
    lines.push({ n: i + 1, indent, content: raw.slice(indent).trimEnd() });
  });
  if (lines.length === 0) throw new Error('empty document');
  if (lines[0].indent !== 0) throw new Error(`line ${lines[0].n}: the document must start at column 1`);
  let i = 0;

  const isItem = (l) => l.content === '-' || l.content.startsWith('- ');

  function scalar(s, n) {
    if (s.startsWith('"')) {
      const m = /^"((?:[^"\\]|\\["\\])*)"(?:\s+#.*)?$/.exec(s);
      if (!m) throw new Error(`line ${n}: bad double-quoted scalar`);
      return m[1].replace(/\\(["\\])/g, '$1');
    }
    if (s.startsWith("'")) {
      const m = /^'((?:[^']|'')*)'(?:\s+#.*)?$/.exec(s);
      if (!m) throw new Error(`line ${n}: bad single-quoted scalar`);
      return m[1].replace(/''/g, "'");
    }
    const v = s.replace(/\s+#.*$/, '').trim();
    if (v === '' || /^[&*!|>[\]{}%@`]/.test(v)) throw new Error(`line ${n}: unsupported value ${JSON.stringify(s)}`);
    return v;
  }

  function block(indent) {
    if (i >= lines.length) throw new Error('unexpected end of document');
    return isItem(lines[i]) ? sequence(indent) : mapping(indent);
  }

  function mapping(indent, first = null) {
    const out = {};
    const entry = (l) => {
      const m = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s+(.*))?$/.exec(l.content);
      if (!m) throw new Error(`line ${l.n}: expected "Key: value"`);
      const [, key, rest] = m;
      if (Object.hasOwn(out, key)) throw new Error(`line ${l.n}: duplicate key ${key}`);
      i++;
      if (rest !== undefined && !/^#/.test(rest)) {
        out[key] = scalar(rest, l.n);
        return;
      }
      const next = lines[i];
      if (next && next.indent > l.indent) out[key] = block(next.indent);
      else if (next && next.indent === l.indent && isItem(next)) out[key] = sequence(l.indent);
      else throw new Error(`line ${l.n}: ${key} has no value`);
    };
    if (first) entry(first);
    while (i < lines.length) {
      const l = lines[i];
      if (l.indent < indent) break;
      if (l.indent > indent) throw new Error(`line ${l.n}: bad indentation`);
      if (isItem(l)) break;
      entry(l);
    }
    return out;
  }

  function sequence(indent) {
    const out = [];
    while (i < lines.length && lines[i].indent === indent && isItem(lines[i])) {
      const l = lines[i];
      const rest = l.content === '-' ? '' : l.content.slice(2);
      if (rest === '') throw new Error(`line ${l.n}: empty sequence item`);
      if (/^[A-Za-z][A-Za-z0-9_-]*:(\s|$)/.test(rest)) {
        // A mapping item: its first entry is on the dash line, the others two columns in.
        out.push(mapping(indent + 2, { n: l.n, indent: indent + 2, content: rest }));
      } else {
        out.push(scalar(rest, l.n));
        i++;
      }
    }
    if (i < lines.length && lines[i].indent > indent) throw new Error(`line ${lines[i].n}: bad indentation`);
    return out;
  }

  const doc = mapping(0);
  if (i < lines.length) throw new Error(`line ${lines[i].n}: bad indentation`);
  return doc;
}

// ---------------------------------------------------------------------------------------------
// AUR

const SRCINFO_SCALARS = ['pkgdesc', 'pkgver', 'pkgrel', 'epoch', 'url', 'install', 'changelog'];
const SRCINFO_ARRAYS_A = ['arch', 'groups', 'license', 'checkdepends', 'makedepends', 'depends', 'optdepends', 'provides', 'conflicts', 'replaces', 'noextract', 'options', 'backup', 'source', 'validpgpkeys'];
const SRCINFO_SUMS = ['cksums', 'md5sums', 'sha1sums', 'sha224sums', 'sha256sums', 'sha384sums', 'sha512sums', 'b2sums'];
const PKGBUILD_VARS = ['pkgname', 'pkgbase', ...SRCINFO_SCALARS, ...SRCINFO_ARRAYS_A, ...SRCINFO_SUMS];
const PKGBUILD_FUNCS = ['prepare', 'build', 'check', 'package'];

// Sources the PKGBUILD in a bash subshell and prints every variable as NUL-separated
// name, count, values...; then the defined functions.
const DUMP = `
set -e
cd "$(dirname -- "$1")"
source ./PKGBUILD
for v in ${PKGBUILD_VARS.join(' ')}; do
  declare -n r="$v"
  printf '%s\\0%s\\0' "$v" "\${#r[@]}"
  if [ "\${#r[@]}" -gt 0 ]; then printf '%s\\0' "\${r[@]}"; fi
  unset -n r
done
for f in ${PKGBUILD_FUNCS.join(' ')}; do
  if declare -F "$f" >/dev/null; then printf 'function\\0%s\\0' "$f"; fi
done
`;

function bashCheck(file) {
  const r = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
  if (r.error) throw new PackagingError(`bash is needed to check ${file}: ${r.error.message}`);
  return r.status === 0 ? null : r.stderr.trim();
}

/** The PKGBUILD's variables ({ name: string[] }) and functions (Set). */
export function readPkgbuild(dir) {
  const file = join(dir, 'PKGBUILD');
  const syntax = bashCheck(file);
  if (syntax) throw new PackagingError(`bash -n failed: ${syntax}`);
  const r = spawnSync('bash', ['--noprofile', '--norc', '-c', DUMP, 'bash', file], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  if (r.status !== 0) throw new PackagingError(`sourcing failed: ${r.stderr.trim()}`);
  const parts = r.stdout.split('\0');
  parts.pop();
  const vars = {};
  const funcs = new Set();
  for (let k = 0; k < parts.length; ) {
    if (parts[k] === 'function') {
      funcs.add(parts[k + 1]);
      k += 2;
      continue;
    }
    const name = parts[k];
    const count = Number(parts[k + 1]);
    vars[name] = parts.slice(k + 2, k + 2 + count);
    k += 2 + count;
  }
  return { vars, funcs };
}

/** The .SRCINFO text `makepkg --printsrcinfo` prints for this (single-package) PKGBUILD. */
export function renderSrcinfo(dir) {
  const { vars } = readPkgbuild(dir);
  const pkgname = vars.pkgname[0];
  const out = [`pkgbase = ${vars.pkgbase[0] ?? pkgname}`];
  for (const k of SRCINFO_SCALARS) if (vars[k].length && vars[k][0] !== '') out.push(`\t${k} = ${vars[k][0]}`);
  for (const k of [...SRCINFO_ARRAYS_A, ...SRCINFO_SUMS]) for (const v of vars[k]) out.push(`\t${k} = ${v}`);
  out.push('', `pkgname = ${pkgname}`);
  return `${out.join('\n')}\n`;
}

const RUNTIME_DEPS = ['gtk3', 'libayatana-appindicator', 'webkit2gtk-4.1'];

function validateAur(root, problems) {
  const pkgs = [
    { dir: 'packaging/aur/backroom-bin', name: 'backroom-bin', sources: binSources, noextract: binNoextract, funcs: ['prepare', 'package'] },
    { dir: 'packaging/aur/backroom', name: 'backroom', sources: srcSources, noextract: () => [], funcs: ['prepare', 'build', 'package'] },
  ];
  for (const p of pkgs) {
    const rel = `${p.dir}/PKGBUILD`;
    const bad = (msg) => problems.push(`${rel}: ${msg}`);
    let parsed;
    try {
      parsed = readPkgbuild(join(root, p.dir));
    } catch (e) {
      if (!(e instanceof PackagingError)) throw e;
      bad(e.message);
      continue;
    }
    const { vars, funcs } = parsed;
    const one = (k) => (vars[k].length === 1 ? vars[k][0] : null);
    const eq = (k, want) => {
      if (!isDeepStrictEqual(vars[k], want)) bad(`${k} is ${JSON.stringify(vars[k])}, expected ${JSON.stringify(want)}`);
    };
    eq('pkgname', [p.name]);
    eq('arch', ['x86_64']);
    eq('license', ['MIT']);
    eq('url', [REPO_URL]);
    const pkgver = one('pkgver');
    if (!pkgver || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(pkgver)) bad(`pkgver ${JSON.stringify(pkgver)} is not x.y.z`);
    if (!/^[1-9]\d*(\.[1-9]\d*)?$/.test(one('pkgrel') ?? '')) bad('pkgrel is not a positive number');
    if (pkgver) {
      eq('source', p.sources(pkgver));
      eq('noextract', p.noextract(pkgver));
    }
    if (vars.sha256sums.length !== vars.source.length) bad(`sha256sums has ${vars.sha256sums.length} entries for ${vars.source.length} sources`);
    for (const s of vars.sha256sums) if (!/^[0-9a-f]{64}$/.test(s)) bad(`sha256sums entry ${JSON.stringify(s)} is not 64 lower-case hex digits`);
    for (const k of SRCINFO_SUMS) if (k !== 'sha256sums' && vars[k].length) bad(`use sha256sums only (found ${k})`);
    for (const d of RUNTIME_DEPS) if (!vars.depends.includes(d)) bad(`depends lacks ${d}`);
    for (const f of p.funcs) if (!funcs.has(f)) bad(`no ${f}() function`);
    if (p.name === 'backroom-bin') {
      eq('provides', ['backroom']);
      eq('conflicts', ['backroom']);
    } else {
      for (const d of ['cargo', 'nodejs', 'npm']) if (!vars.makedepends.includes(d)) bad(`makedepends lacks ${d}`);
    }
    const srcinfoRel = `${p.dir}/.SRCINFO`;
    let srcinfo;
    try {
      srcinfo = readFileSync(join(root, srcinfoRel), 'utf8');
    } catch {
      problems.push(`${srcinfoRel}: missing`);
      continue;
    }
    if (srcinfo !== renderSrcinfo(join(root, p.dir))) {
      problems.push(`${srcinfoRel}: stale; run \`makepkg --printsrcinfo > .SRCINFO\` in ${p.dir}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Homebrew cask

function validateCask(root, problems) {
  const rel = PATHS.cask;
  const bad = (msg) => problems.push(`${rel}: ${msg}`);
  const lines = readFileSync(join(root, rel), 'utf8').split('\n');
  const code = []; // lines outside comments and heredoc bodies
  let heredoc = null;
  let depth = 0;
  let opened = false;
  lines.forEach((line, idx) => {
    const n = idx + 1;
    if (heredoc) {
      if (line.trim() === heredoc) heredoc = null;
      return;
    }
    if (/^\s*#/.test(line) || line.trim() === '') return;
    code.push({ n, line });
    const quotes = (line.replace(/\\./g, '').match(/"/g) ?? []).length;
    if (quotes % 2) bad(`line ${n}: unbalanced quote`);
    const hd = /<<~([A-Z]+)\s*$/.exec(line);
    if (hd) heredoc = hd[1];
    if (/(^|\s)do(\s*\|[^|]*\|)?\s*$/.test(line)) {
      depth++;
      opened = true;
    }
    if (/^\s*end\s*$/.test(line)) depth--;
    if (depth < 0) bad(`line ${n}: "end" without a matching "do" (do/end unbalanced)`);
  });
  if (heredoc) bad(`unterminated heredoc (no closing ${heredoc} line)`);
  if (depth !== 0 || !opened) bad(`do/end unbalanced (depth ${depth} at the end of the file)`);
  if (code[0]?.line !== 'cask "backroom" do') bad('the first statement must be: cask "backroom" do');
  if (code.at(-1)?.line !== 'end') bad('the last statement must be: end');

  const has = (re) => code.some(({ line }) => re.test(line));
  const stanza = (name, re) => {
    if (!has(re)) bad(`missing or malformed ${name} stanza`);
  };
  stanza('version', /^ {2}version "(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"$/);
  stanza('sha256', /^ {2}sha256 "[0-9a-f]{64}"$/);
  if (!code.some(({ line }) => line === CASK_URL_LINE)) bad(`the url stanza must be exactly: ${CASK_URL_LINE.trim()}`);
  stanza('name', /^ {2}name "Backroom"$/);
  stanza('desc', /^ {2}desc "[^"]+"$/);
  stanza('homepage', new RegExp(`^ {2}homepage "${REPO_URL}"$`));
  stanza('livecheck', /^ {2}livecheck do$/);
  stanza('app', /^ {2}app "Backroom\.app"$/);
  stanza('zap', /^ {2}zap trash: \[$/);
  stanza('caveats', /^ {2}caveats <<~EOS$/);
  const desc = code.find(({ line }) => /^ {2}desc "/.test(line))?.line.match(/"(.*)"/)?.[1] ?? '';
  if (/\.$/.test(desc) || /^(a|an|the|backroom)\b/i.test(desc)) bad('desc must not end with a period or start with an article or the app name (brew audit rules)');
}

// ---------------------------------------------------------------------------------------------
// Scoop

function validateScoop(root, problems) {
  const rel = PATHS.scoop;
  const bad = (msg) => problems.push(`${rel}: ${msg}`);
  const text = readFileSync(join(root, rel), 'utf8');
  let m;
  try {
    m = JSON.parse(text);
  } catch (e) {
    bad(`invalid JSON (${e.message})`);
    return;
  }
  if (`${JSON.stringify(m, null, 4)}\n` !== text) bad('not in the canonical format (4-space JSON.stringify plus a newline); the bump script edits it that way');
  const v = m.version;
  if (typeof v !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v)) {
    bad('version is not x.y.z');
    return;
  }
  const eq = (path, got, want) => {
    if (!isDeepStrictEqual(got, want)) bad(`${path} is ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  };
  for (const k of ['description', 'homepage']) if (typeof m[k] !== 'string' || !m[k]) bad(`${k} missing`);
  eq('homepage', m.homepage, REPO_URL);
  eq('license', m.license, 'MIT');
  const a = m.architecture?.['64bit'];
  eq('architecture.64bit.url', a?.url, scoopUrl(v));
  if (!HEX64.test(a?.hash ?? '')) bad('architecture.64bit.hash is not a 64-hex sha256');
  eq('installer', m.installer, { file: 'setup.exe', args: ['/S', '/NS', '/D=$dir'], keep: false });
  eq('uninstaller', m.uninstaller, { file: 'uninstall.exe', args: ['/S', '_?=$dir'] });
  eq('shortcuts', m.shortcuts, [['backroom-desktop.exe', 'Backroom']]);
  eq('checkver', m.checkver, 'github');
  const au = m.autoupdate?.architecture?.['64bit'];
  eq('autoupdate.architecture.64bit.url', au?.url, scoopUrl('$version'));
  eq('autoupdate.architecture.64bit.hash', au?.hash, { url: `${REPO_URL}/releases/download/v$version/SHA256SUMS`, regex: '$sha256\\s+$basename' });
}

// ---------------------------------------------------------------------------------------------
// winget (rules from the 1.9.0 manifest schemas)

const WINGET_MANIFEST_VERSION = '1.9.0';
const W = {
  identifier: /^[^.\s\\/:*?"<>|\x01-\x1f]{1,32}(\.[^.\s\\/:*?"<>|\x01-\x1f]{1,32}){1,7}$/,
  version: /^[^\\/:*?"<>|\x01-\x1f]+$/,
  locale: /^([a-zA-Z]{2,3}|[iI]-[a-zA-Z]+|[xX]-[a-zA-Z]{1,8})(-[a-zA-Z]{1,8})*$/,
  manifestVersion: /^(0|[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])(\.(0|[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])){2}$/,
  url: /^([Hh][Tt][Tt][Pp][Ss]?):\/\/.+$/,
  sha256: /^[A-Fa-f0-9]{64}$/,
};
const INSTALLER_TYPES = ['msix', 'msi', 'appx', 'exe', 'zip', 'inno', 'nullsoft', 'wix', 'burn', 'pwa', 'portable', 'font'];
const ARCHES = ['x86', 'x64', 'arm', 'arm64', 'neutral'];

function validateWinget(root, problems) {
  let dirs;
  try {
    dirs = wingetVersionDirs(root);
  } catch {
    problems.push(`${PATHS.wingetBase}: missing`);
    return;
  }
  if (dirs.length !== 1) {
    problems.push(`${PATHS.wingetBase}: expected exactly one version directory, found ${dirs.length}`);
    return;
  }
  const dirRel = `${PATHS.wingetBase}/${dirs[0]}`;
  const files = readdirSync(join(root, dirRel)).sort();
  const want = Object.values(WINGET_FILES).sort();
  if (!isDeepStrictEqual(files, want)) problems.push(`${dirRel}: expected exactly ${want.join(', ')}`);

  const docs = {};
  const types = { version: 'version', installer: 'installer', locale: 'defaultLocale' };
  for (const [k, f] of Object.entries(WINGET_FILES)) {
    const rel = `${dirRel}/${f}`;
    let text;
    try {
      text = readFileSync(join(root, rel), 'utf8');
    } catch {
      problems.push(`${rel}: missing`);
      continue;
    }
    const bad = (msg) => problems.push(`${rel}: ${msg}`);
    const schema = `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${types[k]}.${WINGET_MANIFEST_VERSION}.schema.json`;
    if (text.split('\n')[0] !== schema) bad(`the first line must be the schema comment: ${schema}`);
    let doc;
    try {
      doc = parseYaml(text);
    } catch (e) {
      bad(`YAML: ${e.message}`);
      continue;
    }
    docs[k] = doc;
    const str = (key, re, { min = 1, max = Infinity, required = true } = {}) => {
      const v = doc[key];
      if (v === undefined) {
        if (required) bad(`${key} is required`);
        return;
      }
      if (typeof v !== 'string' || v.length < min || v.length > max || (re && !re.test(v))) bad(`${key} ${JSON.stringify(v)} is invalid`);
    };
    str('PackageIdentifier', W.identifier, { max: 128 });
    str('PackageVersion', W.version, { max: 128 });
    str('ManifestVersion', W.manifestVersion);
    if (doc.PackageIdentifier !== WINGET_ID) bad(`PackageIdentifier must be ${WINGET_ID}`);
    if (doc.ManifestType !== types[k]) bad(`ManifestType must be ${types[k]}`);
    if (doc.ManifestVersion !== WINGET_MANIFEST_VERSION) bad(`ManifestVersion must be ${WINGET_MANIFEST_VERSION}`);
    if (doc.PackageVersion !== undefined && doc.PackageVersion !== dirs[0]) bad(`PackageVersion ${doc.PackageVersion} differs from the directory name ${dirs[0]}`);

    if (k === 'version') {
      str('DefaultLocale', W.locale, { max: 20 });
      if (doc.DefaultLocale !== WINGET_LOCALE) bad(`DefaultLocale must be ${WINGET_LOCALE}`);
    }
    if (k === 'locale') {
      str('PackageLocale', W.locale, { max: 20 });
      if (doc.PackageLocale !== WINGET_LOCALE) bad(`PackageLocale must be ${WINGET_LOCALE}`);
      str('Publisher', null, { min: 2, max: 256 });
      str('PackageName', null, { min: 2, max: 256 });
      str('License', null, { min: 3, max: 512 });
      str('ShortDescription', null, { min: 3, max: 256 });
      str('Description', null, { min: 3, max: 10000, required: false });
      for (const u of ['PublisherUrl', 'PackageUrl', 'LicenseUrl', 'ReleaseNotesUrl']) str(u, W.url, { max: 2048, required: false });
      str('Moniker', /^\S+$/, { max: 40, required: false });
      if (doc.Tags !== undefined) {
        if (!Array.isArray(doc.Tags) || doc.Tags.length > 16 || doc.Tags.some((t) => typeof t !== 'string' || !/^\S{1,40}$/.test(t))) bad('Tags must be at most 16 strings of 1-40 characters without spaces');
      }
      if (doc.License !== 'MIT') bad('License must be MIT');
    }
    if (k === 'installer') {
      if (doc.InstallerType !== undefined && !INSTALLER_TYPES.includes(doc.InstallerType)) bad('InstallerType is not a known type');
      if (doc.InstallerType !== 'nullsoft') bad('InstallerType must be nullsoft (the NSIS installer)');
      if (doc.Scope !== 'user') bad('Scope must be user (the NSIS installer is per-user)');
      if (doc.InstallerSwitches?.Silent !== '/S') bad('InstallerSwitches.Silent must be /S');
      if (!Array.isArray(doc.Installers) || doc.Installers.length !== 1) {
        bad('Installers must list exactly one installer');
        continue;
      }
      const inst = doc.Installers[0];
      if (!ARCHES.includes(inst.Architecture)) bad('Installers[0].Architecture is not a known architecture');
      if (inst.Architecture !== 'x64') bad('Installers[0].Architecture must be x64');
      if (typeof inst.InstallerUrl !== 'string' || !W.url.test(inst.InstallerUrl) || inst.InstallerUrl.length > 2048) bad('Installers[0].InstallerUrl is invalid');
      else if (inst.InstallerUrl !== wingetInstallerUrl(dirs[0])) bad(`Installers[0].InstallerUrl must be ${wingetInstallerUrl(dirs[0])}`);
      if (typeof inst.InstallerSha256 !== 'string' || !W.sha256.test(inst.InstallerSha256)) bad('Installers[0].InstallerSha256 is not a 64-hex sha256');
    }
  }
}

// ---------------------------------------------------------------------------------------------

/** Every problem found, as "path: message" strings (empty when everything is valid). */
export function validateAll(root) {
  const problems = [];
  validateAur(root, problems);
  validateCask(root, problems);
  validateScoop(root, problems);
  validateWinget(root, problems);
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  let problems;
  try {
    problems = validateAll(root);
  } catch (e) {
    if (!(e instanceof PackagingError)) throw e;
    problems = [e.message];
  }
  if (problems.length) {
    for (const p of problems) console.error(`packaging-validate: ${p}`);
    process.exit(1);
  }
  console.log('packaging manifests: ok (AUR x2, Homebrew cask, Scoop, winget)');
}
