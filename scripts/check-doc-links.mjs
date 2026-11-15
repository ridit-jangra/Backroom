#!/usr/bin/env node
// Checks the relative links in the repository's main documents: every target file must exist, and a
// `#fragment` must match a heading of the target (GitHub's slug rules). External links are not fetched.
// Usage: node scripts/check-doc-links.mjs [file.md ...]   (default: the documents in DOCS below)
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DOCS = ['README.md', 'docs/SELF_HOSTING.md', 'docs/RELEASING.md', 'docs/DEPLOY.md', 'packaging/README.md'];

// Removes fenced code blocks (``` or ~~~, indented any amount so list-item fences count) and inline code.
// A fence closes on the same character with at least the opening length.
function stripCode(text) {
  const out = [];
  let fence = null;
  for (const line of text.split('\n')) {
    if (fence) {
      const close = line.match(/^[ \t]*(`+|~+)[ \t]*$/);
      if (close && close[1][0] === fence.char && close[1].length >= fence.len) fence = null;
      continue;
    }
    const open = line.match(/^[ \t]*(`{3,}|~{3,})(.*)$/);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = { char: open[1][0], len: open[1].length };
      continue;
    }
    out.push(line);
  }
  return out.join('\n').replace(/`[^`\n]*`/g, '');
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
    const links = [];
    // Inline links; a destination may contain balanced parentheses (up to two levels).
    for (const m of text.matchAll(/\[[^\]]*\]\(\s*(<[^>\n]*>|(?:[^()\s]|\((?:[^()\s]|\([^()\s]*\))*\))+)(?:\s+"[^"]*")?\s*\)/g)) links.push(m[1]);
    // Reference-style definitions: [label]: target "title"
    for (const m of text.matchAll(/^ {0,3}\[[^\]\n]+\]:[ \t]*(<[^>\n]*>|\S+)/gm)) links.push(m[1]);
    for (const raw of links) {
      const link = raw.replace(/^<|>$/g, '');
      if (/^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith('//')) continue; // external, mailto:, ...
      const [pathPart, fragment] = link.split('#');
      let decodedPath;
      let decodedFragment;
      try {
        decodedPath = decodeURIComponent(pathPart);
        decodedFragment = fragment ? decodeURIComponent(fragment).toLowerCase() : fragment;
      } catch {
        problems.push(`${rel}: ${link} -> invalid percent-encoding`);
        continue;
      }
      const target = pathPart === '' ? abs : resolve(dirname(abs), decodedPath);
      const fromRoot = relative(root, target);
      if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot) || !existsSync(target)) {
        problems.push(`${rel}: ${link} -> target not found`);
        continue;
      }
      if (decodedFragment && statSync(target).isFile() && target.endsWith('.md')) {
        if (!anchorsOf(readFileSync(target, 'utf8')).has(decodedFragment)) {
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
