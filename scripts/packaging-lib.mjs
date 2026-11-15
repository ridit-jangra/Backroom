// Shared knowledge about the package-manager manifests in packaging/: where they live, which
// release assets they use, and the exact source URLs each one must carry for a version.
// Used by scripts/packaging-bump.mjs and scripts/packaging-validate.mjs.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Every expected failure (bad input, a manifest in an unexpected shape). */
export class PackagingError extends Error {}

export const REPO_URL = 'https://github.com/ridit-jangra/Backroom';
export const RELEASES = `${REPO_URL}/releases/download`;
export const RAW_URL = 'https://raw.githubusercontent.com/ridit-jangra/Backroom';

/** The committed state before the first release: version 0.0.0 and all-zero hashes. */
export const PLACEHOLDER = '0.0.0';
export const ZERO = '0'.repeat(64);

export const PATHS = {
  binPkgbuild: 'packaging/aur/backroom-bin/PKGBUILD',
  binSrcinfo: 'packaging/aur/backroom-bin/.SRCINFO',
  srcPkgbuild: 'packaging/aur/backroom/PKGBUILD',
  srcSrcinfo: 'packaging/aur/backroom/.SRCINFO',
  cask: 'packaging/homebrew/backroom.rb',
  scoop: 'packaging/scoop/backroom.json',
  wingetBase: 'packaging/winget/manifests/r/Ridit/Backroom',
};

export const WINGET_ID = 'Ridit.Backroom';
export const WINGET_LOCALE = 'en-US';
export const WINGET_FILES = {
  version: `${WINGET_ID}.yaml`,
  installer: `${WINGET_ID}.installer.yaml`,
  locale: `${WINGET_ID}.locale.${WINGET_LOCALE}.yaml`,
};

/** Release asset names (docs/RELEASING.md). Only these three are used by the manifests. */
export const ASSETS = {
  deb: (v) => `Backroom_${v}_amd64.deb`,
  exe: (v) => `Backroom_${v}_x64-setup.exe`,
  dmg: (v) => `Backroom_${v}_universal.dmg`,
};

export const assetUrl = (v, name) => `${RELEASES}/v${v}/${name}`;
export const sumsUrl = (v) => `${RELEASES}/v${v}/SHA256SUMS`;
export const tarballUrl = (v) => `${REPO_URL}/archive/refs/tags/v${v}.tar.gz`;

/** The expanded `source` entries (as .SRCINFO prints them) of each AUR package. */
export function binSources(v) {
  return [`${ASSETS.deb(v)}::${assetUrl(v, ASSETS.deb(v))}`, `backroom-LICENSE-${v}::${RAW_URL}/v${v}/LICENSE`];
}
export function binNoextract(v) {
  return [ASSETS.deb(v)];
}
export function srcSources(v) {
  return [`backroom-${v}.tar.gz::${tarballUrl(v)}`];
}

export const scoopUrl = (v) => `${assetUrl(v, ASSETS.exe(v))}#/setup.exe`;
export const wingetInstallerUrl = (v) => assetUrl(v, ASSETS.exe(v));
export const wingetReleaseNotesUrl = (v) => `${REPO_URL}/releases/tag/v${v}`;
/** The cask's url line, literally (Ruby interpolates #{version}). */
export const CASK_URL_LINE = `  url "${RELEASES}/v#{version}/Backroom_#{version}_universal.dmg"`;

/** The version directories under the winget base directory. */
export function wingetVersionDirs(root) {
  const base = join(root, PATHS.wingetBase);
  return readdirSync(base).filter((n) => statSync(join(base, n)).isDirectory());
}

export function readText(root, rel) {
  const text = readFileSync(join(root, rel), 'utf8');
  if (text.includes('\r')) throw new PackagingError(`${rel}: CRLF line endings (or a stray CR); convert the file to LF`);
  return text;
}

/** A top-level `name=value` assignment in a PKGBUILD (unquoted or single-quoted value). */
export function pkgbuildScalar(text, name) {
  const all = [...text.matchAll(new RegExp(`^${name}=(?:'([^'\\n]*)'|([^\\s'"()]*))$`, 'gm'))];
  if (all.length !== 1) return null;
  return all[0][1] ?? all[0][2];
}

/** The hashes inside the PKGBUILD's sha256sums=( ... ) array, in order. */
export function pkgbuildSums(text) {
  const all = [...text.matchAll(/^sha256sums=\(([^)]*)\)$/gm)];
  if (all.length !== 1) return null;
  const body = all[0][1];
  const items = body.split(/\s+/).filter(Boolean);
  const out = [];
  for (const it of items) {
    const m = /^'([0-9a-fA-F]{64})'$/.exec(it);
    if (!m) return null;
    out.push(m[1]);
  }
  return out;
}

/** .SRCINFO values of one key, in order (pkgbase section only). */
export function srcinfoValues(text, key) {
  const pkgbase = text.split(/\n\n/)[0];
  return [...pkgbase.matchAll(new RegExp(`^\\t${key} = (.*)$`, 'gm'))].map((m) => m[1]);
}

/** Strict SHA256SUMS parser: `<64 lower-case hex><two spaces or space-star><plain file name>`. */
export function parseSums(text) {
  const map = new Map();
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0) throw new PackagingError('SHA256SUMS is empty');
  for (const [i, line] of lines.entries()) {
    const m = /^([0-9a-f]{64}) [ *]([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line);
    if (!m) throw new PackagingError(`SHA256SUMS line ${i + 1} is not "<sha256>  <file name>": ${JSON.stringify(line.slice(0, 120))}`);
    if (map.has(m[2])) throw new PackagingError(`SHA256SUMS lists ${m[2]} twice`);
    map.set(m[2], m[1]);
  }
  return map;
}
