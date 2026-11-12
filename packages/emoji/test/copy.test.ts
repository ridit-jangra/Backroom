import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script without types
import { copyTwemoji } from '../scripts/copy-twemoji.mjs';

const script = (n: string) => fileURLToPath(new URL(`../scripts/${n}`, import.meta.url));
const generated = fileURLToPath(new URL('../src/generated/data.ts', import.meta.url));

describe('twemoji copy', () => {
  it('copies exactly the needed SVGs within asset limits', async () => {
    const dest = mkdtempSync(join(tmpdir(), 'twemoji-'));
    try {
      const r = await copyTwemoji(dest);
      const files = readdirSync(dest);
      expect(r.count).toBe(3_526);
      expect(files).toHaveLength(3_526);
      expect(r.bytes).toBe(files.reduce((n, f) => n + statSync(join(dest, f)).size, 0));
      for (const f of files) expect(statSync(join(dest, f)).size).toBeLessThanOrEqual(26_214_400);
      expect(existsSync(join(dest, '1f44d.svg'))).toBe(true);
      expect(existsSync(join(dest, '23-20e3.svg'))).toBe(true);
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });
  it('generate.mjs and copy-twemoji.mjs do not depend on the cwd', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cwd-'));
    const dest = join(cwd, 'out');
    try {
      const before = readFileSync(generated, 'utf8');
      execFileSync(process.execPath, [script('generate.mjs')], { cwd });
      expect(readFileSync(generated, 'utf8')).toBe(before);
      execFileSync(process.execPath, [script('copy-twemoji.mjs'), 'out'], { cwd });
      expect(readdirSync(dest)).toHaveLength(3_526);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
