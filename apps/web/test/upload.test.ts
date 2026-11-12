import { describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../src/api';
import { makeThumbnail, uploadFile, type ThumbDeps } from '../src/files/upload';

class FakeXhr {
  method = '';
  url = '';
  withCredentials = false;
  headers: Record<string, string> = {};
  body: unknown;
  status = 0;
  responseText = '';
  upload: { onprogress: ((e: { loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  abort = vi.fn();
  open(m: string, u: string) {
    this.method = m;
    this.url = u;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  send(b: unknown) {
    this.body = b;
  }
  respond(status: number, json: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(json);
    this.onload?.();
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ loaded, total });
  }
  fail() {
    this.onerror?.();
  }
}
const mk = () => {
  const x = new FakeXhr();
  return { x, makeXhr: () => x as unknown as XMLHttpRequest };
};
const info = { id: 'F', name: 'a', mime: 'application/pdf', size: 3, width: null, height: null, hasThumb: false };

describe('uploadFile', () => {
  it('posts the raw file with name, type and progress', async () => {
    const { x, makeXhr } = mk();
    const file = new File(['abc'], 'résumé #1.pdf', { type: 'application/pdf' });
    const onProgress = vi.fn();
    const p = uploadFile('clubhack', file, { makeXhr, onProgress });
    expect(x.method).toBe('POST');
    expect(x.url).toBe('/w/clubhack/files?name=r%C3%A9sum%C3%A9%20%231.pdf');
    expect(x.withCredentials).toBe(true);
    expect(x.headers['Content-Type']).toBe('application/pdf');
    expect(x.body).toBe(file);
    x.progress(50, 100);
    expect(onProgress).toHaveBeenCalledWith(50, 100);
    x.respond(201, info);
    await expect(p).resolves.toEqual(info);
  });

  it('errors and aborts', async () => {
    let { x, makeXhr } = mk();
    const f = new File(['a'], 'a.bin', { type: '' });
    let p = uploadFile('w', f, { makeXhr });
    expect(x.headers['Content-Type']).toBe('application/octet-stream');
    x.respond(413, { error: { code: 'quota_exceeded', message: 'M' } });
    const e = await p.catch((err) => err);
    expect(e).toBeInstanceOf(ApiClientError);
    expect([e.status, e.code, e.message]).toEqual([413, 'quota_exceeded', 'M']);

    ({ x, makeXhr } = mk());
    p = uploadFile('w', f, { makeXhr });
    x.fail();
    expect(await p.catch((err) => err)).toMatchObject({ status: 0, code: 'network' });

    ({ x, makeXhr } = mk());
    const ctl = new AbortController();
    p = uploadFile('w', f, { makeXhr, signal: ctl.signal });
    ctl.abort();
    expect(x.abort).toHaveBeenCalled();
    expect(await p.catch((err) => err)).toMatchObject({ name: 'AbortError' });
  });
});

describe('makeThumbnail', () => {
  const setup = (w: number, h: number, blobs: Blob[]) => {
    const close = vi.fn();
    const encode = vi.fn();
    for (const b of blobs) encode.mockResolvedValueOnce(b);
    const deps: ThumbDeps = { decode: async () => ({ width: w, height: h, source: {} as CanvasImageSource, close }), encode };
    return { deps, close, encode };
  };
  const img = (size: number, type = 'image/png') => {
    const f = new File(['x'], 'a.png', { type });
    Object.defineProperty(f, 'size', { value: size });
    return f;
  };
  const webp = (size: number, type = 'image/webp') => new Blob([new Uint8Array(size)], { type });

  it('scales to 720 WebP and skips when not needed', async () => {
    let s = setup(2000, 1000, [webp(10)]);
    const out = await makeThumbnail(img(1000), s.deps);
    expect(out?.type).toBe('image/webp');
    expect(s.encode).toHaveBeenCalledWith(expect.anything(), 720, 360, 0.8);
    expect(s.close).toHaveBeenCalled();

    s = setup(600, 400, []);
    expect(await makeThumbnail(img(100 * 1024), s.deps)).toBeNull();
    expect(s.encode).not.toHaveBeenCalled();
    expect(s.close).toHaveBeenCalled();

    s = setup(600, 400, [webp(10)]);
    expect(await makeThumbnail(img(600 * 1024), s.deps)).not.toBeNull();
    expect(s.encode).toHaveBeenCalledWith(expect.anything(), 600, 400, 0.8);

    s = setup(2000, 1000, [webp(600 * 1024), webp(300 * 1024)]);
    const second = await makeThumbnail(img(1000), s.deps);
    expect(second?.size).toBe(300 * 1024);
    expect(s.encode).toHaveBeenLastCalledWith(expect.anything(), 720, 360, 0.6);

    s = setup(2000, 1000, [webp(10, 'image/png')]);
    expect(await makeThumbnail(img(1000), s.deps)).toBeNull();
    expect(s.close).toHaveBeenCalled();

    s = setup(2000, 1000, [webp(10)]);
    expect(await makeThumbnail(img(1000, 'application/pdf'), s.deps)).toBeNull();
    expect(s.encode).not.toHaveBeenCalled();
  });
});
