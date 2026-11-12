import {
  SEARCH_MAX_OFFSET,
  SEARCH_PAGE_SIZE,
  USER_MENTION_RE,
  toFtsMatch,
  type ChannelKind,
  type ParsedSearch,
  type SearchHit,
  type SnippetSegment,
} from '@backroom/protocol';
import { withReactions } from '../emoji/reactions';
import { withFiles } from '../files/attach';
import { VISIBLE_CHANNEL_SQL, canSeeChannel } from '../messaging/read';
import { messageColumns, rowToMessage } from '../messaging/rows';

/** Highlight markers passed to FTS5 `snippet()` (U+E000/U+E001, private use; SQL `char(57344)`/`char(57345)`). */
export const HIT_START = String.fromCharCode(0xe000);
export const HIT_END = String.fromCharCode(0xe001);

const HIT_RE = new RegExp(`${HIT_START}([^${HIT_START}${HIT_END}]*)${HIT_END}`, 'g');

/** Plain-text segments from a marked snippet. Unbalanced or nested markers stay in the text as-is. */
export function splitSnippet(s: string): SnippetSegment[] {
  const out: SnippetSegment[] = [];
  const push = (text: string, hit: boolean) => {
    if (text === '') return;
    const last = out[out.length - 1];
    if (last && last.hit === hit && !hit) last.text += text;
    else out.push({ text, hit });
  };
  let at = 0;
  for (const m of s.matchAll(HIT_RE)) {
    push(s.slice(at, m.index), false);
    push(m[1]!, true);
    at = m.index + m[0].length;
  }
  push(s.slice(at), false);
  return out;
}

const FALLBACK_SNIPPET_CHARS = 200;

/** First 200 code points of the body, never cutting a `<@ID>` mention token in half (P4-R17). */
function bodyPreview(body: string): SnippetSegment[] {
  let cut = Array.from(body).slice(0, FALLBACK_SNIPPET_CHARS).join('').length;
  for (const m of body.matchAll(new RegExp(USER_MENTION_RE.source, 'g'))) {
    if (m.index >= cut) break;
    if (m.index + m[0].length > cut) cut = m.index;
  }
  const text = body.slice(0, cut);
  return text === '' ? [] : [{ text, hit: false }];
}

function b64url(s: string): string {
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function encodeCursor(o: number, t: number): string {
  return b64url(JSON.stringify({ o, t }));
}

/** `null` unless the cursor is exactly what `encodeCursor` makes for an on-grid offset and a positive `t`. */
export function decodeCursor(c: string): { o: number; t: number } | null {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(c)) return null;
  let v: unknown;
  try {
    v = JSON.parse(atob(c.replaceAll('-', '+').replaceAll('_', '/')));
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const { o, t } = v as { o?: unknown; t?: unknown };
  if (typeof o !== 'number' || !Number.isInteger(o) || o < 0 || o > SEARCH_MAX_OFFSET || o % SEARCH_PAGE_SIZE !== 0) return null;
  if (typeof t !== 'number' || !Number.isSafeInteger(t) || t <= 0) return null;
  // Canonical form only: no extra keys, padding or alternative encodings.
  return encodeCursor(o, t) === c ? { o, t } : null;
}

const ULID_LOWER_RE = /^[0-9a-z]{26}$/;

export type ResolvedFilters = { channelId?: string; userIds?: string[] };

/** Turns `in:` / `from:` into ids in this workspace; `'none'` when one cannot match anything (empty results). */
export async function resolveFilters(db: D1Database, workspaceId: string, q: ParsedSearch): Promise<ResolvedFilters | 'none'> {
  const out: ResolvedFilters = {};
  if (q.inChannel !== null) {
    // The parser lower-cases `in:`; channel ids are upper-case ULIDs. Only a ULID-shaped value is tried as an id,
    // and an id match beats a name match, so a channel named like another channel's id cannot take over its scope.
    const sql = ULID_LOWER_RE.test(q.inChannel)
      ? 'SELECT id FROM channels WHERE workspace_id = ?1 AND (id = upper(?2) OR name = ?2) ORDER BY id = upper(?2) DESC LIMIT 1'
      : 'SELECT id FROM channels WHERE workspace_id = ?1 AND name = ?2 LIMIT 1';
    const row = await db.prepare(sql).bind(workspaceId, q.inChannel).first<{ id: string }>();
    if (!row) return 'none';
    out.channelId = row.id;
  }
  if (q.from !== null) {
    const { results } = await db
      .prepare(
        `SELECT u.id AS id FROM workspace_members wm JOIN users u ON u.id = wm.user_id
         WHERE wm.workspace_id = ?1 AND wm.deactivated_at IS NULL
           AND (u.id = ?2
             OR lower(replace(u.display_name, ' ', '')) = lower(?2)
             OR lower(substr(u.email, 1, instr(u.email, '@') - 1)) = lower(?2))`,
      )
      .bind(workspaceId, q.from)
      .all<{ id: string }>();
    if (results.length === 0) return 'none';
    out.userIds = results.map((r) => r.id);
  }
  return out;
}

type HitRow = Record<string, unknown> & { mrow: number; channelName: string | null; kind: ChannelKind; isMember: number | null };

/** bm25 is negative-is-better; the bonus (≤ 0.5, halving after 30 days) only reorders near-equal scores. */
const RECENCY_HALF_MS = 2_592_000_000;

/**
 * The page query. Parameters: ?1 FTS match, ?2 workspace, ?3 user, ?4 now, ?5 limit, ?6 offset; `where` holds the
 * filter clauses (?7…). Numbered parameters only: D1 has no named ones (P4-R14).
 *
 * Join order is pinned with CROSS JOIN because D1 has no planner statistics (no ANALYZE). Left to itself SQLite
 * starts from `channels` and walks `idx_messages_channel_seq`, reading every message in the workspace and sorting
 * them in a temp B-tree. Pinned:
 * - filter-only: a backward `messages` rowid scan (rowid = insertion = created_at order, P4-R13a) that stops after
 *   LIMIT + OFFSET matching rows, with one channel lookup per row;
 * - match: each FTS table drives its branch, invisible hits are dropped inside the CTE before ranking, and the
 *   outer query scans `best` first, looking messages and channels up by key.
 * `snippet()` is not computed here; `pageSnippets` runs it for the returned page only.
 */
export function buildSearchSql(hasMatch: boolean, where: string): string {
  const visible = (c: string) => `${c}.workspace_id = ?2 AND m.deleted_at IS NULL AND ${VISIBLE_CHANNEL_SQL(c, '?3')}`;
  const select = `SELECT m.rowid AS mrow, ${messageColumns('m.')}, c.name AS channelName, c.kind AS kind,
      (SELECT 1 FROM channel_members x WHERE x.channel_id = c.id AND x.user_id = ?3) AS isMember`;
  if (!hasMatch) {
    return `${select}
      FROM messages m CROSS JOIN channels c ON c.id = m.channel_id
      WHERE ${visible('c')}${where}
      ORDER BY m.rowid DESC
      LIMIT ?5 OFFSET ?6`;
  }
  return `WITH hits(mrow, score) AS (
      SELECT m.rowid, bm25(messages_fts)
      FROM messages_fts CROSS JOIN messages m ON m.rowid = messages_fts.rowid CROSS JOIN channels c ON c.id = m.channel_id
      WHERE messages_fts MATCH ?1 AND ${visible('c')}
      UNION ALL
      SELECT m.rowid, bm25(files_fts)
      FROM files_fts CROSS JOIN files f ON f.rowid = files_fts.rowid
      CROSS JOIN message_files mf ON mf.file_id = f.id CROSS JOIN messages m ON m.id = mf.message_id
      CROSS JOIN channels c ON c.id = m.channel_id
      WHERE files_fts MATCH ?1 AND f.workspace_id = ?2 AND ${visible('c')}),
    best AS (SELECT mrow, MIN(score) AS score FROM hits GROUP BY mrow)
    ${select}
    FROM best CROSS JOIN messages m ON m.rowid = best.mrow CROSS JOIN channels c ON c.id = m.channel_id
    WHERE ${visible('c')}${where}
    ORDER BY best.score - 0.5 / (1.0 + (?4 - m.created_at) / ${RECENCY_HALF_MS}.0), m.created_at DESC, m.rowid DESC
    LIMIT ?5 OFFSET ?6`;
}

/** Marked `snippet()` text for the page's body hits only (file-name-only hits have none). */
async function pageSnippets(db: D1Database, match: string, rowids: number[]): Promise<Map<number, string>> {
  if (rowids.length === 0) return new Map();
  const { results } = await db
    .prepare(
      `SELECT rowid AS mrow, snippet(messages_fts, 0, char(57344), char(57345), '…', 16) AS snip
       FROM messages_fts WHERE messages_fts MATCH ?1 AND rowid IN (SELECT value FROM json_each(?2))`,
    )
    .bind(match, JSON.stringify(rowids))
    .all<{ mrow: number; snip: string }>();
  return new Map(results.map((r) => [r.mrow, r.snip]));
}

export async function searchMessages(
  db: D1Database,
  input: { workspaceId: string; userId: string; query: ParsedSearch; offset: number; now: number },
): Promise<{ hits: SearchHit[]; hasMore: boolean }> {
  const { query } = input;
  const match = toFtsMatch(query.terms);
  if (match === null && query.terms.length > 0) return { hits: [], hasMore: false };
  const filters = await resolveFilters(db, input.workspaceId, query);
  if (filters === 'none') return { hits: [], hasMore: false };

  const binds: unknown[] = [match, input.workspaceId, input.userId, input.now, SEARCH_PAGE_SIZE + 1, input.offset];
  const param = (v: unknown) => {
    binds.push(v);
    return `?${binds.length}`;
  };
  let where = '';
  if (filters.channelId !== undefined) where += ` AND m.channel_id = ${param(filters.channelId)}`;
  if (filters.userIds !== undefined) where += ` AND m.user_id IN (SELECT value FROM json_each(${param(JSON.stringify(filters.userIds))}))`;
  if (query.hasFile) where += ' AND EXISTS (SELECT 1 FROM message_files z WHERE z.message_id = m.id)';
  if (query.before !== null) where += ` AND m.created_at < ${param(query.before)}`;
  if (query.after !== null) where += ` AND m.created_at >= ${param(query.after)}`;

  const { results } = await db.prepare(buildSearchSql(match !== null, where)).bind(...binds).all<HitRow>();
  const hasMore = results.length > SEARCH_PAGE_SIZE;
  // Defense in depth: every row must pass the same rule as everywhere else (role is active: requireMember ran).
  const rows = results
    .slice(0, SEARCH_PAGE_SIZE)
    .filter((r) => canSeeChannel({ role: 'member', kind: r.kind, isMember: r.isMember }));
  const snips = match === null ? new Map<number, string>() : await pageSnippets(db, match, rows.map((r) => r.mrow));
  const messages = await withFiles(
    db,
    await withReactions(
      db,
      rows.map(({ mrow: _r, channelName: _n, kind: _k, isMember: _i, ...m }) => rowToMessage(m)),
    ),
  );
  const hits = rows.map((r, i): SearchHit => {
    const message = messages[i]!;
    const snip = snips.get(r.mrow);
    return {
      message,
      channel: { id: message.channelId, name: r.channelName, kind: r.kind, isMember: Boolean(r.isMember) },
      snippet: snip !== undefined ? splitSnippet(snip) : bodyPreview(message.body),
    };
  });
  return { hits, hasMore };
}
