import { THUMB_MAX_BYTES, THUMB_MAX_SIDE, isRasterImage, type FileInfo } from '@backroom/protocol';
import { ApiClientError } from '../api';

export type UploadOpts = {
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
  makeXhr?: () => XMLHttpRequest;
};

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

export function uploadFile(slug: string, file: File, opts: UploadOpts = {}): Promise<FileInfo> {
  return new Promise<FileInfo>((resolve, reject) => {
    const { signal } = opts;
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const xhr = opts.makeXhr ? opts.makeXhr() : new XMLHttpRequest();
    const onAbort = () => {
      xhr.abort();
      reject(abortError());
    };
    const done = () => signal?.removeEventListener('abort', onAbort);
    xhr.open('POST', `/w/${slug}/files?name=${encodeURIComponent(file.name)}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => opts.onProgress?.(e.loaded, e.total);
    xhr.onload = () => {
      done();
      let data: unknown = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* empty or non-JSON body */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data as FileInfo);
        return;
      }
      const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
      reject(new ApiClientError(xhr.status, err?.code ?? 'unknown', err?.message ?? 'Upload failed'));
    };
    xhr.onerror = () => {
      done();
      reject(new ApiClientError(0, 'network', 'Upload failed. Check your connection.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    xhr.send(file);
  });
}

export async function uploadThumbnail(fileId: string, blob: Blob): Promise<FileInfo> {
  const res = await fetch(`/files/${fileId}/thumb`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'image/webp' },
    body: blob,
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiClientError(res.status, err?.code ?? 'unknown', err?.message ?? 'Thumbnail failed');
  }
  return data as FileInfo;
}

export type ThumbDeps = {
  decode(file: File): Promise<{ width: number; height: number; source: CanvasImageSource; close(): void }>;
  encode(source: CanvasImageSource, w: number, h: number, quality: number): Promise<Blob | null>;
};

export const defaultThumbDeps: ThumbDeps = {
  async decode(file) {
    const bmp = await createImageBitmap(file);
    return { width: bmp.width, height: bmp.height, source: bmp, close: () => bmp.close() };
  },
  async encode(source, w, h, quality) {
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(source, 0, 0, w, h);
      return canvas.convertToBlob({ type: 'image/webp', quality });
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0, w, h);
    return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
  },
};

export async function makeThumbnail(file: File, deps: ThumbDeps = defaultThumbDeps): Promise<Blob | null> {
  if (!isRasterImage(file.type)) return null;
  let img: Awaited<ReturnType<ThumbDeps['decode']>> | null = null;
  try {
    img = await deps.decode(file);
    const longest = Math.max(img.width, img.height);
    if (longest <= THUMB_MAX_SIDE && file.size <= THUMB_MAX_BYTES) return null;
    const scale = Math.min(1, THUMB_MAX_SIDE / longest);
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    for (const q of [0.8, 0.6]) {
      const blob = await deps.encode(img.source, w, h, q);
      if (!blob || blob.type !== 'image/webp') return null;
      if (blob.size <= THUMB_MAX_BYTES) return blob;
    }
    return null;
  } catch {
    return null;
  } finally {
    try {
      img?.close();
    } catch {
      /* ignore */
    }
  }
}
