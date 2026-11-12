// Generates src/generated/{data.ts,images.txt} from emoji-datasource + @discordapp/twemoji.
// Every path resolves from import.meta.url, so the cwd does not matter.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(pkgRoot, 'src', 'generated');
const datasource = dirname(require.resolve('emoji-datasource/package.json'));
const svgDir = join(dirname(require.resolve('@discordapp/twemoji/package.json')), 'dist', 'svg');

const emoji = JSON.parse(readFileSync(join(datasource, 'emoji.json'), 'utf8'));
const categories = Object.keys(JSON.parse(readFileSync(join(datasource, 'categories.json'), 'utf8')));
const TONES = ['1F3FB', '1F3FC', '1F3FD', '1F3FE', '1F3FF'];
const problems = [];

const hex = (u) => u.split('-').map((h) => parseInt(h, 16));
const charOf = (u) => String.fromCodePoint(...hex(u));

function imgOf(unified) {
  const cps = hex(unified).map((n) => n.toString(16));
  const noFe0f = cps.filter((c) => c !== 'fe0f');
  const candidates = [cps.includes('200d') ? cps : noFe0f, noFe0f, cps].map((c) => c.join('-'));
  const hit = candidates.find((c) => existsSync(join(svgDir, `${c}.svg`)));
  if (!hit) problems.push(`no twemoji image for ${unified}`);
  return hit ?? candidates[0];
}

const records = [];
const images = new Set();
for (const e of emoji) {
  const cat = categories.indexOf(e.category);
  if (cat < 0) problems.push(`unknown category ${e.category}`);
  const r = {
    names: e.short_names,
    char: charOf(e.unified),
    img: imgOf(e.unified),
    category: e.category,
    order: e.sort_order,
    keywords: e.name.toLowerCase(),
  };
  images.add(r.img);
  if (e.skin_variations) {
    r.skins = TONES.map((t) => {
      const v = e.skin_variations[t] ?? e.skin_variations[`${t}-${t}`];
      if (!v) {
        problems.push(`missing tone ${t} for ${e.short_name}`);
        return { char: '', img: '' };
      }
      const s = { char: charOf(v.unified), img: imgOf(v.unified) };
      images.add(s.img);
      return s;
    });
  }
  if (e.category === 'Component' || e.obsoleted_by) r.hidden = true;
  records.push({ cat, r });
}
if (problems.length) {
  console.error(`emoji generate failed:\n${problems.join('\n')}`);
  process.exit(1);
}
records.sort((a, b) => a.cat - b.cat || a.r.order - b.r.order);

const json = JSON.stringify(records.map((x) => x.r));
// One single-quoted string literal (U+2028/2029 are legal in string literals since ES2019).
const literal = `'${json.replace(/[\\']/g, '\\$&')}'`;
mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, 'data.ts'),
  `import type { EmojiRecord } from '../types';\nexport const DATA: EmojiRecord[] = JSON.parse(${literal});\n`,
);
writeFileSync(join(outDir, 'images.txt'), [...images].sort().join('\n') + '\n');
