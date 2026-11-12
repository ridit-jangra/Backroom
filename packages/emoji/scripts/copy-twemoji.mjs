// Copies exactly the Twemoji SVGs listed in src/generated/images.txt into <dest>.
// Usage: node copy-twemoji.mjs <dest>   (dest is resolved against the caller's cwd)
// Inputs resolve from import.meta.url, so the cwd only matters for <dest>.
import { createRequire } from 'node:module';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_FILES = 19_000;
const MAX_BYTES = 26_214_400;
const require = createRequire(import.meta.url);
const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const twemojiRoot = dirname(require.resolve('@discordapp/twemoji/package.json'));
const svgDir = join(twemojiRoot, 'dist', 'svg');

const GRAPHICS_NOTICE = `Emoji graphics by Twemoji, CC-BY 4.0
Source: https://github.com/jdecked/twemoji (via @discordapp/twemoji)
Licence: Creative Commons Attribution 4.0 International, https://creativecommons.org/licenses/by/4.0/
Copyright Twitter, Inc and other contributors. The npm package's LICENSE (MIT) covers its code only.
`;

export async function copyTwemoji(dest, imagesFile = join(pkgRoot, 'src', 'generated', 'images.txt')) {
  const names = (await readFile(imagesFile, 'utf8')).split('\n').filter(Boolean);
  if (names.length === 0) throw new Error('images.txt is empty; run generate first');
  if (names.length > MAX_FILES) throw new Error(`too many twemoji files: ${names.length} > ${MAX_FILES}`);
  const out = resolve(dest);
  const rel = relative(out, pkgRoot);
  const ancestor = rel === '' || !(rel.startsWith('..') || isAbsolute(rel));
  if (out === parse(out).root || out === process.cwd() || ancestor) {
    throw new Error(`refusing to empty ${out}`);
  }
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
  // The npm package ships no CC-BY text (only the MIT LICENSE for code), so write a notice
  // for the graphics and copy the package LICENSE next to the art (not counted in `count`).
  await writeFile(join(out, 'LICENSE-GRAPHICS.txt'), GRAPHICS_NOTICE);
  await copyFile(join(twemojiRoot, 'LICENSE'), join(out, 'LICENSE-CODE.txt'));
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
