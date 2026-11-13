import { Hono } from 'hono';
import { SEARCH_MAX_OFFSET, SEARCH_PAGE_SIZE, SearchParams, parseSearchQuery, type SearchPage } from '@backroom/protocol';
import type { AppEnv } from '../app';
import { ApiError } from '../lib/errors';
import { requireSession } from '../middleware/session';
import { requireMember } from '../workspace/access';
import { decodeCursor, encodeCursor, searchMessages } from './search';

export const searchRoutes = new Hono<AppEnv>();

searchRoutes.get('/w/:slug/search', requireSession, async (c) => {
  const userId = c.var.session!.userId;
  const { workspaceId } = await requireMember(c.env.DB, c.req.param('slug'), userId);
  const params = SearchParams.parse(c.req.query());
  const parsed = parseSearchQuery(params.q);
  if (!parsed.ok) throw new ApiError(400, parsed.code === 'empty' ? 'invalid_query' : parsed.code, parsed.message);
  let offset = 0;
  let now = c.var.deps.now();
  if (params.cursor !== undefined) {
    const cur = decodeCursor(params.cursor);
    if (!cur) throw new ApiError(400, 'invalid_cursor', 'That page link is no longer valid.');
    offset = cur.o;
    now = cur.t;
  }
  const { hits, hasMore } = await searchMessages(c.env.DB, { workspaceId, userId, query: parsed.query, offset, now });
  const next = offset + SEARCH_PAGE_SIZE;
  const page: SearchPage = { results: hits, nextCursor: hasMore && next <= SEARCH_MAX_OFFSET ? encodeCursor(next, now) : null };
  // P4-R24: the parser kept the first SEARCH_MAX_TERMS terms; tell the client which ones it dropped.
  if (parsed.query.ignoredTerms !== undefined) page.ignoredTerms = parsed.query.ignoredTerms;
  return c.json(page);
});
