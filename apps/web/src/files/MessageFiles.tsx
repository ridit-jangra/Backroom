import { useImageRetry } from '../components/useImageRetry';
import { fileUrl, isInlineMime, isRasterImage, thumbUrl, type FileInfo } from '@backroom/protocol';

const UNITS = ['KB', 'MB', 'GB'];

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < UNITS.length - 1) {
    v /= 1024;
    u++;
  }
  return v < 10 ? `${v.toFixed(1)} ${UNITS[u]}` : `${Math.round(v)} ${UNITS[u]}`;
}

/** Scales down only, keeping the aspect ratio; null when a side is unknown. */
export function fitBox(w: number | null, h: number | null, box = 360): { width: number; height: number } | null {
  if (!w || !h) return null;
  const s = Math.min(1, box / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

/** P6-R8: a fresh image may still be syncing to this location; retry with backoff, then say it failed. */
function RetryingImage({ f, url }: { f: FileInfo; url: string }) {
  const src = f.hasThumb ? thumbUrl(f.id) : url;
  const { attempt, failed, onError } = useImageRetry(src);
  if (failed) {
    return (
      <span className="file-image-failed muted" dir="auto">
        Couldn’t load {f.name}
      </span>
    );
  }
  return (
    <a href={url} target="_blank" rel="noopener noreferrer">
      <img
        key={attempt}
        className="file-image"
        src={src}
        alt={f.name}
        loading="lazy"
        onError={onError}
        {...(fitBox(f.width, f.height) ?? {})}
      />
    </a>
  );
}

function Entry({ f }: { f: FileInfo }) {
  const url = fileUrl(f.id);
  const download = (
    <a href={url} download={f.name} rel="noopener" aria-label={`Download ${f.name}`}>
      Download
    </a>
  );
  if (isRasterImage(f.mime)) {
    return (
      <div className="file-entry">
        <RetryingImage f={f} url={url} /> {download}
      </div>
    );
  }
  if (isInlineMime(f.mime) && f.mime.startsWith('video/')) {
    return (
      <div className="file-entry">
        <video aria-label={f.name} controls preload="metadata" src={url} /> {download}
      </div>
    );
  }
  if (isInlineMime(f.mime) && f.mime.startsWith('audio/')) {
    return (
      <div className="file-entry">
        <audio aria-label={f.name} controls preload="none" src={url} /> {download}
      </div>
    );
  }
  return (
    <div className="file-card">
      <span className="file-name" dir="auto">{f.name}</span> <span className="muted">{formatBytes(f.size)}</span>{' '}
      {f.mime === 'application/pdf' && (
        <>
          <a href={url} target="_blank" rel="noopener noreferrer">
            Open
          </a>{' '}
        </>
      )}
      {download}
    </div>
  );
}

export function MessageFiles({ files }: { files: FileInfo[] }) {
  return (
    <div className="msg-files">
      {files.map((f) => (
        <Entry key={f.id} f={f} />
      ))}
    </div>
  );
}
