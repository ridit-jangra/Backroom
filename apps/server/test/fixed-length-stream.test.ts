import { describe, expect, it } from 'vitest';
import { FixedLengthStream, installFixedLengthStream } from '../src/platform/fixed-length-stream';
import { bytes, chunked, failingAfter, read } from './helpers';

/** The same test files/store.ts uses to classify a body of the wrong length (`isLengthMismatch`). */
const isLengthMismatch = (e: unknown): boolean => e instanceof TypeError && /FixedLengthStream/.test(e.message);

async function through(parts: Uint8Array[], length: number): Promise<Uint8Array> {
  const fixed = new FixedLengthStream(length);
  const piped = chunked(parts).pipeTo(fixed.writable).catch(() => {});
  try {
    return await read(fixed.readable);
  } finally {
    await piped;
  }
}

describe('FixedLengthStream polyfill', () => {
  it('passes exactly `length` bytes through unchanged, across chunks', async () => {
    const data = bytes(1000);
    const out = await through([data.subarray(0, 1), data.subarray(1, 600), data.subarray(600)], 1000);
    expect(out).toEqual(data);
  });

  it('accepts a zero-length body', async () => {
    expect((await through([], 0)).byteLength).toBe(0);
  });

  it('errors the readable with a length-mismatch TypeError when the body is too short', async () => {
    const err = await through([bytes(10)], 11).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isLengthMismatch(err)).toBe(true);
  });

  it('errors with a length-mismatch TypeError as soon as the body is too long', async () => {
    const fixed = new FixedLengthStream(10);
    const writer = fixed.writable.getWriter();
    const reader = fixed.readable.getReader();
    const first = reader.read();
    await writer.write(bytes(4));
    expect((await first).value?.byteLength).toBe(4);
    const over = writer.write(bytes(7)).then(
      () => null,
      (e: unknown) => e,
    );
    const readErr = await reader.read().then(
      () => null,
      (e: unknown) => e,
    );
    expect(isLengthMismatch(readErr)).toBe(true);
    expect(isLengthMismatch(await over)).toBe(true);
  });

  it('rejects chunks that are not byte data', async () => {
    const fixed = new FixedLengthStream(3);
    const writer = fixed.writable.getWriter();
    const out = read(fixed.readable).catch(() => {}); // a reader, so the write is not held by backpressure
    const r = writer.write('abc' as unknown as Uint8Array).then(
      () => null,
      (e: unknown) => e,
    );
    expect(await r).toBeInstanceOf(TypeError);
    await out;
  });

  it('accepts ArrayBuffer and other views', async () => {
    const fixed = new FixedLengthStream(6);
    const writer = fixed.writable.getWriter();
    const out = read(fixed.readable);
    await writer.write(new Uint8Array([1, 2]).buffer as unknown as Uint8Array);
    await writer.write(new DataView(new Uint8Array([3, 4, 5, 6]).buffer) as unknown as Uint8Array);
    await writer.close();
    expect(await out).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
  });

  it('propagates an abort of the source (a client that disconnects) to the readable', async () => {
    const fixed = new FixedLengthStream(100);
    const piped = failingAfter(bytes(10)).pipeTo(fixed.writable).then(
      () => null,
      (e: unknown) => e,
    );
    const err = await read(fixed.readable).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(isLengthMismatch(err)).toBe(false);
    expect(await piped).toBeInstanceOf(Error);
  });

  it('propagates an explicit writer.abort()', async () => {
    const fixed = new FixedLengthStream(5);
    const writer = fixed.writable.getWriter();
    const out = read(fixed.readable).then(
      () => null,
      (e: unknown) => e,
    );
    await writer.abort(new Error('stop'));
    expect(await out).toBeInstanceOf(Error);
  });

  it('validates the length like workerd (non-negative safe integer)', () => {
    expect(() => new FixedLengthStream(-1)).toThrow(TypeError);
    expect(() => new FixedLengthStream(1.5)).toThrow(TypeError);
    expect(() => new FixedLengthStream(Number.NaN)).toThrow(TypeError);
  });

  it('installFixedLengthStream defines the global once and never replaces a native one', () => {
    const g = globalThis as { FixedLengthStream?: unknown };
    const before = g.FixedLengthStream;
    try {
      delete g.FixedLengthStream;
      installFixedLengthStream();
      expect(g.FixedLengthStream).toBe(FixedLengthStream);
      const native = class {};
      g.FixedLengthStream = native;
      installFixedLengthStream();
      expect(g.FixedLengthStream).toBe(native);
    } finally {
      if (before === undefined) delete g.FixedLengthStream;
      else g.FixedLengthStream = before;
    }
  });
});
