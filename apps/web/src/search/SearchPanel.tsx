import { Fragment, useEffect, useRef, useState } from 'react';
import { USER_MENTION_RE, type MemberSummary, type SearchHit, type SearchPage, type SnippetSegment } from '@backroom/protocol';
import { api } from '../api';

/** Replaces whole `<@ID>` tokens; a window that cut a mention in half stays plain text. */
function withMentions(text: string, names: Map<string, string>): string {
  return text.replace(new RegExp(USER_MENTION_RE.source, 'g'), (_m, id: string) => `@${names.get(id) ?? 'Unknown'}`);
}

/** Snippets are structured text, never HTML: hit segments are wrapped in <mark>. */
export function Snippet({ segments, members }: { segments: SnippetSegment[]; members: MemberSummary[] }) {
  const names = new Map(members.map((m) => [m.id, m.displayName]));
  return (
    <span className="snippet">
      {segments.map((s, i) => (
        <Fragment key={i}>{s.hit ? <mark>{withMentions(s.text, names)}</mark> : withMentions(s.text, names)}</Fragment>
      ))}
    </span>
  );
}

export function SearchPanel({
  slug,
  query,
  members,
  onJump,
  onClose,
}: {
  slug: string;
  query: string;
  members: MemberSummary[];
  onJump: (hit: SearchHit) => void | Promise<void>;
  onClose: () => void;
}) {
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [joinError, setJoinError] = useState('');
  const ctl = useRef<AbortController | null>(null);
  const names = new Map(members.map((m) => [m.id, m.displayName]));

  async function load(cursor: string | null) {
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    setLoading(true);
    setError('');
    try {
      const url = `/w/${slug}/search?q=${encodeURIComponent(query)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page = await api<SearchPage>(url, { signal: c.signal });
      if (c.signal.aborted) return;
      setHits((h) => (cursor ? [...h, ...page.results] : page.results));
      setNext(page.nextCursor);
    } catch (e) {
      if (c.signal.aborted) return;
      setError(e instanceof Error ? e.message : 'Search failed.');
    } finally {
      if (!c.signal.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    setHits([]);
    setNext(null);
    setJoinError('');
    void load(null);
    return () => ctl.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function open(hit: SearchHit) {
    setJoinError('');
    if (!hit.channel.isMember && hit.channel.kind === 'public') {
      try {
        await api(`/channels/${encodeURIComponent(hit.channel.id)}/join`, { method: 'POST', body: {} });
      } catch (e) {
        setJoinError(e instanceof Error ? e.message : 'Could not join.');
        return;
      }
    }
    await onJump(hit);
  }

  return (
    <aside className="search-panel" aria-label="Search results">
      <header>
        <strong>Results</strong>
        <button type="button" onClick={onClose}>
          Close search
        </button>
      </header>
      <p className="muted">Filters: in:#channel from:@name has:file before:YYYY-MM-DD after:YYYY-MM-DD</p>
      {error && <p role="alert">{error}</p>}
      {joinError && <p role="alert">{joinError}</p>}
      {loading && hits.length === 0 && !error && <p role="status">Searching…</p>}
      {!loading && !error && hits.length === 0 && <p>No results</p>}
      <ul>
        {hits.map((h) => {
          const label = h.channel.name ? `#${h.channel.name}` : 'Direct message';
          const join = !h.channel.isMember && h.channel.kind === 'public';
          return (
            <li key={h.message.id}>
              <button type="button" className="result" aria-label={join ? `Join ${label} to view` : undefined} onClick={() => void open(h)}>
                {join ? (
                  <strong>{`Join ${label} to view`}</strong>
                ) : (
                  <span className="meta">{label}</span>
                )}
                <span className="meta">
                  {names.get(h.message.userId) ?? 'Unknown'} · {new Date(h.message.createdAt).toLocaleString()}
                </span>
                <Snippet segments={h.snippet} members={members} />
                {(h.message.files ?? []).map((f) => (
                  <span key={f.id} className="meta">
                    {f.name}
                  </span>
                ))}
              </button>
            </li>
          );
        })}
      </ul>
      {next && (
        <button type="button" disabled={loading} onClick={() => void load(next)}>
          Load more
        </button>
      )}
    </aside>
  );
}
