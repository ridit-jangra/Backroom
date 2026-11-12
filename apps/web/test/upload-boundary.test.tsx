import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { FileInfo } from '@backroom/protocol';
import { Composer } from '../src/components/Composer';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// The real uploadFile against a fake XHR that answers with the server's real wire shape.
describe('Composer + real uploadFile', () => {
  it('sends the unwrapped file id, not undefined', async () => {
    const info: FileInfo = { id: 'F'.repeat(26), name: 'a.pdf', mime: 'application/pdf', size: 1, width: null, height: null, hasThumb: false };
    class Xhr {
      status = 0;
      responseText = '';
      withCredentials = false;
      upload = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      open() {}
      setRequestHeader() {}
      abort() {}
      send() {
        this.status = 201;
        this.responseText = JSON.stringify({ file: info });
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal('XMLHttpRequest', Xhr);
    const onSubmit = vi.fn();
    render(
      <Composer placeholder="Message" members={[]} onSubmit={onSubmit} uploadSlug="w" />,
    );
    fireEvent.change(screen.getByTestId('file-input'), { target: { files: [new File(['x'], 'a.pdf', { type: 'application/pdf' })] } });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('', [info]);
  });
});
