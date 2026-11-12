import { unzipSync } from 'fflate';
import { CUSTOM_EMOJI_MAX_BYTES, EmojiName } from '@backroom/protocol';
import { ApiClientError } from '../api';

export const MAX_ZIP_BYTES = 52_428_800;
export const MAX_ZIP_ENTRIES = 2_000;

export type ZipEntry = {
  fileName: string;
  name: string;
  file?: File;
  error?: 'invalid_name' | 'too_large' | 'unsupported_type' | 'duplicate';
};

export type ImportResult = {
  fileName: string;
  name: string;
  status: 'added' | 'skipped' | 'failed';
  message: string;
};

const MIME: Record<string, string> = { png: 'image/png', gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg' };

/**
 * Reads an emoji archive entirely in the browser. The filter sees each entry's declared sizes
 * before anything is inflated, so an oversized (or exotic-method) entry is never decompressed.
 */
export function readEmojiZip(data: Uint8Array): ZipEntry[] {
  if (data.length > MAX_ZIP_BYTES) throw new Error('zip_too_large');
  const entries: ZipEntry[] = [];
  const byPath = new Map<string, ZipEntry>();
  let seen = 0;

  const files = unzipSync(data, {
    filter(f) {
      if (++seen > MAX_ZIP_ENTRIES) throw new Error('zip_too_large');
      const path = f.name;
      if (path.endsWith('/')) return false;
      const segments = path.split('/');
      const base = segments[segments.length - 1]!;
      if (segments[0] === '__MACOSX' || segments.some((s) => s.startsWith('.'))) return false;
      const dot = base.lastIndexOf('.');
      const ext = dot < 0 ? '' : base.slice(dot + 1).toLowerCase();
      const name = (dot < 0 ? base : base.slice(0, dot)).toLowerCase();
      const entry: ZipEntry = { fileName: base, name };
      entries.push(entry);
      byPath.set(path, entry);
      if (!(ext in MIME)) {
        entry.error = 'unsupported_type';
        return false;
      }
      if (!EmojiName.safeParse(name).success) {
        entry.error = 'invalid_name';
        return false;
      }
      if (f.originalSize > CUSTOM_EMOJI_MAX_BYTES) {
        entry.error = 'too_large';
        return false;
      }
      if (f.compression !== 0 && f.compression !== 8) {
        entry.error = 'unsupported_type';
        return false;
      }
      return true;
    },
  });

  const taken = new Set<string>();
  for (const [path, bytes] of Object.entries(files)) {
    const entry = byPath.get(path);
    if (!entry || entry.error) continue;
    // Re-check the real size: the declared one is attacker-controlled.
    if (bytes.length > CUSTOM_EMOJI_MAX_BYTES) {
      entry.error = 'too_large';
      continue;
    }
    if (taken.has(entry.name)) {
      entry.error = 'duplicate';
      continue;
    }
    taken.add(entry.name);
    const ext = entry.fileName.slice(entry.fileName.lastIndexOf('.') + 1).toLowerCase();
    entry.file = new File([bytes as BlobPart], entry.fileName, { type: MIME[ext]! });
  }
  return entries;
}

const ENTRY_MESSAGES = {
  invalid_name: 'Name must be lowercase letters, numbers, - or _ (max 32)',
  too_large: 'Larger than 128 KB',
  unsupported_type: 'Not a PNG, GIF or JPEG',
  duplicate: 'Duplicate name in archive',
} as const;

export async function importEmoji(
  entries: ZipEntry[],
  upload: (name: string, file: File) => Promise<void>,
  onResult: (r: ImportResult) => void,
  concurrency = 3,
): Promise<void> {
  let next = 0;
  async function worker() {
    while (next < entries.length) {
      const e = entries[next++]!;
      const base = { fileName: e.fileName, name: e.name };
      if (e.error || !e.file) {
        onResult({ ...base, status: 'skipped', message: ENTRY_MESSAGES[e.error ?? 'unsupported_type'] });
        continue;
      }
      try {
        await upload(e.name, e.file);
        onResult({ ...base, status: 'added', message: 'Added' });
      } catch (err) {
        if (err instanceof ApiClientError && err.status === 409) onResult({ ...base, status: 'skipped', message: 'Already exists' });
        else onResult({ ...base, status: 'failed', message: err instanceof ApiClientError ? err.message : 'Upload failed' });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, entries.length)) }, worker));
}
