#!/usr/bin/env node
// Sets the version and checksums of every package-manager manifest in packaging/ from a
// published release's SHA256SUMS, or checks that they already match it.
//
//   node scripts/packaging-bump.mjs <x.y.z> [--sums <path|url>] [--source-sha256 <hex>]
//   node scripts/packaging-bump.mjs --check [<x.y.z>] [--sums <path|url>] [--source-sha256 <hex>]
//
// Manifests: packaging/aur/backroom-bin/{PKGBUILD,.SRCINFO} (the .deb and the LICENSE),
// packaging/aur/backroom/{PKGBUILD,.SRCINFO} (the tag's source tarball),
// packaging/homebrew/backroom.rb (the universal .dmg), packaging/scoop/backroom.json and the
// three winget manifests (the NSIS installer). The winget version directory is renamed.
//
// SHA256SUMS: --sums takes a local file or an https URL. Without --sums it is downloaded from
// the release (https://github.com/ridit-jangra/Backroom/releases/download/v<x.y.z>/SHA256SUMS).
// The source tarball is not in SHA256SUMS: pass its hash with --source-sha256, or let the
// script download https://github.com/ridit-jangra/Backroom/archive/refs/tags/v<x.y.z>.tar.gz
// and hash it. A local --sums file means "offline": then --source-sha256 is required.
// The LICENSE hash for backroom-bin comes from this checkout's LICENSE file.
//
// Only stable versions are accepted: a pre-release has no RPM or MSI and is not packaged.
// Every edit is computed before anything is written, so a failure writes nothing, and a second
// run with the same inputs changes nothing.
//
// --check verifies every manifest against SHA256SUMS (and the version, if given). The committed
// placeholder state (version 0.0.0, all-zero hashes) passes as "not yet released" without
// SHA256SUMS. It also fails when a .SRCINFO disagrees with its PKGBUILD (pkgver, pkgrel,
// source, sha256sums): re-run `makepkg --printsrcinfo > .SRCINFO` after editing a PKGBUILD.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidVersion } from './set-version.mjs';
import {
  ASSETS,
  CASK_URL_LINE,
  PATHS,
  PLACEHOLDER,
  PackagingError,
  WINGET_FILES,
  ZERO,
  binNoextract,
  binSources,
  parseSums,
  pkgbuildScalar,
  pkgbuildSums,
  readText,
  scoopUrl,
  srcSources,
  srcinfoValues,
  sumsUrl,
  tarballUrl,
  wingetInstallerUrl,
  wingetReleaseNotesUrl,
  wingetVersionDirs,
} from './packaging-lib.mjs';

function fail(msg) {
  throw new PackagingError(msg);
}

const HEX64 = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------------------------
// Inputs

function checkStableVersion(v) {
  if (typeof v !== 'string' || !isValidVersion(v)) {
    fail(`not a valid version: ${JSON.stringify(v)} (expected x.y.z, at most 255.255.65535)`);
  }
  if (v.includes('-')) fail(`${v} is a pre-release: pre-releases have no RPM or MSI and are not packaged`);
  if (v === PLACEHOLDER) fail(`${PLACEHOLDER} is the placeholder version, not a release`);
}

async function download(url, maxBytes) {
  if (!url.startsWith('https://')) fail(`refusing a non-https URL: ${url}`);
  let res;
  try {
    res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  } catch (e) {
    fail(`could not download ${url}: ${e.message}`);
  }
  if (!res.ok) fail(`could not download ${url}: HTTP ${res.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > maxBytes) fail(`${url} is larger than ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Returns { sums: Map, offline: boolean }. */
async function loadSums(version, sumsArg) {
  if (sumsArg === undefined || /^https?:\/\//.test(sumsArg)) {
    const url = sumsArg ?? sumsUrl(version);
    return { sums: parseSums((await download(url, 64 * 1024)).toString('utf8')), offline: false };
  }
  let text;
  try {
    text = readFileSync(sumsArg, 'utf8');
  } catch (e) {
    fail(`could not read ${sumsArg}: ${e.message}`);
  }
  return { sums: parseSums(text), offline: true };
}

async function sourceSha(version, arg, offline) {
  if (arg !== undefined) {
    if (!HEX64.test(arg) || arg === ZERO) fail('--source-sha256 must be 64 lower-case hex digits (and not all zero)');
    return arg;
  }
  if (offline) {
    fail('with a local --sums file, pass --source-sha256 <hex> for the source tarball (no network is used)');
  }
  const body = await download(tarballUrl(version), 512 * 1024 * 1024);
  return createHash('sha256').update(body).digest('hex');
}

function needAsset(sums, name) {
  const h = sums.get(name);
  if (!h) fail(`SHA256SUMS has no entry for ${name}`);
  return h;
}

// ---------------------------------------------------------------------------------------------
// Text edits. Each helper requires exactly one match, so an unexpected file shape fails loudly.

function replaceLine(text, rel, re, line) {
  const flags = re.flags.includes('m') ? re.flags : `${re.flags}m`;
  const all = [...text.matchAll(new RegExp(re.source, flags.includes('g') ? flags : `${flags}g`))];
  if (all.length !== 1) fail(`${rel}: expected exactly one line matching ${re}, found ${all.length}`);
  const m = all[0];
  return text.slice(0, m.index) + line + text.slice(m.index + m[0].length);
}

/** Replaces every `\t<key> = ...` line of a .SRCINFO, in order, with `values`. */
function replaceSrcinfoKey(text, rel, key, values) {
  const re = new RegExp(`^\\t${key} = .*$`, 'gm');
  const hits = [...text.matchAll(re)];
  if (hits.length !== values.length) fail(`${rel}: expected ${values.length} "${key}" lines, found ${hits.length}`);
  let out = '';
  let last = 0;
  hits.forEach((m, i) => {
    out += text.slice(last, m.index) + `\t${key} = ${values[i]}`;
    last = m.index + m[0].length;
  });
  return out + text.slice(last);
}

/** Replaces the hashes in the PKGBUILD's sha256sums array, keeping its layout. */
function replacePkgbuildSums(text, rel, hashes) {
  const current = pkgbuildSums(text);
  if (!current) fail(`${rel}: no single sha256sums=( '...' ) array of 64-hex hashes`);
  if (current.length !== hashes.length) fail(`${rel}: expected ${hashes.length} sha256sums, found ${current.length}`);
  const m = /^sha256sums=\(([^)]*)\)$/m.exec(text);
  let i = 0;
  const body = m[1].replace(/'[0-9a-fA-F]{64}'/g, () => `'${hashes[i++]}'`);
  return text.slice(0, m.index) + `sha256sums=(${body})` + text.slice(m.index + m[0].length);
}

function editAur(text, srcinfo, rel, relInfo, version, hashes, sources, noextract) {
  const old = pkgbuildScalar(text, 'pkgver');
  if (old === null) fail(`${rel}: no pkgver= line`);
  const pkgrel = pkgbuildScalar(text, 'pkgrel');
  if (pkgrel === null || !/^[1-9][0-9]*(\.[1-9][0-9]*)?$/.test(pkgrel)) fail(`${rel}: no valid pkgrel= line`);
  const newRel = old === version ? pkgrel : '1';
  let p = replaceLine(text, rel, /^pkgver=.*$/, `pkgver=${version}`);
  p = replaceLine(p, rel, /^pkgrel=.*$/, `pkgrel=${newRel}`);
  p = replacePkgbuildSums(p, rel, hashes);

  let s = replaceLine(srcinfo, relInfo, /^\tpkgver = .*$/, `\tpkgver = ${version}`);
  s = replaceLine(s, relInfo, /^\tpkgrel = .*$/, `\tpkgrel = ${newRel}`);
  s = replaceSrcinfoKey(s, relInfo, 'source', sources);
  if (noextract) s = replaceSrcinfoKey(s, relInfo, 'noextract', noextract);
  s = replaceSrcinfoKey(s, relInfo, 'sha256sums', hashes);
  return [p, s];
}

/** Scoop JSON is edited through JSON.parse/stringify; the file must already be in that format. */
function scoopFormat(obj) {
  return `${JSON.stringify(obj, null, 4)}\n`;
}

function readScoop(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    fail(`${PATHS.scoop}: invalid JSON (${e.message})`);
  }
  if (scoopFormat(obj) !== text) fail(`${PATHS.scoop}: not in the canonical format (4-space JSON.stringify)`);
  const a = obj?.architecture?.['64bit'];
  if (typeof obj.version !== 'string' || typeof a?.url !== 'string' || typeof a?.hash !== 'string') {
    fail(`${PATHS.scoop}: version, architecture.64bit.url or architecture.64bit.hash missing`);
  }
  return obj;
}

function wingetDir(root) {
  const dirs = wingetVersionDirs(root);
  if (dirs.length !== 1) fail(`${PATHS.wingetBase}: expected exactly one version directory, found ${dirs.length}`);
  return dirs[0];
}

// ---------------------------------------------------------------------------------------------
// Reading the current state (shared by bump and check)

function load(root) {
  const t = (rel) => readText(root, rel);
  const wv = wingetDir(root);
  const wrel = (f) => `${PATHS.wingetBase}/${wv}/${f}`;
  return {
    bin: t(PATHS.binPkgbuild),
    binInfo: t(PATHS.binSrcinfo),
    src: t(PATHS.srcPkgbuild),
    srcInfo: t(PATHS.srcSrcinfo),
    cask: t(PATHS.cask),
    scoop: t(PATHS.scoop),
    wingetVersion: wv,
    winget: Object.fromEntries(Object.entries(WINGET_FILES).map(([k, f]) => [k, { rel: wrel(f), text: t(wrel(f)) }])),
  };
}

function caskValue(text, key) {
  const all = [...text.matchAll(new RegExp(`^  ${key} "([^"\\n]*)"$`, 'gm'))];
  return all.length === 1 ? all[0][1] : null;
}

function yamlValue(text, key, indent = '') {
  const all = [...text.matchAll(new RegExp(`^${indent}${key}: (\\S+)$`, 'gm'))];
  return all.length === 1 ? all[0][1] : null;
}

function licenseSha(root) {
  return createHash('sha256').update(readFileSync(join(root, 'LICENSE'))).digest('hex');
}

// ---------------------------------------------------------------------------------------------
// Bump

export async function bump(root, version, { sums: sumsArg, sourceSha256 } = {}) {
  checkStableVersion(version);
  const { sums, offline } = await loadSums(version, sumsArg);
  const deb = needAsset(sums, ASSETS.deb(version));
  const exe = needAsset(sums, ASSETS.exe(version));
  const dmg = needAsset(sums, ASSETS.dmg(version));
  const src = await sourceSha(version, sourceSha256, offline);
  const lic = licenseSha(root);

  const cur = load(root);
  const out = new Map(); // rel -> [before, after]
  const put = (rel, before, after) => out.set(rel, [before, after]);

  const [bin, binInfo] = editAur(cur.bin, cur.binInfo, PATHS.binPkgbuild, PATHS.binSrcinfo, version, [deb, lic], binSources(version), binNoextract(version));
  put(PATHS.binPkgbuild, cur.bin, bin);
  put(PATHS.binSrcinfo, cur.binInfo, binInfo);
  const [srcP, srcInfo] = editAur(cur.src, cur.srcInfo, PATHS.srcPkgbuild, PATHS.srcSrcinfo, version, [src], srcSources(version), null);
  put(PATHS.srcPkgbuild, cur.src, srcP);
  put(PATHS.srcSrcinfo, cur.srcInfo, srcInfo);

  let cask = replaceLine(cur.cask, PATHS.cask, /^ {2}version ".*"$/, `  version "${version}"`);
  cask = replaceLine(cask, PATHS.cask, /^ {2}sha256 ".*"$/, `  sha256 "${dmg}"`);
  if (!cask.split('\n').includes(CASK_URL_LINE)) fail(`${PATHS.cask}: the url line is not the expected one`);
  put(PATHS.cask, cur.cask, cask);

  const scoop = readScoop(cur.scoop);
  scoop.version = version;
  scoop.architecture['64bit'].url = scoopUrl(version);
  scoop.architecture['64bit'].hash = exe;
  put(PATHS.scoop, cur.scoop, scoopFormat(scoop));

  const newDir = `${PATHS.wingetBase}/${version}`;
  const wingetOut = {};
  for (const [k, { rel, text }] of Object.entries(cur.winget)) {
    let w = replaceLine(text, rel, /^PackageVersion: .*$/, `PackageVersion: ${version}`);
    if (k === 'installer') {
      w = replaceLine(w, rel, /^ {2}InstallerUrl: .*$/, `  InstallerUrl: ${wingetInstallerUrl(version)}`);
      w = replaceLine(w, rel, /^ {2}InstallerSha256: .*$/, `  InstallerSha256: ${exe.toUpperCase()}`);
    }
    if (k === 'locale') {
      w = replaceLine(w, rel, /^ReleaseNotesUrl: .*$/, `ReleaseNotesUrl: ${wingetReleaseNotesUrl(version)}`);
    }
    wingetOut[k] = { rel, newRel: `${newDir}/${WINGET_FILES[k]}`, before: text, after: w };
  }

  // Everything is computed: write.
  const lines = [];
  let changed = 0;
  const report = (rel, before, after) => {
    if (before === after) return;
    changed++;
    lines.push(...diff(rel, before, after));
  };
  for (const [rel, [before, after]] of out) {
    if (before !== after) writeFileSync(join(root, rel), after);
    report(rel, before, after);
  }
  const oldDir = `${PATHS.wingetBase}/${cur.wingetVersion}`;
  if (oldDir !== newDir) {
    mkdirSync(join(root, newDir), { recursive: true });
    for (const w of Object.values(wingetOut)) writeFileSync(join(root, w.newRel), w.after);
    rmSync(join(root, oldDir), { recursive: true });
    lines.push(`rename ${oldDir} -> ${newDir}`);
    changed++;
  } else {
    for (const w of Object.values(wingetOut)) if (w.before !== w.after) writeFileSync(join(root, w.rel), w.after);
  }
  for (const w of Object.values(wingetOut)) report(w.newRel, w.before, w.after);

  if (changed === 0) lines.push(`no changes: every manifest already carries ${version} and its checksums`);
  else lines.push(`updated the manifests to ${version}; review with git diff, then publish (packaging/README.md)`);
  return lines;
}

/** A minimal line diff for same-length texts (the edits only replace lines). */
function diff(rel, before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  const out = [`--- ${rel}`];
  if (a.length !== b.length) return [...out, '(line count changed)'];
  a.forEach((l, i) => {
    if (l !== b[i]) out.push(`-${l}`, `+${b[i]}`);
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Check

export async function check(root, versionArg, { sums: sumsArg, sourceSha256 } = {}) {
  const cur = load(root);
  const problems = [];
  const scoop = readScoop(cur.scoop);

  // 1. One version everywhere.
  const versions = [
    [PATHS.binPkgbuild, pkgbuildScalar(cur.bin, 'pkgver')],
    [PATHS.binSrcinfo, srcinfoValues(cur.binInfo, 'pkgver')[0] ?? null],
    [PATHS.srcPkgbuild, pkgbuildScalar(cur.src, 'pkgver')],
    [PATHS.srcSrcinfo, srcinfoValues(cur.srcInfo, 'pkgver')[0] ?? null],
    [PATHS.cask, caskValue(cur.cask, 'version')],
    [PATHS.scoop, scoop.version],
    [`${PATHS.wingetBase}/ (directory name)`, cur.wingetVersion],
    ...Object.values(cur.winget).map((w) => [w.rel, yamlValue(w.text, 'PackageVersion')]),
  ];
  const version = versions[0][1];
  const odd = versions.filter(([, v]) => v !== version);
  if (version === null || odd.length) {
    fail(`the manifests disagree on the version:\n${versions.map(([r, v]) => `  ${r}: ${v}`).join('\n')}`);
  }
  if (versionArg !== undefined && versionArg !== version) fail(`the manifests carry ${version}, not ${versionArg}`);

  // 2. Each .SRCINFO agrees with its PKGBUILD, and the URLs are the expected ones.
  const aur = [
    [PATHS.binPkgbuild, PATHS.binSrcinfo, cur.bin, cur.binInfo, binSources(version), binNoextract(version)],
    [PATHS.srcPkgbuild, PATHS.srcSrcinfo, cur.src, cur.srcInfo, srcSources(version), []],
  ];
  for (const [rel, relInfo, p, s, sources, noextract] of aur) {
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    if (!same(srcinfoValues(s, 'pkgrel'), [pkgbuildScalar(p, 'pkgrel')])) problems.push(`${relInfo}: pkgrel differs from ${rel}`);
    if (!same(srcinfoValues(s, 'sha256sums'), pkgbuildSums(p))) problems.push(`${relInfo}: sha256sums differ from ${rel}`);
    if (!same(srcinfoValues(s, 'source'), sources)) problems.push(`${relInfo}: source entries are not the expected URLs for ${version}`);
    if (!same(srcinfoValues(s, 'noextract'), noextract)) problems.push(`${relInfo}: noextract entries are not the expected ones for ${version}`);
  }
  if (!cur.cask.split('\n').includes(CASK_URL_LINE)) problems.push(`${PATHS.cask}: the url line is not the expected one`);
  if (scoop.architecture['64bit'].url !== scoopUrl(version)) problems.push(`${PATHS.scoop}: architecture.64bit.url is not ${scoopUrl(version)}`);
  const inst = cur.winget.installer;
  if (yamlValue(inst.text, 'InstallerUrl', '  ') !== wingetInstallerUrl(version)) problems.push(`${inst.rel}: InstallerUrl is not ${wingetInstallerUrl(version)}`);
  const loc = cur.winget.locale;
  if (yamlValue(loc.text, 'ReleaseNotesUrl') !== wingetReleaseNotesUrl(version)) problems.push(`${loc.rel}: ReleaseNotesUrl is not ${wingetReleaseNotesUrl(version)}`);

  // 3. The hashes.
  const binSums = pkgbuildSums(cur.bin) ?? [];
  const srcSums = pkgbuildSums(cur.src) ?? [];
  const have = [
    [PATHS.binPkgbuild, 'deb', binSums[0]],
    [PATHS.binPkgbuild, 'LICENSE', binSums[1]],
    [PATHS.srcPkgbuild, 'source tarball', srcSums[0]],
    [PATHS.cask, 'dmg', caskValue(cur.cask, 'sha256')],
    [PATHS.scoop, 'exe', scoop.architecture['64bit'].hash],
    [inst.rel, 'exe', yamlValue(inst.text, 'InstallerSha256', '  ')?.toLowerCase()],
  ];
  if (binSums.length !== 2) problems.push(`${PATHS.binPkgbuild}: expected 2 sha256sums`);
  if (srcSums.length !== 1) problems.push(`${PATHS.srcPkgbuild}: expected 1 sha256sum`);

  if (version === PLACEHOLDER) {
    for (const [rel, what, h] of have) if (h !== ZERO) problems.push(`${rel}: ${what} hash must be all zeros in the ${PLACEHOLDER} placeholder state`);
    if (problems.length) fail(`check failed:\n${problems.map((p) => `  ${p}`).join('\n')}`);
    return [`not yet released (placeholder ${PLACEHOLDER} with all-zero hashes): ok`];
  }

  checkStableVersion(version);
  const { sums, offline } = await loadSums(version, sumsArg);
  const want = {
    deb: needAsset(sums, ASSETS.deb(version)),
    exe: needAsset(sums, ASSETS.exe(version)),
    dmg: needAsset(sums, ASSETS.dmg(version)),
    LICENSE: licenseSha(root),
    'source tarball': await sourceSha(version, sourceSha256, offline),
  };
  for (const [rel, what, h] of have) {
    if (h !== want[what]) problems.push(`${rel}: ${what} hash ${h ?? '(missing)'} does not match ${want[what]}`);
  }
  if (problems.length) fail(`check failed:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  return [`every manifest matches ${version} and its SHA256SUMS`];
}

// ---------------------------------------------------------------------------------------------
// CLI

function parseArgs(argv) {
  const opts = { check: false, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') {
      if (opts.check) fail('--check given twice');
      opts.check = true;
    } else if (a === '--sums' || a === '--source-sha256') {
      const key = a === '--sums' ? 'sums' : 'sourceSha256';
      if (opts[key] !== undefined) fail(`${a} given twice`);
      if (i + 1 >= argv.length) fail(`${a} needs a value`);
      opts[key] = argv[++i];
    } else if (a.startsWith('-')) {
      fail(`unknown option ${a}`);
    } else {
      opts.positional.push(a);
    }
  }
  const usage =
    'usage: node scripts/packaging-bump.mjs <x.y.z> [--sums <path|url>] [--source-sha256 <hex>]\n' +
    '       node scripts/packaging-bump.mjs --check [<x.y.z>] [--sums <path|url>] [--source-sha256 <hex>]';
  if (opts.check ? opts.positional.length > 1 : opts.positional.length !== 1) fail(usage);
  return opts;
}

async function main(argv) {
  const opts = parseArgs(argv);
  const root = fileURLToPath(new URL('..', import.meta.url));
  const o = { sums: opts.sums, sourceSha256: opts.sourceSha256 };
  const lines = opts.check ? await check(root, opts.positional[0], o) : await bump(root, opts.positional[0], o);
  for (const l of lines) console.log(l);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((e) => {
    if (!(e instanceof PackagingError)) throw e;
    console.error(`packaging-bump: ${e.message}`);
    process.exit(1);
  });
}
