import { useCallback, useEffect, useState } from 'react';
import { canAddCustomEmoji, type Bootstrap, type CustomEmoji } from '@backroom/protocol';
import { api, apiUpload, ApiClientError } from '../api';
import { EmojiImg } from '../emoji/EmojiImg';
import { importEmoji, readEmojiZip, type ImportOutcome, type ImportResult } from '../emoji/zipImport';

const messageOf = (e: unknown) => (e instanceof ApiClientError ? e.message : 'Something went wrong. Try again.');

export function CustomEmojiPage({ slug }: { slug: string }) {
  const base = `/client/${encodeURIComponent(slug)}`;
  const w = `/w/${encodeURIComponent(slug)}`;
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [emoji, setEmoji] = useState<CustomEmoji[]>([]);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [aliasName, setAliasName] = useState('');
  const [aliasFor, setAliasFor] = useState('');
  const [results, setResults] = useState<ImportResult[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const [formKey, setFormKey] = useState(0);

  const refresh = useCallback(async () => {
    const r = await api<{ emoji: CustomEmoji[] }>(`${w}/emoji`);
    setEmoji(r.emoji);
  }, [w]);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const [b] = await Promise.all([api<Bootstrap>(`${w}/bootstrap`), refresh()]);
      setBoot(b);
    } catch (e) {
      setLoadError(messageOf(e));
    }
  }, [w, refresh]);
  useEffect(() => void load(), [load]);

  const back = (
    <p>
      <a href={base}>Back to chat</a>
    </p>
  );
  if (loadError)
    return (
      <main className="card">
        <p role="alert">{loadError}</p>
        <button type="button" onClick={() => void load()}>Try again</button>
        {back}
      </main>
    );
  if (!boot) return <p role="status" className="card">Loading…</p>;

  const me = boot.me;
  const isAdmin = me.role === 'owner' || me.role === 'admin';
  const canAdd = canAddCustomEmoji(me.role, boot.workspace.settings);
  const nameOf = (id: string | null) => boot.members.find((m) => m.id === id)?.displayName ?? 'a former member';

  async function run(fn: () => Promise<void>) {
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(messageOf(e));
    }
  }

  const uploadOne = async (n: string, f: File) => {
    const form = new FormData();
    form.append('name', n);
    form.append('image', f);
    await apiUpload(`${w}/emoji`, form);
  };

  const add = (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!file) return setError('Choose an image.');
    void run(async () => {
      await uploadOne(name, file);
      setName('');
      setFile(null);
      setFormKey((k) => k + 1);
      await refresh();
    });
  };

  const addAlias = (ev: React.FormEvent) => {
    ev.preventDefault();
    void run(async () => {
      await api(`${w}/emoji`, { body: { name: aliasName, aliasFor: aliasFor.replace(/^:|:$/g, '') } });
      setAliasName('');
      setAliasFor('');
      await refresh();
    });
  };

  const remove = (e: CustomEmoji) => {
    if (!globalThis.confirm(`Delete :${e.name}:?`)) return;
    return run(async () => {
      await api(`/emoji/${e.id}`, { method: 'DELETE' });
      setEmoji((l) => l.filter((x) => x.id !== e.id && x.aliasFor !== e.name));
      await refresh();
    });
  };

  const importZip = async (zip: File | undefined) => {
    if (!zip) return;
    setError('');
    setResults([]);
    setOutcome(null);
    let entries;
    try {
      entries = readEmojiZip(new Uint8Array(await zip.arrayBuffer()));
    } catch (e) {
      setResults(null);
      setError(
        e instanceof Error && e.message === 'zip_too_large'
          ? 'That archive is too large (50 MB or 2,000 files at most).'
          : 'That file could not be read as a zip archive.',
      );
      return;
    }
    setImporting(true);
    try {
      setOutcome(await importEmoji(entries, uploadOne, (r) => setResults((l) => [...(l ?? []), r])));
    } finally {
      setImporting(false);
    }
    try {
      await refresh();
    } catch (e) {
      setError(messageOf(e));
    }
  };

  const count = (s: ImportResult['status']) => results?.filter((r) => r.status === s).length ?? 0;

  return (
    <main className="card admin">
      <h1>Custom emoji</h1>
      {back}
      {error && <p role="alert">{error}</p>}

      {canAdd ? (
        <>
          <h2>Add emoji</h2>
          <form onSubmit={add} key={formKey}>
            <label>
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} />
            </label>
            <label>
              Image
              <input type="file" accept="image/png,image/gif,image/jpeg" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </label>
            <button type="submit">Add emoji</button>
          </form>

          <h2>Add alias</h2>
          <form onSubmit={addAlias}>
            <label>
              Name
              <input value={aliasName} onChange={(e) => setAliasName(e.target.value)} maxLength={32} />
            </label>
            <label>
              Alias for
              <input value={aliasFor} onChange={(e) => setAliasFor(e.target.value)} maxLength={66} />
            </label>
            <button type="submit">Add alias</button>
          </form>

          <h2>Import from zip</h2>
          <label>
            Import zip
            <input type="file" accept=".zip,application/zip" disabled={importing} onChange={(e) => void importZip(e.target.files?.[0])} />
          </label>
          {results && (
            <>
              <p role="status">
                {count('added')} added, {count('skipped')} skipped, {count('failed')} failed
              </p>
              {outcome?.stopped && (
                <p role="alert">
                  {`Import stopped: ${outcome.stopped} ${outcome.imported} imported, ${outcome.remaining} remaining. Import the same zip again later; emoji already added are skipped.`}
                </p>
              )}
              <table aria-label="Import results">
                <thead>
                  <tr><th>File</th><th>Name</th><th>Result</th></tr>
                </thead>
                <tbody>
                  {results.map((r, i) => (
                    <tr key={i}>
                      <td>{r.fileName}</td>
                      <td>{r.name}</td>
                      <td>{r.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      ) : (
        <p>Only admins can add custom emoji in this workspace.</p>
      )}

      <h2>Emoji</h2>
      <ul className="emoji-list">
        {emoji.map((e) => (
          <li key={e.id}>
            {e.aliasFor === null && e.url ? (
              <EmojiImg e={{ src: e.url, alt: `:${e.name}:`, title: `:${e.name}:` }} />
            ) : (
              <span>alias of :{e.aliasFor}:</span>
            )}{' '}
            <code>:{e.name}:</code> <span className="muted">Added by {nameOf(e.createdBy)}</span>
            {(isAdmin || e.createdBy === me.id) && (
              <button type="button" onClick={() => void remove(e)}>Delete</button>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
