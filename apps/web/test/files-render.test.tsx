import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { FileInfo } from '@backroom/protocol';
import { FakeWebSocket } from './fakeSocket';
import { GEN, ME, msg, id } from './harness';
import { MessageFiles, fitBox, formatBytes } from '../src/files/MessageFiles';
import { MessageRow } from '../src/components/MessageList';

beforeEach(() => {
  FakeWebSocket.reset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  history.replaceState(null, '', '/');
});

const file = (p: string, o: Partial<FileInfo> = {}): FileInfo => ({
  id: id(p), name: `${p}.bin`, mime: 'application/octet-stream', size: 10, width: null, height: null, hasThumb: false, ...o,
});

describe('MessageFiles', () => {
  it('images use the thumbnail when present, else the original', () => {
    const a = file('01JIMGA', { name: 'a.png', mime: 'image/png', width: 2000, height: 1000, hasThumb: true });
    const b = file('01JIMGB', { name: 'b.png', mime: 'image/png', width: 100, height: 50, hasThumb: false });
    const { container } = render(<MessageFiles files={[a, b]} />);
    const ia = container.querySelector(`img[src="/files/${a.id}/thumb"]`)!;
    expect(ia.getAttribute('alt')).toBe('a.png');
    expect(ia.getAttribute('width')).toBe('360');
    expect(ia.getAttribute('height')).toBe('180');
    expect(ia.closest('a')!.getAttribute('href')).toBe(`/files/${a.id}`);
    const ib = container.querySelector(`img[src="/files/${b.id}"]`)!;
    expect(ib.closest('a')!.getAttribute('href')).toBe(`/files/${b.id}`);
  });

  it('an image that fails (blob still syncing) retries with backoff on the same URL, then shows a failure (P6-R8)', () => {
    vi.useFakeTimers();
    try {
      const f = file('01JIMGR', { name: 'r.png', mime: 'image/png', width: 100, height: 50, hasThumb: true });
      const { container } = render(<MessageFiles files={[f]} />);
      const img = () => container.querySelector('img.file-image');
      let first = img();
      for (const wait of [2000, 4000, 8000, 16000, 30000]) {
        expect(img()!.getAttribute('src')).toBe(`/files/${f.id}/thumb`);
        fireEvent.error(img()!);
        act(() => vi.advanceTimersByTime(wait - 1));
        expect(img()).toBe(first);
        act(() => vi.advanceTimersByTime(1));
        // A fresh element on the same stable URL makes the browser request it again.
        expect(img()).not.toBe(first);
        expect(img()!.getAttribute('src')).toBe(`/files/${f.id}/thumb`);
        first = img();
      }
      fireEvent.error(img()!);
      act(() => vi.advanceTimersByTime(120_000));
      expect(img()).toBeNull();
      expect(container.textContent).toContain('Couldn’t load r.png');
      expect(screen.getByRole('link', { name: 'Download r.png' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('audio and video play inline; other files are cards', () => {
    const v = file('01JVID', { name: 'v.mp4', mime: 'video/mp4' });
    const a = file('01JAUD', { name: 'a.mp3', mime: 'audio/mpeg' });
    const t = file('01JTXT', { name: 't.txt', mime: 'text/plain', size: 1536 });
    const { container } = render(<MessageFiles files={[v, a, t]} />);
    expect(container.querySelector(`video[src="/files/${v.id}"]`)).not.toBeNull();
    expect(container.querySelector(`audio[src="/files/${a.id}"]`)).not.toBeNull();
    expect(container.querySelector('.file-card')!.textContent).toContain('1.5 KB');
    for (const f of [v, a, t]) {
      const link = screen.getByRole('link', { name: `Download ${f.name}` });
      expect(link.hasAttribute('download')).toBe(true);
    }
  });

  it('file names render as text', () => {
    const f = file('01JXSS', { name: '<img src=x onerror=alert(1)>.txt', mime: 'text/plain' });
    const { container } = render(<MessageFiles files={[f]} />);
    expect(container.querySelectorAll('img').length).toBe(0);
    expect(container.textContent).toContain('<img src=x');
  });

  it('formatBytes and fitBox', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(26214400)).toBe('25 MB');
    expect(fitBox(100, 50)).toEqual({ width: 100, height: 50 });
    expect(fitBox(2000, 1000)).toEqual({ width: 360, height: 180 });
    expect(fitBox(null, 5)).toBeNull();
  });
});

describe('file edge cases', () => {
  it('svg renders as a card, not an img', () => {
    const f = file('01JSVG', { name: 'x.svg', mime: 'image/svg+xml' });
    const { container } = render(<MessageFiles files={[f]} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.file-card')).not.toBeNull();
  });
  it('image without dimensions has no width/height', () => {
    const f = file('01JNODIM', { name: 'n.png', mime: 'image/png' });
    const { container } = render(<MessageFiles files={[f]} />);
    const img = container.querySelector('img')!;
    expect(img.hasAttribute('width')).toBe(false);
    expect(img.hasAttribute('height')).toBe(false);
  });
  it('extreme aspect ratios clamp to 1px', () => {
    expect(fitBox(10000, 1)).toEqual({ width: 360, height: 1 });
  });
  it('media get an aria-label', () => {
    const { container } = render(<MessageFiles files={[file('01JV', { name: 'v.mp4', mime: 'video/mp4' })]} />);
    expect(container.querySelector('video')!.getAttribute('aria-label')).toBe('v.mp4');
  });
});

describe('files in the chat', () => {
  it('deleted messages show no files; pending sends show theirs', async () => {
    const f = file('01JHIST', { name: 'hist.txt', mime: 'text/plain' });
    const g = file('01JPEND', { name: 'pend.txt', mime: 'text/plain' });
    const rowProps = {
      members: [], me: ME, myRole: 'member' as const, showHeader: true, connected: true,
      onEdit: () => true, onDelete: () => true,
    };
    const del = render(<ul><MessageRow {...rowProps} message={msg(1, { files: [f], body: '', deletedAt: 1_700_000_100_000 })} /></ul>);
    expect(del.container.querySelector('.msg-files')).toBeNull();
    del.unmount();
    const live = render(<ul><MessageRow {...rowProps} message={msg(2, { files: [f] })} /></ul>);
    expect(live.container.querySelector('.msg-files')).not.toBeNull();
    live.unmount();
    // pending row
    const { PendingRow } = await import('../src/components/MessageList');
    const { container } = render(
      <ul>
        <PendingRow
          p={{ clientId: 'c', channelId: GEN, parentId: null, body: 'x', alsoInChannel: false, files: [g], status: 'sending', attempts: 0, lastSentAt: 0 }}
          members={[]} me={ME} showHeader={false} onRetry={() => undefined} onDiscard={() => undefined}
        />
      </ul>,
    );
    expect(container.querySelector('a[aria-label="Download pend.txt"]')).not.toBeNull();
  });

  it('highlighted row scrolls into view', () => {
    const spy = vi.fn();
    Element.prototype.scrollIntoView = spy;
    const props = {
      message: msg(1), members: [], me: ME, myRole: 'member' as const, showHeader: true, connected: true,
      onEdit: () => true, onDelete: () => true,
    };
    const { rerender } = render(<ul><MessageRow {...props} /></ul>);
    expect(spy).not.toHaveBeenCalled();
    rerender(<ul><MessageRow {...props} highlighted /></ul>);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ block: 'center' });
    expect(document.querySelector('li.highlighted')).not.toBeNull();
    // Same id, bumped nonce: scrolls again and the animation restarts (class removed then re-added).
    const li = document.querySelector('li')!;
    const ops: string[] = [];
    const rm = li.classList.remove.bind(li.classList);
    const add = li.classList.add.bind(li.classList);
    li.classList.remove = (...t: string[]) => { ops.push('rm'); rm(...t); };
    li.classList.add = (...t: string[]) => { ops.push('add'); add(...t); };
    rerender(<ul><MessageRow {...props} highlighted highlightNonce={1} /></ul>);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(ops).toEqual(['rm', 'add']);
  });
});
