import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { ApiClientError } from '../src/api';
import { MAX_ZIP_BYTES, MAX_ZIP_ENTRIES, importEmoji, readEmojiZip, type ImportResult } from '../src/emoji/zipImport';

function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}
const gif = () => strToU8('GIF89a\x20\x00\x20\x00');

function archive() {
  return zipSync({
    '__MACOSX/._a.png': strToU8('junk'),
    'pack/': new Uint8Array(0),
    'pack/Party_Parrot.PNG': png(32, 32),
    'pack/party_parrot.gif': gif(),
    'big.png': [new Uint8Array(5_000_000).map((_, i) => (i * 2654435761) >>> 24), { level: 9 }],
    'notes.txt': strToU8('hello'),
    'bad name.png': png(32, 32),
    'smile.png': png(32, 32),
    'tiny.gif': gif(),
  });
}

describe('zip import', () => {
  it('zip import reports per-file results and skips junk', async () => {
    const entries = readEmojiZip(archive());
    const by = (f: string) => entries.find((e) => e.fileName === f)!;
    expect(entries.map((e) => e.fileName)).not.toContain('._a.png');
    expect(by('Party_Parrot.PNG')).toMatchObject({ name: 'party_parrot' });
    expect(by('Party_Parrot.PNG').file).toBeInstanceOf(File);
    expect(by('Party_Parrot.PNG').file!.type).toBe('image/png');
    expect(by('party_parrot.gif').error).toBe('duplicate');
    expect(by('big.png').error).toBe('too_large');
    expect(by('big.png').file).toBeUndefined();
    expect(by('notes.txt').error).toBe('unsupported_type');
    expect(by('bad name.png').error).toBe('invalid_name');

    const called: string[] = [];
    const results: ImportResult[] = [];
    await importEmoji(
      entries,
      async (name) => {
        called.push(name);
        if (name === 'smile') throw new ApiClientError(409, 'name_taken', 'taken');
        if (name === 'tiny') throw new ApiClientError(400, 'too_small', 'Emoji must be at least 32×32 pixels.');
      },
      (r) => results.push(r),
    );
    expect(called.length).toBe(3);
    const r = (f: string) => results.find((x) => x.fileName === f)!;
    expect(r('Party_Parrot.PNG')).toMatchObject({ status: 'added', message: 'Added' });
    expect(r('smile.png')).toMatchObject({ status: 'skipped', message: 'Already exists' });
    expect(r('tiny.gif')).toMatchObject({ status: 'failed', message: 'Emoji must be at least 32×32 pixels.' });
    expect(r('party_parrot.gif')).toMatchObject({ status: 'skipped', message: 'Duplicate name in archive' });
    expect(r('big.png')).toMatchObject({ status: 'skipped', message: 'Larger than 128 KB' });
    expect(r('notes.txt')).toMatchObject({ status: 'skipped', message: 'Not a PNG, GIF or JPEG' });
    expect(r('bad name.png')).toMatchObject({ status: 'skipped', message: 'Name must be lowercase letters, numbers, - or _ (max 32)' });
    expect(results.length).toBe(entries.length);
  });

  it('rejects archives over 50 MiB or 2,000 entries', () => {
    expect(() => readEmojiZip(new Uint8Array(MAX_ZIP_BYTES + 1))).toThrow('zip_too_large');
    const many: Record<string, Uint8Array> = {};
    for (let i = 0; i <= MAX_ZIP_ENTRIES; i++) many[`e${i}.png`] = png(32, 32);
    expect(() => readEmojiZip(zipSync(many))).toThrow('zip_too_large');
  });

  it('stops at the first 429 or 503 and reports imported and remaining (P6-R10)', async () => {
    for (const [status, code, message] of [
      [429, 'emoji_daily_limit', 'Custom emoji limit reached for today. Try again tomorrow.'],
      [503, 'storage_busy', 'Storage has reached a free-tier limit. Try again later.'],
    ] as const) {
      const entries = Array.from({ length: 20 }, (_, i) => ({ fileName: `e${i}.png`, name: `e${i}`, file: new File([png(32, 32) as BlobPart], `e${i}.png`) }));
      const called: string[] = [];
      const results: ImportResult[] = [];
      const outcome = await importEmoji(
        entries,
        async (name) => {
          called.push(name);
          await new Promise((r) => setTimeout(r, 1));
          if (Number(name.slice(1)) >= 5) throw new ApiClientError(status, code, message);
        },
        (r) => results.push(r),
      );
      // The first refusal stops new uploads; the (at most 2) uploads already in flight finish.
      expect(called.length).toBeLessThanOrEqual(8);
      const added = results.filter((r) => r.status === 'added').length;
      expect(added).toBe(5);
      expect(outcome).toEqual({ stopped: message, imported: 5, remaining: 20 - 5 });
      expect(results.find((r) => r.status === 'failed')).toMatchObject({ message });
    }
  });

  it('a finished import reports no stop', async () => {
    const entries = Array.from({ length: 4 }, (_, i) => ({ fileName: `e${i}.png`, name: `e${i}`, file: new File([png(32, 32) as BlobPart], `e${i}.png`) }));
    expect(await importEmoji(entries, async () => {}, () => undefined)).toEqual({ stopped: null, imported: 4, remaining: 0 });
  });

  it('concurrency never exceeds 3', async () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({ fileName: `e${i}.png`, name: `e${i}`, file: new File([png(32, 32) as BlobPart], `e${i}.png`) }));
    let active = 0;
    let peak = 0;
    await importEmoji(
      entries,
      async () => {
        peak = Math.max(peak, ++active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      },
      () => undefined,
    );
    expect(peak).toBe(3);
  });
});
