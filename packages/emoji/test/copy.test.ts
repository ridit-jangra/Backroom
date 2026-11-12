import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script without types
import { copyTwemoji } from '../scripts/copy-twemoji.mjs';

const script = (n: string) => fileURLToPath(new URL(`../scripts/${n}`, import.meta.url));
const shared = fileURLToPath(new URL('../src/generated', import.meta.url));

describe('twemoji copy', () => {
  it('copies exactly the needed SVGs within asset limits', async () => {
    const dest = mkdtempSync(join(tmpdir(), 'twemoji-'));
    try {
      const r = await copyTwemoji(dest);
      const files = readdirSync(dest).filter((f) => f.endsWith('.svg'));
      expect(r.count).toBe(3_526);
      expect(files).toHaveLength(3_526);
      expect(r.bytes).toBe(files.reduce((n, f) => n + statSync(join(dest, f)).size, 0));
      for (const f of files) expect(statSync(join(dest, f)).size).toBeLessThanOrEqual(26_214_400);
      expect(existsSync(join(dest, '1f44d.svg'))).toBe(true);
      expect(existsSync(join(dest, '23-20e3.svg'))).toBe(true);
      expect(readFileSync(join(dest, 'LICENSE-GRAPHICS.txt'), 'utf8')).toContain('CC-BY 4.0');
      expect(existsSync(join(dest, 'LICENSE-CODE.txt'))).toBe(true);
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });
  it('generate.mjs and copy-twemoji.mjs do not depend on the cwd', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cwd-'));
    try {
      // Generate into a temp dir (never the shared files other tests are reading).
      execFileSync(process.execPath, [script('generate.mjs'), 'gen'], { cwd });
      for (const f of ['data.ts', 'images.txt']) {
        expect(readFileSync(join(cwd, 'gen', f), 'utf8')).toBe(readFileSync(join(shared, f), 'utf8'));
      }
      execFileSync(process.execPath, [script('copy-twemoji.mjs'), 'out'], { cwd });
      expect(readdirSync(join(cwd, 'out')).filter((f) => f.endsWith('.svg'))).toHaveLength(3_526);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
  it('refuses to empty the cwd, a root or an ancestor of the package', async () => {
    const pkg = fileURLToPath(new URL('..', import.meta.url));
    for (const bad of [process.cwd(), '.', '/', join(pkg, '..'), join(pkg, '..', '..'), pkg]) {
      await expect(copyTwemoji(bad)).rejects.toThrow(/refusing/);
    }
    expect(existsSync(join(pkg, 'package.json'))).toBe(true);
  });
  it('throws when images.txt lists nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'empty-'));
    try {
      const empty = join(dir, 'images.txt');
      writeFileSync(empty, '\n');
      await expect(copyTwemoji(join(dir, 'out'), empty)).rejects.toThrow(/empty/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
