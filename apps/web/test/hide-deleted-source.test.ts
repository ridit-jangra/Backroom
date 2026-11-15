import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe('no deleted-message placeholder', () => {
  it('the placeholder text appears nowhere under apps/web/src', () => {
    const hits = files(join(__dirname, '..', 'src')).filter((f) => /this message was deleted/i.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });
});
