#!/usr/bin/env node
// Sets the desktop app's version in every file that carries it.
//
//   node scripts/set-version.mjs 1.2.3            update the files (clean git tree required)
//   node scripts/set-version.mjs 1.2.3 --force    update even with uncommitted changes
//   node scripts/set-version.mjs 1.2.3 --check    only verify that every file says 1.2.3
//
// Files: apps/desktop/package.json, apps/desktop/src-tauri/tauri.conf.json,
// apps/desktop/src-tauri/Cargo.toml, the backroom-desktop entry of
// apps/desktop/src-tauri/Cargo.lock and the apps/desktop entry of package-lock.json.
// Every edit replaces only the version text, then re-reads the file and checks that
// nothing else changed. Running it twice with the same version changes nothing.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// x.y.z with an optional pre-release (semver 2.0.0 section 9). Build metadata (+...)
// is refused: tags, file names and package managers would each treat it differently.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;

export function isValidVersion(v) {
  return typeof v === 'string' && v.length <= 64 && SEMVER.test(v);
}

class VersionError extends Error {}

function fail(msg) {
  throw new VersionError(msg);
}

/** A JSON file whose version sits at `pick(obj)`; edited as text, verified by parsing. */
function jsonFile(rel, label, pick, set) {
  return {
    rel,
    label,
    read(text) {
      const v = pick(JSON.parse(text));
      if (typeof v !== 'string') fail(`${rel}: no ${label} version found`);
      return v;
    },
    rewrite(text, from, to) {
      const before = JSON.parse(text);
      const needle = `"version": ${JSON.stringify(from)}`;
      // Try each occurrence until the parsed result differs exactly in the wanted field.
      let at = text.indexOf(needle);
      while (at !== -1) {
        const out = text.slice(0, at) + `"version": ${JSON.stringify(to)}` + text.slice(at + needle.length);
        const expected = structuredClone(before);
        set(expected, to);
        if (isDeepStrictEqual(JSON.parse(out), expected)) return out;
        at = text.indexOf(needle, at + 1);
      }
      fail(`${rel}: could not locate the ${label} version text to edit`);
    },
  };
}

/** A TOML-ish file where the version is the first `version = "..."` line inside a block. */
function blockFile(rel, label, blockStart) {
  // blockStart matches from the start of the block up to (not including) the version line.
  const find = (text) => {
    const m = blockStart.exec(text);
    if (!m) fail(`${rel}: ${label} block not found`);
    const start = m.index + m[0].length;
    const rest = text.slice(start);
    const end = rest.search(/^\[/m);
    const body = end === -1 ? rest : rest.slice(0, end);
    const v = /^version = "([^"\n]*)"$/m.exec(body);
    if (!v) fail(`${rel}: no version line in the ${label} block`);
    return { at: start + v.index, len: v[0].length, version: v[1] };
  };
  return {
    rel,
    label,
    read: (text) => find(text).version,
    rewrite(text, from, to) {
      const hit = find(text);
      if (hit.version !== from) fail(`${rel}: version changed while editing`);
      const out = text.slice(0, hit.at) + `version = "${to}"` + text.slice(hit.at + hit.len);
      if (find(out).version !== to || out.length !== text.length - from.length + to.length) {
        fail(`${rel}: edit check failed`);
      }
      return out;
    },
  };
}

export const FILES = [
  jsonFile(
    'apps/desktop/package.json',
    'package',
    (o) => o.version,
    (o, v) => {
      o.version = v;
    },
  ),
  jsonFile(
    'apps/desktop/src-tauri/tauri.conf.json',
    'app',
    (o) => o.version,
    (o, v) => {
      o.version = v;
    },
  ),
  blockFile('apps/desktop/src-tauri/Cargo.toml', '[package]', /^\[package\]\n/m),
  blockFile(
    'apps/desktop/src-tauri/Cargo.lock',
    'backroom-desktop',
    /^\[\[package\]\]\nname = "backroom-desktop"\n/m,
  ),
  jsonFile(
    'package-lock.json',
    '@backroom/desktop',
    (o) => o.packages?.['apps/desktop']?.version,
    (o, v) => {
      o.packages['apps/desktop'].version = v;
    },
  ),
];

/** Current version per file: [{ rel, version }]. */
export function readVersions(root) {
  return FILES.map((f) => ({ rel: f.rel, version: f.read(readFileSync(join(root, f.rel), 'utf8')) }));
}

function gitDirty(root) {
  let out;
  try {
    out = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    fail('could not run `git status` (not a git checkout?); use --force to skip the check');
  }
  return out.trim() !== '';
}

/**
 * Sets `version` everywhere. Returns lines describing what changed.
 * Throws VersionError on invalid input, a dirty tree (unless force) or a file it cannot edit.
 */
export function setVersion(root, version, { force = false } = {}) {
  if (!isValidVersion(version)) fail(`not a valid version: ${JSON.stringify(version)} (expected x.y.z or x.y.z-pre)`);
  if (!force && gitDirty(root)) fail('the git tree has uncommitted changes; commit or stash them, or pass --force');
  // Read and compute every edit first, so a failure leaves all files untouched.
  const edits = FILES.map((f) => {
    const path = join(root, f.rel);
    const text = readFileSync(path, 'utf8');
    const from = f.read(text);
    return { f, path, from, out: from === version ? null : f.rewrite(text, from, version) };
  });
  const lines = [];
  for (const e of edits) {
    if (e.out === null) {
      lines.push(`unchanged ${e.f.rel} (${version})`);
    } else {
      writeFileSync(e.path, e.out);
      lines.push(`updated   ${e.f.rel}: ${e.from} -> ${version}`);
    }
  }
  return lines;
}

/** Throws unless every file carries `version`. */
export function checkVersion(root, version) {
  if (!isValidVersion(version)) fail(`not a valid version: ${JSON.stringify(version)}`);
  const wrong = readVersions(root).filter((r) => r.version !== version);
  if (wrong.length) fail(`version mismatch, expected ${version}: ${wrong.map((r) => `${r.rel}=${r.version}`).join(', ')}`);
  return [`all ${FILES.length} files carry ${version}`];
}

function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const args = argv.filter((a) => !a.startsWith('--'));
  for (const f of flags) if (f !== '--force' && f !== '--check') fail(`unknown option ${f}`);
  if (args.length !== 1) fail('usage: node scripts/set-version.mjs <x.y.z[-pre]> [--force | --check]');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const lines = flags.has('--check') ? checkVersion(root, args[0]) : setVersion(root, args[0], { force: flags.has('--force') });
  for (const l of lines) console.log(l);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof VersionError)) throw e;
    console.error(`set-version: ${e.message}`);
    process.exit(1);
  }
}
