import { useCallback, useEffect, useRef, useState } from 'react';
import { FILE_MAX_BYTES, MAX_FILES_PER_MESSAGE, type FileInfo } from '@backroom/protocol';
import { makeThumbnail, uploadFile, uploadThumbnail } from './upload';

export type UploadItem = {
  key: string;
  file: File;
  status: 'uploading' | 'done' | 'failed';
  loaded: number;
  info?: FileInfo;
  error?: string;
};

export type UploadDeps = { upload?: typeof uploadFile; thumb?: typeof makeThumbnail; putThumb?: typeof uploadThumbnail };

export function useUploads(slug: string, deps: UploadDeps = {}) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const aborts = useRef(new Map<string, AbortController>());
  const itemsRef = useRef<UploadItem[]>([]);
  const seq = useRef(0);
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const live = useRef(true);

  const set = (next: UploadItem[]) => {
    itemsRef.current = next;
    setItems(next);
  };
  const patch = (key: string, p: Partial<UploadItem>) => {
    if (!live.current) return;
    set(itemsRef.current.map((i) => (i.key === key ? { ...i, ...p } : i)));
  };

  useEffect(() => {
    live.current = true;
    const map = aborts.current;
    return () => {
      live.current = false;
      for (const c of map.values()) c.abort();
      map.clear();
    };
  }, []);

  const start = useCallback(
    (key: string, file: File) => {
      const d = depsRef.current;
      const ctl = new AbortController();
      aborts.current.set(key, ctl);
      void (async () => {
        try {
          let info = await (d.upload ?? uploadFile)(slug, file, {
            signal: ctl.signal,
            onProgress: (loaded) => patch(key, { loaded }),
          });
          try {
            const blob = await (d.thumb ?? makeThumbnail)(file);
            if (blob && !ctl.signal.aborted) info = await (d.putThumb ?? uploadThumbnail)(info.id, blob);
          } catch {
            /* a missing thumbnail never fails the upload */
          }
          if (ctl.signal.aborted) return;
          patch(key, { status: 'done', loaded: file.size, info, error: undefined });
        } catch (e) {
          if (ctl.signal.aborted || (e as { name?: string })?.name === 'AbortError') return;
          patch(key, { status: 'failed', error: e instanceof Error ? e.message : 'Upload failed' });
        } finally {
          if (aborts.current.get(key) === ctl) aborts.current.delete(key);
        }
      })();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slug],
  );

  const add = useCallback(
    (files: File[]) => {
      const msgs: string[] = [];
      const accepted: UploadItem[] = [];
      let count = itemsRef.current.length;
      for (const file of files) {
        if (file.size > FILE_MAX_BYTES) {
          msgs.push(`"${file.name}" is larger than 25 MB.`);
        } else if (count >= MAX_FILES_PER_MESSAGE) {
          if (!msgs.includes('You can attach up to 10 files.')) msgs.push('You can attach up to 10 files.');
        } else {
          count++;
          accepted.push({ key: `u${++seq.current}`, file, status: 'uploading', loaded: 0 });
        }
      }
      setNotice(msgs.length ? msgs.join(' ') : null);
      if (accepted.length === 0) return;
      set([...itemsRef.current, ...accepted]);
      for (const it of accepted) start(it.key, it.file);
    },
    [start],
  );

  const remove = useCallback((key: string) => {
    aborts.current.get(key)?.abort();
    aborts.current.delete(key);
    set(itemsRef.current.filter((i) => i.key !== key));
    setNotice(null);
  }, []);

  const retry = useCallback(
    (key: string) => {
      const it = itemsRef.current.find((i) => i.key === key);
      if (!it || it.status !== 'failed') return;
      patch(key, { status: 'uploading', loaded: 0, error: undefined });
      start(key, it.file);
    },
    [start],
  );

  const clear = useCallback(() => {
    for (const c of aborts.current.values()) c.abort();
    aborts.current.clear();
    set([]);
    setNotice(null);
  }, []);

  const ready = items.flatMap((i) => (i.status === 'done' && i.info ? [i.info] : []));
  const busy = items.some((i) => i.status !== 'done');
  /** True (with a visible reason) when Enter must not send yet. */
  const blocked = useCallback((): boolean => {
    const cur = itemsRef.current;
    if (cur.some((i) => i.status === 'failed')) {
      setNotice('Remove or retry failed attachments to send.');
      return true;
    }
    if (cur.some((i) => i.status !== 'done')) {
      setNotice('Wait for uploads to finish.');
      return true;
    }
    return false;
  }, []);
  return { items, notice, add, remove, retry, clear, ready, busy, blocked };
}
