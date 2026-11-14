/**
 * Node stand-in for workerd's `FixedLengthStream` (files/store.ts `putExact`, files/routes.ts ranged reads).
 *
 * An identity `TransformStream` that counts bytes and errors when the body is longer or shorter than the length
 * given to the constructor. The errors are `TypeError`s whose message names FixedLengthStream, with workerd's
 * wording, so `isLengthMismatch` in files/store.ts classifies them exactly as on Workers. An abort of the
 * writable side (a source stream that fails, e.g. a client disconnecting) errors the readable with that
 * reason, which is not a length mismatch.
 */
export class FixedLengthStream extends TransformStream<BufferSource, Uint8Array> {
  constructor(expectedLength: number | bigint) {
    const length = typeof expectedLength === 'bigint' ? Number(expectedLength) : expectedLength;
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new TypeError('FixedLengthStream requires a non-negative integer length.');
    }
    let seen = 0;
    super({
      transform(chunk, controller) {
        const bytes = toBytes(chunk);
        seen += bytes.byteLength;
        if (seen > length) {
          const err = new TypeError('Attempt to write too many bytes through a FixedLengthStream.');
          controller.error(err);
          throw err;
        }
        if (bytes.byteLength > 0) controller.enqueue(bytes);
      },
      flush() {
        if (seen !== length) throw new TypeError('FixedLengthStream did not see all expected bytes before close().');
      },
    });
  }
}

function toBytes(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (chunk instanceof ArrayBuffer || chunk instanceof SharedArrayBuffer) return new Uint8Array(chunk);
  throw new TypeError('This TransformStream is being used as a byte stream, but received a value that is not bytes.');
}

/** Defines `globalThis.FixedLengthStream` for the worker code; a native one (workerd) is never replaced. */
export function installFixedLengthStream(): void {
  const g = globalThis as { FixedLengthStream?: unknown };
  if (g.FixedLengthStream === undefined) g.FixedLengthStream = FixedLengthStream;
}
