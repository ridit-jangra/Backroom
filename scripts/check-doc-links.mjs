#!/usr/bin/env node
// Checks the relative links in the repository's main documents: every target file must exist, and a
// `#fragment` must match a heading of the target (GitHub's slug rules). External links are not fetched.
// Usage: node scripts/check-doc-links.mjs [file.md ...]   (default: the documents in DOCS below)
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DOCS = ['README.md', 'docs/SELF_HOSTING.md', 'docs/RELEASING.md', 'docs/DEPLOY.md', 'packaging/README.md'];

function stripCode(text) {
  return text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '').replace(/`[^`\n]*`/g, '');
}

export function slug(heading) {
  return heading
    .replace(/`/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

export function anchorsOf(text) {
  const seen = new Map();
  const out = new Set();
  for (const m of stripCode(text).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = slug(m[1]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

/** Returns a list of problems ("file: link -> reason"). `root` is the repository root. */
export function checkLinks(files, root = ROOT) {
  const problems = [];
  for (const rel of files) {
    const abs = join(root, rel);
    if (!existsSync(abs)) {
      problems.push(`${rel}: file does not exist`);
      continue;
    }
    const text = stripCode(readFileSync(abs, 'utf8'));
    for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const link = m[1].replace(/^<|>$/g, '');
      if (/^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith('//')) continue; // external, mailto:, ...
      const [pathPart, fragment] = link.split('#');
      const target = pathPart === '' ? abs : resolve(dirname(abs), decodeURIComponent(pathPart));
      if (!target.startsWith(root) || !existsSync(target)) {
        problems.push(`${rel}: ${link} -> target not found`);
        continue;
      }
      if (fragment && statSync(target).isFile() && target.endsWith('.md')) {
        if (!anchorsOf(readFileSync(target, 'utf8')).has(decodeURIComponent(fragment).toLowerCase())) {
          problems.push(`${rel}: ${link} -> no such heading`);
        }
      }
    }
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = process.argv.length > 2 ? process.argv.slice(2) : DOCS;
  const problems = checkLinks(files);
  for (const p of problems) console.error(p);
  console.log(problems.length === 0 ? `links ok (${files.length} files)` : `${problems.length} broken link(s)`);
  process.exit(problems.length === 0 ? 0 : 1);
}
