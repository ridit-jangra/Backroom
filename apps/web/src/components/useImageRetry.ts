import { useCallback, useEffect, useRef, useState } from 'react';

/** P6-R8: delays before each retry of an image that failed (a fresh blob can take up to ~60 s to reach a location). */
export const IMAGE_RETRY_DELAYS_MS = [2000, 4000, 8000, 16000, 30000] as const;

export type ImageRetry = {
  /** Changes on every retry: use it as the <img> key so a fresh element requests the same, stable URL again. */
  attempt: number;
  /** True between a failure and the next retry. */
  waiting: boolean;
  /** True once every retry failed. */
  failed: boolean;
  onError: () => void;
};

/**
 * Retries a failed image with backoff, keeping the URL stable (the server answers a syncing blob with a no-store
 * 503, so the browser does not keep the failure). State resets when `src` changes; `retry: false` fails at once.
 */
export function useImageRetry(src: string, retry = true): ImageRetry {
  const [state, setState] = useState({ src, attempt: 0, waiting: false, failed: false });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = state.src === src ? state : { src, attempt: 0, waiting: false, failed: false };

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [src],
  );

  const latest = useRef(current);
  latest.current = current;

  const onError = useCallback(() => {
    const s = latest.current;
    if (s.src !== src || s.waiting || s.failed) return;
    const delay = retry ? IMAGE_RETRY_DELAYS_MS[s.attempt] : undefined;
    if (delay === undefined) {
      setState({ ...s, failed: true });
      return;
    }
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      setState((p) => (p.src === src ? { ...p, attempt: p.attempt + 1, waiting: false } : p));
    }, delay);
    setState({ ...s, waiting: true });
  }, [src, retry]);

  return { attempt: current.attempt, waiting: current.waiting, failed: current.failed, onError };
}
