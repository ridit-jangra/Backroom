import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { strToU8, zipSync } from 'fflate';
import type { CustomEmoji } from '@backroom/protocol';
import { App } from '../src/App';
import { ME, BOB, id, makeBootstrap } from './harness';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  history.replaceState(null, '', '/');
});

const em = (n: string, o: Partial<CustomEmoji> = {}): CustomEmoji => ({ id: id(`01JE${n}`), name: n, url: `/emoji/${id(`01JE${n}`)}`, aliasFor: null, createdBy: BOB, createdAt: 1, ...o });

type Call = { url: string; method: string; body: unknown };

function open(role: 'member' | 'admin', policy: 'admins' | 'everyone' = 'admins', list: CustomEmoji[] = [em('party'), em('mine', { createdBy: ME })]) {
  const calls: Call[] = [];
  let current = [...list];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
      const method = init?.method ?? 'GET';
      if (method !== 'GET') calls.push({ url, method, body: init?.body });
      const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
      if (url.endsWith('/bootstrap')) return ok(makeBootstrap({ workspace: { id: 'w', slug: 'clubhack', name: 'Club Hack', settings: { customEmojiPolicy: policy } } }, role));
      if (url === '/w/clubhack/emoji' && method === 'GET') return ok({ emoji: current });
      if (url === '/w/clubhack/emoji' && method === 'POST') {
        if (init?.body instanceof FormData) current = [...current, em(String(init.body.get('name')))];
        return ok({ emoji: current[current.length - 1] }, 201);
      }
      if (url.startsWith('/emoji/') && method === 'DELETE') {
        current = current.filter((e) => `/emoji/${e.id}` !== url);
        return ok({ ok: true });
      }
      return ok({ error: { code: 'not_found', message: 'nf' } }, 404);
    }),
  );
  history.replaceState(null, '', '/client/clubhack/emoji');
  render(<App />);
  return calls;
}

const png = () => {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, 32);
  new DataView(b.buffer).setUint32(20, 32);
  return b;
};

describe('Custom emoji page', () => {
  it('admin uploads one emoji', async () => {
    const calls = open('admin');
    await userEvent.type(await screen.findByLabelText('Name', { selector: 'form:nth-of-type(1) input' }), 'partyparrot');
    const file = new File([png() as BlobPart], 'x.png', { type: 'image/png' });
    await userEvent.upload(screen.getByLabelText('Image'), file);
    await userEvent.click(screen.getByRole('button', { name: 'Add emoji' }));
    await screen.findByText(':partyparrot:');
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toBeInstanceOf(FormData);
    const form = post.body as FormData;
    expect(form.get('name')).toBe('partyparrot');
    expect(form.get('image')).toBeInstanceOf(File);
  });

  it('member under admins policy sees the notice, not the forms', async () => {
    open('member', 'admins');
    await screen.findByText('Only admins can add custom emoji in this workspace.');
    expect(screen.queryByLabelText('Image')).toBeNull();
    expect(screen.queryByLabelText('Import zip')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Custom emoji' })).toBeTruthy();
  });

  it('member under everyone policy sees the forms', async () => {
    open('member', 'everyone');
    expect(await screen.findByLabelText('Image')).toBeTruthy();
    expect(screen.getByLabelText('Alias for')).toBeTruthy();
    expect(screen.getByLabelText('Import zip')).toBeTruthy();
    expect(screen.queryByText('Only admins can add custom emoji in this workspace.')).toBeNull();
    // A member may delete only their own emoji.
    const rows = (await screen.findAllByRole('listitem')).filter((li) => li.textContent?.includes('Added by'));
    expect(rows.map((r) => !!within(r).queryByRole('button', { name: 'Delete' }))).toEqual([false, true]);
  });

  it('delete confirms and removes the row', async () => {
    const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    const calls = open('admin');
    const row = (await screen.findByText(':party:')).closest('li')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByText(':party:')).toBeNull());
    expect(confirm).toHaveBeenCalledWith('Delete :party:?');
    expect(calls.find((c) => c.method === 'DELETE')!.url).toBe(`/emoji/${em('party').id}`);
  });

  it('zip import renders the results table and summary', async () => {
    open('admin');
    const zip = zipSync({ 'a.png': png(), 'notes.txt': strToU8('x') });
    const f = new File([zip as BlobPart], 'pack.zip', { type: 'application/zip' });
    (f as unknown as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer = async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer;
    await userEvent.upload(await screen.findByLabelText('Import zip'), f);
    const status = await screen.findByText('1 added, 1 skipped, 0 failed');
    expect(status.getAttribute('role')).toBe('status');
    const table = screen.getByRole('table', { name: 'Import results' });
    expect(within(table).getByText('Added')).toBeTruthy();
    expect(within(table).getByText('Not a PNG, GIF or JPEG')).toBeTruthy();
  });
});
