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
  const [joined, setJoined] = useState<Set<string>>(new Set());
  const ctl = useRef<AbortController | null>(null);
  const joining = useRef(new Set<string>());
  const panelRef = useRef<HTMLElement | null>(null);
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
      setHits((h) => {
        if (!cursor) return page.results;
        const seen = new Set(h.map((x) => x.message.id));
        return [...h, ...page.results.filter((x) => !seen.has(x.message.id))];
      });
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
    panelRef.current?.focus();
  }, []);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape' && !e.defaultPrevented) onClose();
  }

  async function open(hit: SearchHit) {
    setJoinError('');
    if (!hit.channel.isMember && hit.channel.kind === 'public' && !joined.has(hit.channel.id)) {
      if (joining.current.has(hit.channel.id)) return;
      joining.current.add(hit.channel.id);
      try {
        await api(`/channels/${encodeURIComponent(hit.channel.id)}/join`, { method: 'POST', body: {} });
        setJoined((j) => new Set(j).add(hit.channel.id));
      } catch (e) {
        setJoinError(e instanceof Error ? e.message : 'Could not join.');
        return;
      } finally {
        joining.current.delete(hit.channel.id);
      }
    }
    try {
      await onJump(hit);
    } catch (e) {
      setJoinError(e instanceof Error ? e.message : 'Could not open that message.');
    }
  }

  return (
    <aside className="search-panel" aria-label="Search results" tabIndex={-1} ref={panelRef} onKeyDown={onKeyDown} aria-busy={loading}>
      <header>
        <strong>Results for {query}</strong>
        <button type="button" onClick={onClose}>
          Close search
        </button>
      </header>
      <p className="muted">Filters: in:#channel from:@name has:file before:YYYY-MM-DD after:YYYY-MM-DD</p>
      {(error || joinError) && <p role="alert">{error || joinError}</p>}
      {loading && hits.length === 0 && !error && <p role="status">Searching…</p>}
      {!loading && !error && hits.length === 0 && <p>No results</p>}
      <ul>
        {hits.map((h) => {
          const label = h.channel.name ? `#${h.channel.name}` : 'Direct message';
          const join = !h.channel.isMember && h.channel.kind === 'public' && !joined.has(h.channel.id);
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
