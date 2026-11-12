// Copies exactly the Twemoji SVGs listed in src/generated/images.txt into <dest>.
// Usage: node copy-twemoji.mjs <dest>   (dest is resolved against the caller's cwd)
// Inputs resolve from import.meta.url, so the cwd only matters for <dest>.
import { createRequire } from 'node:module';
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_FILES = 19_000;
const MAX_BYTES = 26_214_400;
const require = createRequire(import.meta.url);
const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const svgDir = join(dirname(require.resolve('@discordapp/twemoji/package.json')), 'dist', 'svg');

export async function copyTwemoji(dest) {
  const names = (await readFile(join(pkgRoot, 'src', 'generated', 'images.txt'), 'utf8')).split('\n').filter(Boolean);
  if (names.length > MAX_FILES) throw new Error(`too many twemoji files: ${names.length} > ${MAX_FILES}`);
  const out = resolve(dest);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  let bytes = 0;
  for (const name of names) {
    const from = join(svgDir, `${name}.svg`);
    const size = (await stat(from)).size;
    if (size > MAX_BYTES) throw new Error(`twemoji ${name}.svg is ${size} bytes (max ${MAX_BYTES})`);
    await copyFile(from, join(out, `${name}.svg`));
    bytes += size;
  }
  return { count: names.length, bytes };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dest = process.argv[2];
  if (!dest) {
    console.error('usage: copy-twemoji.mjs <dest>');
    process.exit(2);
  }
  const { count, bytes } = await copyTwemoji(dest);
  console.log(`copied ${count} twemoji (${bytes} bytes)`);
}
