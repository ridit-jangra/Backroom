# Backroom Phase 4 (Files & Search) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Members can attach up to 10 files to a message (attach button, paste or drag-and-drop, with progress, cancel and retry), see images inline from browser-made WebP thumbnails, play audio/video, download everything else safely, and full-text search the messages and file names they are allowed to see, with filters, highlighted snippets and jump-to-message.

**Architecture:**
- **Uploads.** An upload is a raw-body `POST /w/:slug/files?name=…`. The Worker streams it straight into R2 at `ws/<workspaceId>/<fileId>` through a native `FixedLengthStream`. It then reads back the first 128 KB with an R2 range get to sniff the type and image size. A conditional `INSERT … WHERE SUM(size) + n <= quota` enforces the workspace quota atomically. No JS touches the payload bytes, which keeps uploads inside the 10 ms CPU limit.
- **Thumbnails.** The browser makes a ≤ 720 px WebP thumbnail and posts it to `/files/:id/thumb`.
- **Attaching.** A send frame's `fileIds` are validated inside the hub's existing per-channel queue. The `message_files` rows go into the same D1 batch as the message. A new unique index makes a file attachable to exactly one message.
- **Wire format.** Message payloads gain an optional `files` array, reusing the Phase 3 "absent = keep" rule.
- **Downloads.** `GET /files/:id` is allowed when the caller could see the referencing (non-deleted) message, which reuses `canSeeChannel`, or when the caller is the uploader of an unattached file. Responses use the emoji serving header set plus a safe `Content-Disposition`, single-range `Range` support and `If-None-Match`.
- **Orphans.** A daily Cron Trigger deletes unattached uploads older than 24 h. It works from D1 rows, never from an R2 listing.
- **Search.** `GET /w/:slug/search` parses the query in `packages/protocol` and escapes every term into an FTS5 phrase. It unions `messages_fts` and `files_fts` hits, ranks by `bm25` plus a small recency bonus, and returns snippet segments (text + hit flag) that the SPA renders as text with `<mark>`.

**Tech Stack:** Node 26, npm workspaces, TypeScript 6.0.3, Hono 4.13.18, zod 4.6.7, Wrangler 4.160.1 (Workers, Durable Objects, D1 + FTS5, R2, **Cron Triggers**), Vitest 4.1.12 + `@cloudflare/vitest-pool-workers` 0.23.0, React 19.3.1, Vite 8.3.8, `@testing-library/react` 16.3.3. **No new npm dependencies.** Thumbnails use `createImageBitmap` + `OffscreenCanvas`/`<canvas>`, and upload progress uses `XMLHttpRequest`.

The following were verified in installed type definitions on 2026-11-12:
- `@cloudflare/workers-types` 5.20261110.1:
  - `R2Bucket.get(key, { range?: R2Range | Headers; onlyIf?: R2Conditional | Headers })`, where `R2Range` is `{offset,length?} | {offset?,length} | {suffix}`;
  - `R2Object.range`, `R2Object.httpEtag`, `R2ObjectBody.bytes()`;
  - `R2Bucket.delete(string[])`;
  - `FixedLengthStream(expectedLength)`;
  - `ExportedHandler.scheduled(controller: ScheduledController, env, ctx)` with `controller.scheduledTime`/`cron`.
- `cloudflare:test` (pool-workers 0.23.0) exports `createScheduledController({ scheduledTime?, cron? })`, `createExecutionContext`, `waitOnExecutionContext`.
- Wrangler's config schema has `"triggers": { "crons": [...] }`.
- Migration `0001_init.sql` already has external-content `messages_fts`/`files_fts` and their insert/delete/`UPDATE OF body|name` triggers. A soft delete (`body = ''`) therefore re-indexes the row as empty, and it can no longer match.

**Spec:** `docs/superpowers/specs/2026-11-11-backroom-design.md`. This plan covers §16 item 4 and draws on:
- §4: `files`, `message_files`, `messages_fts`, `files_fts`
- §5: the send frame's `fileIds`
- §6: the files and search rows
- §8: Files, all of it
- §10: Search, all of it
- §12, §13, §14

Phase 1 rulings R1–R13, Phase 2 rulings P2-R1…R28 and Phase 3 rulings P3-R1…R20 still hold.

Decisions this plan makes where the spec is silent (binding for executors):
1. **Files per message:** at most `MAX_FILES_PER_MESSAGE = 10`. The protocol already capped it at 10. This bounds the validation query, the message payload (≈ 10 × 200 B in catch-up) and the D1 rows written per send (+3 per file).
2. **Deleting a message** unlinks its files: `DELETE FROM message_files` runs in the delete batch. From then on only the uploader can fetch the file, as an "unattached upload", and the next daily cron deletes it from D1 and R2 because its `created_at` is old. The quota is freed then. `message.delete` carries `files: []`.
3. **A file attaches to one message only.** This is enforced by `CREATE UNIQUE INDEX … message_files(file_id)`, so a racing second send fails as a whole.
4. **Blank body:** a send may have a blank body only when `fileIds` is non-empty. Edits still require text.
5. **`:shortcode:` text is searchable as plain words.** FTS5's `unicode61` tokenizer treats `:` as a separator, so `:tada:` is indexed as `tada`, and both `tada` and `:tada:` find it. This costs nothing and matches what the author typed. Custom emoji names behave the same way.
6. **Dates in `before:`/`after:` are UTC days.** `before:D` means `created_at < D 00:00Z`. `after:D` means `created_at ≥ (D+1) 00:00Z`, the same as Slack's "after that day".
7. **Search terms are exact tokens** (no prefix `*`). Free-text terms also match the names of attached files. `has:file` restricts results to messages with files.
8. **Thumbnails do not count toward the quota.** They are ≤ 512 KB each and only made for raster images. The quota is `SUM(files.size)` (§8) and is never an R2 listing.
9. **PDF inline vs `sandbox`:** §8 says both "inline PDF" and "always CSP sandbox". The plan keeps both literally. Some browsers' built-in PDF viewers refuse sandboxed documents, so every file card and preview also has a Download link. The human checks this in a browser (Task 12).
10. **Removing a finished upload from the composer** only drops it from the draft. There is no DELETE endpoint, and the cron reclaims the file.

Out of scope:
- File delete endpoint, image lightbox, video poster thumbnails, server-side image processing.
- Upload/search rate limits and per-socket budgets (Phase 6).
- Per-user time zones in date filters.
- CJK word segmentation (`unicode61` does not segment CJK).
- Desktop: `/files/*` `<img>`/`<video>` requests carry the session cookie only, the same constraint as `/emoji/*`, so Phase 5 must give the Electron window a cookie session or a proxy.

## Global Constraints

- **Carried from Phases 1–3:**
  - IDs are 26-char ULIDs (`/^[0-9A-Z]{26}$/`).
  - Timestamps are INTEGER epoch ms.
  - Every API error body is `{"error":{"code":string,"message":string}}`.
  - Every non-GET request needs `Origin` = `APP_ORIGIN`.
  - Never log message bodies, file names, full emails or tokens.
  - Exact dependency versions only.
  - No FOREIGN KEYs (R1).
  - `compatibility_date` stays `2026-08-22` (R6).
  - `apps/web` never uses `dangerouslySetInnerHTML`.
  - Something the caller may not see is `404 not_found` over REST and `nack not_found` over WS, identical to "does not exist".
  - D1 statements bind ≤ 100 parameters, so ID lists use `json_each(?)` (P2-R20).
- **Wire compatibility:**
  - Only optional fields and new frame types are added. `parseClientFrame` keeps dropping unknown types.
  - `MessageSchema` gains `files?: FileInfo[]`. **Absent means "unknown — keep what you hold"**, `[]` means none, and a deleted message always carries `[]`.
  - A client sends `fileIds` only when it has files.
  - An old tab must parse new payloads, and a new tab old ones (Task 1 tests).
  - An old tab shows a file-only message as an empty body until reload. That is accepted.
- **File limits (protocol constants):**

  | Constant | Value |
  |---|---|
  | `FILE_MAX_BYTES` | `26_214_400` (25 MB) |
  | `FILES_QUOTA_BYTES` | `2_147_483_648` (2 GB per workspace, `SUM(files.size)`) |
  | `THUMB_MAX_BYTES` | `524_288` |
  | `THUMB_MAX_SIDE` | `720` |
  | `MAX_FILES_PER_MESSAGE` | `10` |
  | `FILE_NAME_MAX` | `255` code points |
  | `ORPHAN_TTL_MS` | `86_400_000` |

- **R2 keys:**
  - original `ws/<workspaceId>/<fileId>`
  - thumbnail `ws/<workspaceId>/<fileId>-thumb`
  - custom emoji (Phase 3) `ws/<workspaceId>/emoji/<id>`

  Any code that deletes file objects first checks `FILE_KEY_RE = /^ws\/[0-9A-Z]{26}\/[0-9A-Z]{26}(-thumb)?$/`, which can never match an `emoji/` key. Nothing lists R2 to compute quota or find orphans.
- **Stored MIME (decided at upload by `sniffFile`; the client's word is trusted only for audio/video):**
  - **Sniffed by magic bytes:** `image/png|gif|jpeg|webp` and `application/pdf`.
  - **Taken as declared, if on the whitelist:** `audio/mpeg|mp4|aac|ogg|wav|webm|flac` and `video/mp4|webm|ogg|quicktime`.
  - **Any other declared `image/*` or `application/pdf` without matching magic** becomes `application/octet-stream`.
  - **Anything else** keeps its declared type when it matches `/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/` and is ≤ 100 chars. Otherwise it becomes `application/octet-stream`.
- **File responses (`GET /files/:id`, `/files/:id/thumb`):** the emoji header set, shared from one constant:
  - `X-Content-Type-Options: nosniff`
  - `Content-Security-Policy: default-src 'none'; sandbox`
  - `Cache-Control: private, max-age=31536000, immutable`
  - `ETag`, plus `If-None-Match` ⇒ `304`

  Then:
  - `Content-Disposition: inline` only when `isInlineMime(mime)`: the 4 raster image types, `application/pdf` and the audio/video whitelist. In that case `Content-Type` is the stored MIME.
  - Everything else (HTML, SVG, text, archives…) gets `attachment`, with `Content-Type: application/octet-stream`.
  - The filename is always `filename="<ASCII fallback>"; filename*=UTF-8''<RFC 5987 pct-encoding>`.
  - `Accept-Ranges: bytes` and a single-range `Range` ⇒ `206`. An unsatisfiable range ⇒ `416` with `Content-Range: bytes */<size>`. Multi-range, malformed ranges or `If-Range` ⇒ the full `200`.
- **CPU (§13, 10 ms):**
  - The server never decodes images, never runs a JS transform over upload bytes, and never unzips.
  - The cron run is bounded at 10 batches × 100 files, which is 20 binding calls.
- **D1 budget re-estimate (§13; index entries count as rows written):**

  | Write | Rows written | Breakdown |
  |---|---|---|
  | Text message | ≈ 15 | message row + 5 index entries + FTS ≈ 3 + channel, follow, read rows + mentions |
  | Each attached file | +3 | link row + PK + unique index |
  | Upload | ≈ 8 | row + 2 indexes + FTS ≈ 3 + thumb update |

  That leaves ≈ 6k messages/day of headroom under 100k rows/day. README records this (Task 12).
- **Search:**
  - Query ≤ 256 chars and ≤ 16 terms.
  - Syntax: free text, `"quoted phrases"`, `in:#name`, `from:@name`, `has:file`, `before:YYYY-MM-DD`, `after:YYYY-MM-DD` (filters are case-insensitive; a repeated filter: the last one wins).
  - Every term becomes an FTS5 string `"…"` with internal `"` doubled. Terms without a letter or digit (`/[\p{L}\p{N}]/u`) are dropped.
  - Pages hold 20 results (`SEARCH_PAGE_SIZE`). The cursor is opaque `base64url(JSON {o: offset, t: nowMs})`, and the offset is ≤ 480.
  - Results are only from the caller's workspace, from non-deleted messages in channels where `canSeeChannel` holds: public channels, or channels (including DMs) the caller is a member of.
- **UI:** functional and minimal. Reuse the existing layout and classes, add only the CSS the new elements need, and do not restyle the app (a design phase comes later).
- `run_worker_first` gains `"/files/*"`; `wrangler.jsonc` gains `"triggers": { "crons": ["0 4 * * *"] }`.

## Review Focus

1. **Hostile files:**
   - Input: an HTML or SVG file uploaded as `image/png`, and a name with quotes, CR/LF, a lone surrogate and non-ASCII characters.
   - Expected: it is downloaded as an inert `application/octet-stream` attachment; header injection is impossible; the UTF-8 name survives in `filename*`.
   - Test: Task 5 `hostile types and names are served inert`.
2. **Upload races and partial bodies:**
   - Input: two concurrent uploads that together pass the quota, a body shorter than its `Content-Length`, and a body with no length.
   - Expected: exactly one upload wins; a failed upload leaves no D1 row and no R2 object; nothing is half-stored.
   - Tests: Task 3 `concurrent uploads cannot overshoot the quota; failed uploads leave nothing behind`, and `putExact rejects a short stream and leaves no object`.
3. **FTS syntax typed by a user:**
   - Input: `zebra OR secret`, `NEAR(zebra secret)`, `body:zebra`, `"zebra`, `zeb*`, `-zebra`, `^zebra`, `)(`, `'; DROP TABLE messages; --`, `***`.
   - Expected: never a 500; operators are treated as literal words; `***` returns nothing.
   - Test: Task 7 `FTS syntax in user text is literal and never errors`.
4. **Access changes after the fact:**
   - Input: a message with a file is deleted, or a member leaves a private channel.
   - Expected: download and search stop showing it to others at once; the uploader keeps access to their now-unattached file until the cron deletes it.
   - Tests: Task 5 `access follows message visibility live`; Task 7 `search never returns deleted or invisible messages`.
5. **Composer attachment edge cases:**
   - Input: the user removes a file mid-upload, an upload fails, the user pastes 12 files, drops a 30 MB file, or presses Enter while uploads are pending.
   - Expected: nothing is sent until every kept upload is done; removed uploads are aborted; failures can be retried or removed; the draft text is never lost.
   - Test: Task 9 `cancel, failure and limits never block or corrupt the send`.

---

### Task 1: Protocol — files, search query parsing, `Message.files`, blank-body-with-files

**Files:**
- Create: `packages/protocol/src/files.ts`, `packages/protocol/src/search.ts`
- Modify: `packages/protocol/src/messaging.ts` (`MessageSchema.files`), `packages/protocol/src/ws.ts` (send body rule, `MAX_FILES_PER_MESSAGE`), `packages/protocol/src/index.ts`
- Test: `packages/protocol/test/files.test.ts`, `packages/protocol/test/search.test.ts`, `packages/protocol/test/ws.test.ts`

**Interfaces:**
- Produces (exported from `@backroom/protocol`):
  - `files.ts`. It imports nothing from `messaging.ts`, and `messaging.ts` imports `FileInfoSchema` from it.
    - The constants in the Global Constraints table.
    - `FileInfoSchema = z.object({ id: z.string(), name: z.string(), mime: z.string(), size: z.number().int().min(0), width: z.number().int().nullable(), height: z.number().int().nullable(), hasThumb: z.boolean() })`, `type FileInfo`.
    - `RASTER_MIME = ['image/png','image/gif','image/jpeg','image/webp']`.
    - `AV_MIME`: the 11 whitelisted audio/video types.
    - `isRasterImage(mime: string): boolean`.
    - `isInlineMime(mime: string): boolean` — raster, `application/pdf` or `AV_MIME`.
    - `fileUrl(id: string): string` = `` `/files/${id}` ``; `thumbUrl(id: string): string` = `` `/files/${id}/thumb` ``.
    - `sanitizeFileName(raw: string): string`, in this order:
      1. `toWellFormed()`;
      2. remove U+0000–U+001F and U+007F–U+009F;
      3. replace `/` and `\` with `_`;
      4. trim;
      5. truncate to 255 code points;
      6. an empty result ⇒ `'file'`.
  - `search.ts`:
    - `SEARCH_PAGE_SIZE = 20`, `SEARCH_QUERY_MAX = 256`, `SEARCH_MAX_TERMS = 16`, `SEARCH_MAX_OFFSET = 480`.
    - `type ParsedSearch = { terms: string[]; inChannel: string | null; from: string | null; hasFile: boolean; before: number | null; after: number | null }`. `before`/`after` are epoch-ms bounds per Decision 6.
    - `parseSearchQuery(q: string): { ok: true; query: ParsedSearch } | { ok: false; code: 'empty' | 'too_long' | 'invalid_date'; message: string }`:
      - **Tokens:** split on whitespace; a `"` opens a phrase that runs to the next `"` or to the end. `in:#x`/`in:x` ⇒ `inChannel 'x'` (lower-cased); `from:@x`/`from:x` ⇒ `from 'x'`; `has:file`; `before:`/`after:` with a real calendar date. Anything else is a term, including `has:other`, `foo:bar` and filters with an empty value.
      - **Errors:**

        | Condition | Code | Message |
        |---|---|---|
        | blank, or no terms and no filters | `empty` | "Type something to search." |
        | length > 256 or > 16 terms | `too_long` | "That search is too long." |
        | a bad date | `invalid_date` | "Dates use YYYY-MM-DD." |

    - `toFtsMatch(terms: string[]): string | null` — drops terms without `/[\p{L}\p{N}]/u`, wraps each remaining one as `"` + `term.replaceAll('"','""')` + `"`, and joins them with a space. Returns `null` when none remain.
    - `SnippetSegmentSchema = z.object({ text: z.string(), hit: z.boolean() })`.
    - `SearchHitSchema = z.object({ message: MessageSchema, channel: z.object({ id: z.string(), name: z.string().nullable(), kind: ChannelKindSchema, isMember: z.boolean() }), snippet: z.array(SnippetSegmentSchema) })`.
    - `type SearchHit`; `type SearchPage = { results: SearchHit[]; nextCursor: string | null }`.
    - `SearchParams = z.object({ q: z.string().max(SEARCH_QUERY_MAX), cursor: z.string().max(200).optional() })`.
  - `MessageSchema` gains `files: z.array(FileInfoSchema).optional()`.
  - `ClientFrame` `send`:
    - `body` becomes `z.string().max(MAX_BODY)`;
    - `fileIds: z.array(Id).max(MAX_FILES_PER_MESSAGE).optional()`;
    - `ClientFrame` gets `.superRefine` adding a `custom` issue at path `['body']` when `t === 'send'`, the body is blank, and `fileIds` is absent or empty.
    - `edit` keeps the non-blank `Body`.

- [ ] **Step 1: Write failing tests.** `test/files.test.ts`:
  - `sanitizeFileName strips controls and separators, keeps unicode` — `'a/b\\c\r\n.txt'` ⇒ `'a_b_c.txt'`; `'  '` ⇒ `'file'`; `'\uD800x'` ⇒ `'�x'`; `'é'.repeat(300)` ⇒ 255 code points.
  - `isInlineMime` — true for `image/webp`, `application/pdf`, `video/mp4`; false for `image/svg+xml`, `text/html`, `application/octet-stream`.

  `test/search.test.ts`:
  - `parses filters and phrases` — `'in:#General from:@alice has:file "zebra crossing" before:2026-11-12 after:2026-11-01 x:y'` ⇒

    ```ts
    { terms: ['zebra crossing', 'x:y'], inChannel: 'general', from: 'alice', hasFile: true,
      before: Date.UTC(2026, 10, 12), after: Date.UTC(2026, 10, 2) }
    ```

  - `rejects bad input` — `'   '` ⇒ `empty`; `'before:2026-02-30'` ⇒ `invalid_date`; `'a'.repeat(257)` and 17 terms ⇒ `too_long`; `'has:file'` alone is ok with `terms: []`.
  - `toFtsMatch escapes every term into a phrase` — `['zebra', 'a"b', 'NEAR(x y)', '***']` ⇒ `'"zebra" "a""b" "NEAR(x y)"'`; `['***']` ⇒ `null`.

  Append to `test/ws.test.ts`:

```ts
it('send body may be blank only with files; at most 10 files', () => {
  const base = { t: 'send', clientId: 'c-12345678', channelId: GN };
  expect(parseClientFrame(JSON.stringify({ ...base, body: '', fileIds: [GN] })).ok).toBe(true);
  expect(parseClientFrame(JSON.stringify({ ...base, body: '  ' }))).toEqual({ ok: false, clientId: 'c-12345678', code: 'invalid' });
  expect(parseClientFrame(JSON.stringify({ ...base, body: 'x', fileIds: Array(11).fill(GN) })).ok).toBe(false);
  expect(parseClientFrame(JSON.stringify({ t: 'edit', messageId: GN, body: ' ' })).ok).toBe(false);
});
it('files on messages are optional both ways', () => {
  const old = { id: GN, channelId: GN, seq: 1, userId: GN, parentId: null, body: 'x', alsoInChannel: false,
    createdAt: 1, editedAt: null, deletedAt: null, replyCount: 0, lastReplyAt: null };
  const f = { id: GN, name: 'a.png', mime: 'image/png', size: 3, width: 1, height: 1, hasThumb: false };
  const r = parseHubFrame(JSON.stringify({ t: 'message.new', message: { ...old, files: [f] } }));
  expect(r && r.t === 'message.new' && r.message.files).toEqual([f]);
  expect(parseHubFrame(JSON.stringify({ t: 'message.new', message: old }))).not.toBeNull();
});
```

- [ ] **Step 2: Run** `npm test -w packages/protocol` → FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** `npm test -w packages/protocol && npx tsc -p apps/worker --noEmit && npx tsc -p apps/web --noEmit` → PASS / no errors.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(protocol): file info, search query parsing, optional Message.files"`

### Task 2: Worker — file sniffing, safe headers, range parsing (pure helpers)

**Files:**
- Create:
  - `apps/worker/src/files/sniff.ts`, `apps/worker/src/files/http.ts`
  - `apps/worker/src/lib/media.ts`
  - `apps/worker/src/lib/body.ts` (moves `readCappedBody` out of `emoji/routes.ts` unchanged)
- Modify: `apps/worker/src/emoji/routes.ts` (import `readCappedBody` and `MEDIA_SECURITY_HEADERS`; no behavior change)
- Test: `apps/worker/test/file-sniff.test.ts`, `apps/worker/test/file-http.test.ts`; `test/custom-emoji.test.ts` stays green

**Interfaces:**
- Consumes: `sniffImage` (`emoji/image.ts`); `RASTER_MIME`, `AV_MIME`, `isInlineMime` (Task 1).
- Produces:
  - `lib/media.ts`: `MEDIA_SECURITY_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, max-age=31536000, immutable' } as const`.
  - `lib/body.ts`: `readCappedBody(req: Request, max: number, tooLarge: () => Error): Promise<Uint8Array>`. The error factory becomes a parameter, so emoji keeps its own message.
  - `sniff.ts`:
    - `SNIFF_BYTES = 131_072`.
    - `sniffWebp(b: Uint8Array): { width: number; height: number } | null`. It requires `RIFF` at 0 and `WEBP` at 8, then reads the chunk at 12:
      - `VP8 `: `w = le16(26) & 0x3fff`, `h = le16(28) & 0x3fff`;
      - `VP8L`: `w = 1 + (((b[22] & 0x3f) << 8) | b[21])`, `h = 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6))`;
      - `VP8X`: `w = 1 + le24(24)`, `h = 1 + le24(27)`;
      - a truncated header or anything else ⇒ `null`.
    - `sniffFile(head: Uint8Array, declared: string | null): { mime: string; width: number | null; height: number | null }` — the Global Constraints "Stored MIME" rules in order: `sniffImage` → WebP → `%PDF-` → whitelisted AV (declared, lower-cased, parameters stripped) → a declared `image/*` or `application/pdf` ⇒ octet-stream → a declared type matching the MIME regex → octet-stream.
  - `http.ts`:
    - `contentDisposition(kind: 'inline' | 'attachment', name: string): string` — the ASCII fallback maps every code point outside `' '..'~'`, plus `"` and `\`, to `_`. The extended value is `encodeURIComponent(name)` with `'()*` also percent-encoded (upper-case hex).
    - `fileHeaders(f: { mime: string; name: string }, etag: string): Headers` — `MEDIA_SECURITY_HEADERS` + `ETag` + `Accept-Ranges: bytes` + the inline/attachment `Content-Type`/`Content-Disposition` rule.
    - `parseRange(header: string | null, size: number): { offset: number; length: number } | 'unsatisfiable' | null`:
      - `bytes=a-b` (with `b` clamped to `size - 1`), `bytes=a-`, `bytes=-n`;
      - digits only, ≤ 15 digits;
      - `null` for an absent or malformed header, a `,`, a non-`bytes` unit, or `a > b`;
      - `'unsatisfiable'` when `a ≥ size`, `n = 0`, or `size = 0`.

- [ ] **Step 1: Write failing tests.** `test/file-sniff.test.ts` (fixtures from `helpers.ts`; add `webp(w: number, h: number, size?: number): Uint8Array` building a VP8X header):
  - `sniffs raster, webp and pdf with dimensions` — `png(800,600)` ⇒ `{image/png,800,600}`; `webp(1000,500)` ⇒ `{image/webp,1000,500}`; `%PDF-1.7` ⇒ `{application/pdf,null,null}`.
  - `declared types are trusted only for audio/video` — `<html>` declared `image/png` ⇒ `application/octet-stream`; `video/MP4; codecs=x` ⇒ `video/mp4`; `text/plain` ⇒ `text/plain`; `image/svg+xml` ⇒ `application/octet-stream`; `bad type!` ⇒ `application/octet-stream`; `null` ⇒ `application/octet-stream`.
  - `VP8 and VP8L headers` — hand-built 30-byte headers decode to the expected sizes; a 20-byte `RIFF…WEBP` ⇒ `null`.

  `test/file-http.test.ts`:
  - `content disposition is header-safe and RFC 5987 encoded` — `contentDisposition('attachment', 'résumé "final".svg')` ⇒ `` `attachment; filename="r_sum_ _final_.svg"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22.svg` ``; `'a(1)*.txt'` ⇒ `filename*=UTF-8''a%281%29%2A.txt`.
  - `inline only for the whitelist` — `fileHeaders({mime:'text/html',name:'x.html'},'"e"')` ⇒ `Content-Type: application/octet-stream`, disposition starts with `attachment`; `image/png` ⇒ `image/png` and `inline`; both carry nosniff, CSP, Cache-Control, `Accept-Ranges: bytes`.
  - `parseRange` table (size 1000):

    | Header | Result |
    |---|---|
    | `bytes=0-99` | `{0,100}` |
    | `bytes=900-` | `{900,100}` |
    | `bytes=-10` | `{990,10}` |
    | `bytes=0-5000` | `{0,1000}` |
    | `bytes=1000-` | `'unsatisfiable'` |
    | `bytes=-0` | `'unsatisfiable'` |
    | `bytes=5-2` | `null` |
    | `bytes=0-1,5-6` | `null` |
    | `items=0-1` | `null` |
    | `null` | `null` |

    With size 0, `bytes=0-` ⇒ `'unsatisfiable'`.
- [ ] **Step 2: Run** `npm test -w apps/worker` → FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** `npm test -w apps/worker` → PASS (custom-emoji tests unchanged).
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(worker): file sniffing, safe download headers and range parsing"`

### Task 3: Upload and thumbnail endpoints, migration, R2 streaming with atomic quota

**Files:**
- Create:
  - `apps/worker/migrations/0005_files.sql`
  - `apps/worker/src/files/store.ts`, `apps/worker/src/files/routes.ts`
- Modify:
  - `apps/worker/wrangler.jsonc` (`run_worker_first` + `"/files/*"`)
  - `apps/worker/src/app.ts` (mount `fileRoutes`)
  - `apps/worker/src/lib/errors.ts` (add `411` to the status union)
  - `apps/worker/test/helpers.ts` (`uploadFile`, `insertFile`, `webp`)
- Test: `apps/worker/test/files-upload.test.ts`

**Interfaces:**
- Consumes: Task 1 constants, `sanitizeFileName`, `FileInfo`, `isRasterImage`; Task 2 `sniffFile`, `sniffWebp`, `SNIFF_BYTES`, `readCappedBody`; `requireMember`, `requireSession`, `newId`, `ApiError`.
- Produces:
  - `0005_files.sql`:

    ```sql
    CREATE UNIQUE INDEX idx_message_files_file ON message_files(file_id);
    CREATE INDEX idx_files_ws_created ON files(workspace_id, created_at);
    ```

  - `store.ts`:
    - `fileKey(workspaceId: string, fileId: string): string` = `` `ws/${workspaceId}/${fileId}` ``; `thumbKeyOf(workspaceId, fileId)` = that + `-thumb`.
    - `FILE_KEY_RE` (Global Constraints).
    - `FILE_INFO_COLUMNS` = `id, name, mime, size, width, height, thumb_key IS NOT NULL AS hasThumb`, and `rowToFileInfo(row): FileInfo` (`hasThumb` → boolean).
    - `putExact(bucket: R2Bucket, key: string, body: ReadableStream, length: number): Promise<void>` — `bucket.put(key, body.pipeThrough(new FixedLengthStream(length)))`. On any error it tries `bucket.delete(key)` (errors swallowed) and rethrows.
    - `storeUpload(env: Env, input: { workspaceId: string; userId: string; name: string; declaredType: string | null; length: number; body: ReadableStream; now: number }): Promise<FileInfo>`:
      1. `id = newId(now)`.
      2. `putExact`. A failure ⇒ `400 invalid_request` "The upload did not complete."
      3. `head = (await bucket.get(key, { range: { offset: 0, length: min(length, SNIFF_BYTES) } }))?.bytes()`. When `length === 0`, skip the get.
      4. `sniffFile(head, declaredType)`.
      5. The conditional insert:

         ```sql
         INSERT INTO files (id, workspace_id, uploader_id, r2_key, thumb_key, name, mime, size, width, height, created_at)
         SELECT ?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?8, ?9, ?10
         WHERE (SELECT COALESCE(SUM(size), 0) FROM files WHERE workspace_id = ?2) + ?7 <= 2147483648
         ```

      6. When `meta.changes === 0`: `bucket.delete(key)` (errors logged as `upload_cleanup_failed`), then `413 quota_exceeded`.
  - Routes (`requireSession` on all):
    - `POST /w/:slug/files?name=<encodeURIComponent>` → `201 { file: FileInfo }`. Checks, in order:
      1. `requireMember` ⇒ 404.
      2. `Content-Length` absent or not `/^\d{1,9}$/` ⇒ `411 length_required` "Uploads need a Content-Length."
      3. Length > 26,214,400 ⇒ `413 too_large` "Files must be 25 MB or smaller."
      4. No body (length > 0 with no stream) ⇒ `400 invalid_request`.
      5. `name = sanitizeFileName(query name ?? '')`.
      6. Pre-check `SUM(size) + length > FILES_QUOTA_BYTES` ⇒ `413 quota_exceeded` "This workspace has used its 2 GB of file storage." (fail fast; the insert re-checks).
      7. `storeUpload` with `declaredType` = the request `Content-Type`.

      The route never reads the body itself.
    - `POST /files/:id/thumb` (raw body) → `200 { file: FileInfo }` with `hasThumb: true`:
      1. The row must exist and `uploader_id` must equal the caller, else `404` (same for a bad id).
      2. The file is attached ⇒ `409 already_attached`.
      3. `!isRasterImage(mime)` ⇒ `400 invalid_thumbnail`.
      4. Read the body with `readCappedBody(req, THUMB_MAX_BYTES, () => ApiError(413,'too_large','Thumbnails must be 512 KB or smaller.'))`.
      5. `sniffFile(bytes, null)` must give `image/webp` with both sides in 1…720, else `400 invalid_thumbnail`.
      6. `put(thumbKey)`, then `UPDATE files SET thumb_key = ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM message_files WHERE file_id = ?)`. With 0 changes, delete the thumb object, then `409 already_attached`.
  - `test/helpers.ts`:
    - `uploadFile(app, cookie: string, bytes: Uint8Array, opts?: { name?: string; type?: string; slug?: string; length?: string | null }): Promise<Response>` — sets `Origin`, `Cookie`, `Content-Type` (default `application/octet-stream`) and `Content-Length` (default `String(bytes.length)`; `null` omits it and sends the body as a `ReadableStream`). A Fetch `Request` does not add `Content-Length` to its headers by itself.
    - `insertFile(opts: { uploaderId: string; workspaceId?: string; name?: string; mime?: string; size?: number; createdAt?: number; object?: Uint8Array; thumb?: boolean; r2Key?: string }): Promise<string>` — a raw insert. It puts `object` (and a `webp(10,10)` thumb when `thumb`) into R2 under the real keys. `r2Key` overrides the stored key; it is only for the Task 6 key-guard test.

- [ ] **Step 1: Write failing tests** `test/files-upload.test.ts` (owner, alice, bob via `seedUsers`):
  - `uploads a PNG: streamed to R2, dimensions and type from bytes` — `png(800,600,5_000)` named `cat.png`, declared `application/octet-stream` ⇒ 201 `{ name:'cat.png', mime:'image/png', size:5000, width:800, height:600, hasThumb:false }`; `env.BUCKET.get('ws/01JCLUBHACK0000000000000WS/<id>')` bytes equal the input; one `files` row with `uploader_id = alice`.
  - `non-images keep a safe type; names are sanitized` — `hello` as `text/plain` named `a/b\r\n.txt` ⇒ `mime:'text/plain'`, `name:'a_b.txt'`, `width:null`; a zero-byte file ⇒ 201 `size:0`.
  - `size limits` — exactly 26,214,400 bytes ⇒ 201; `Content-Length: 26214401` (with a 1-byte body) ⇒ 413 `too_large` and no R2 object; `length: null` ⇒ 411 `length_required`.
  - `quota counts files.size, not R2, and excludes emoji` — `insertFile({ size: FILES_QUOTA_BYTES - 10 })` with no object, plus a 1 MB custom emoji object under `emoji/` ⇒ a 10-byte upload is 201; the next 1-byte upload ⇒ 413 `quota_exceeded`.
  - `concurrent uploads cannot overshoot the quota; failed uploads leave nothing behind` (Review Focus 2) — with `insertFile({ size: FILES_QUOTA_BYTES - 1_500_000 })`, `Promise.all` of two 1,000,000-byte uploads ⇒ statuses sorted `[201, 413]`; `files` has 2 rows; `env.BUCKET.list({ prefix: 'ws/01JCLUBHACK0000000000000WS/' })` keys not containing `/emoji/` = exactly the winner's key.
  - `putExact rejects a short stream and leaves no object` — a `ReadableStream` yielding 50 bytes with `length` 100 ⇒ rejects; `env.BUCKET.head(key)` is `null`.
  - `non-members get 404` — another workspace's slug ⇒ 404; no cookie ⇒ 401; a missing `Origin` ⇒ 403.
  - `thumbnail upload` — alice's `png(2000,1000)`:
    - bob posting a thumb ⇒ 404
    - a PNG thumb ⇒ 400 `invalid_thumbnail`
    - `webp(721,300)` ⇒ 400
    - `webp(720,360, 524_289)` ⇒ 413
    - `webp(720,360)` ⇒ 200 `hasThumb:true`, and the R2 key `…/<id>-thumb` exists
    - a thumb for alice's `text/plain` file ⇒ 400 `invalid_thumbnail`
    - after the file is linked through a raw `message_files` insert ⇒ 409 `already_attached`
- [ ] **Step 2: Run** `npm test -w apps/worker` → FAIL.
- [ ] **Step 3: Implement** the migration, `store.ts`, the routes, the `wrangler.jsonc` line and the helpers per Interfaces.
- [ ] **Step 4: Run** `npm test -w apps/worker && npx tsc -p apps/worker --noEmit` → PASS / no errors.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(worker): streamed file uploads to R2 with atomic quota and thumbnails"`

### Task 4: Attaching files to messages — send validation, `files` on every message payload, delete unlinks

**Files:**
- Create: `apps/worker/src/files/attach.ts`
- Modify:
  - `apps/worker/src/messaging/store.ts` (`sendMessage`, `loadContext` selects `workspace_id AS workspaceId`, `loadMessage`, `deleteMessage`)
  - `apps/worker/src/messaging/read.ts` (`listMessages`, `getThread`, `catchUp` chain `withFiles` after `withReactions`)
  - `apps/worker/src/hub/WorkspaceHub.ts` (`frameFor` attaches files; `notify` preview)
- Test: `apps/worker/test/hub-files.test.ts`, `apps/worker/test/history.test.ts`, `apps/worker/test/messaging-store.test.ts`

**Interfaces:**
- Consumes: `FILE_INFO_COLUMNS`, `rowToFileInfo` (Task 3); `FileInfo`, `MAX_FILES_PER_MESSAGE` (Task 1); `budgetCatchup`, `CATCHUP_FRAME_BUDGET` (hub).
- Produces:
  - `attach.ts`:
    - `validateAttachments(db: D1Database, input: { fileIds: string[]; userId: string; workspaceId: string }): Promise<FileInfo[] | null>` — one query over `json_each(?)` selecting the info columns, `uploader_id`, `workspace_id`, and `EXISTS(message_files)` as `attached`.
      - It returns `null` unless:
        - the ids are unique;
        - their count is ≤ 10;
        - every id is found;
        - every file has `uploader_id = userId` and `workspace_id = workspaceId`;
        - no file is attached.
      - Otherwise it returns the infos ordered by `id`.
    - `fileLinkStatements(db: D1Database, messageId: string, fileIds: string[]): D1PreparedStatement[]` — one `INSERT INTO message_files (message_id, file_id) VALUES (?, ?)` per file. The unique index makes a racing double-attach fail the whole batch.
    - `loadFileInfos(db: D1Database, messageIds: string[]): Promise<Map<string, FileInfo[]>>` — one statement: `message_files` joined to `files` over `json_each(?)`, `ORDER BY f.id`. Empty input runs no query.
    - `withFiles(db: D1Database, messages: Message[]): Promise<Message[]>` — sets `files` on every message: `[]` for deleted messages and messages with none.
  - `sendMessage`. The order is: dedupe → context → `body.trim() === '' && fileIds.length === 0` ⇒ `invalid` → `validateAttachments` (`null` ⇒ `invalid`) → batch. The batch appends `fileLinkStatements` after the message insert. The early `if (input.fileIds.length > 0) return invalid` is **removed** (P2 note). The returned `message` has `files` (validated infos; `[]` without files). A duplicate returns `loadMessage` with files.
  - `loadMessage` returns the message via `withFiles`.
  - `deleteMessage`'s batch adds `DELETE FROM message_files WHERE message_id = ?`, and the returned message has `files: []`.
  - Hub:
    - `message.new` and fresh acks carry `files` through the spread of `r.message`.
    - `frameFor` reloads via `withFiles`.
    - `notify`'s `preview` = the body when non-blank, else the attached file names joined by `', '`, truncated to 140 code points.

- [ ] **Step 1: Write failing tests.** `test/hub-files.test.ts` (owner, alice, bob, carol connected; P2-R7 `afterEach`; files uploaded through `uploadFile`):
  - `send with fileIds links files and broadcasts them` — alice uploads `a.png`, `b.txt`; sends `{ body: '', fileIds: [b, a] }`:
    - her ack's `message.files.map(f => f.id)` is `[a, b].sort()`, and `files[0]` deep-equals the upload's `FileInfo`;
    - bob's `message.new` carries the same `files`;
    - `message_files` has 2 rows.
  - `fileIds must be the sender's unattached uploads in this workspace` — each of these nacks `invalid` with the clientId, and `channels.last_seq` for `GENERAL` is unchanged:
    - bob's file;
    - a file already attached;
    - `insertFile({ workspaceId: <other ws>, uploaderId: alice })`;
    - an unknown id;
    - `[a, a]`;
    - a blank body with `fileIds: []`.
  - `resending the same clientId acks once with the same files` — the second ack has equal `files`; `message_files` still has 2 rows; bob gets one `message.new`.
  - `deleting a message unlinks its files` — `message.delete.message.files` is `[]`; `message_files` has 0 rows; the `files` row still exists.
  - `notify preview names the files of a file-only message` — DM alice→bob with `report.pdf` and no text ⇒ bob's `notify.preview === 'report.pdf'`.

  Append to `test/history.test.ts`:
  - `history, thread and catch-up carry files` — `files` is `[infoA]` on the file message and `[]` elsewhere, in all three paths.
  - `catch-up budget counts file metadata` — `budgetCatchup([m], [], bytes(m without files) + 10)` where `m` has 10 files named with 255 chars ⇒ `stale` contains its channel.
- [ ] **Step 2: Run** `npm test -w apps/worker` → FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** `npm test -w apps/worker` → PASS (all Phase 1–3 tests too).
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(worker): attach files to messages; files on message payloads"`

### Task 5: Downloads — visibility, inline/attachment, Range, conditional GET, thumbnails

**Files:**
- Modify: `apps/worker/src/files/routes.ts`, `apps/worker/src/files/store.ts` (imports `canSeeChannel` from `messaging/read.ts` unchanged)
- Test: `apps/worker/test/files-download.test.ts`

**Interfaces:**
- Consumes: `canSeeChannel` (`messaging/read.ts`); `fileHeaders`, `parseRange` (Task 2); `fileKey`/`thumbKeyOf` (Task 3).
- Produces:
  - `loadFileAccess(db: D1Database, fileId: string, userId: string): Promise<{ id: string; r2Key: string; thumbKey: string | null; name: string; mime: string; size: number } | null>`:
    - One query: `files` LEFT JOIN `message_files` → `messages` → `channels`, plus subselects for the caller's `channel_members` row (`isMember`) and active `workspace_members.role` in `f.workspace_id`.
    - It returns the row when `canDownload` holds, else `null`.
  - `canDownload(r: { role: string | null; uploaderId: string; messageId: string | null; deletedAt: number | null; kind: ChannelKind | null; isMember: unknown }, userId: string): boolean` — `role !== null` and either:
    - `messageId === null` ⇒ `uploaderId === userId`;
    - otherwise `deletedAt === null && canSeeChannel({ role, kind: kind!, isMember })`.
  - `GET /files/:id` (`requireSession`):
    1. A bad id or `loadFileAccess` null ⇒ `404 not_found` "File not found."
    2. `range = parseRange(req Range, row.size)`, but `null` when `If-Range` is present.
    3. `'unsatisfiable'` ⇒ `416`, empty body, `Content-Range: bytes */<size>` plus `fileHeaders`.
    4. `obj = bucket.get(r2Key, { onlyIf: If-None-Match ? Headers : undefined, range })`. A thrown conditional falls back to a plain get (P3-R16). A missing object ⇒ 404.
    5. No body ⇒ `304`.
    6. With a range ⇒ `206` with `Content-Range: bytes <o>-<o+len-1>/<size>` and `Content-Length: <len>`; else `200` with `Content-Length: <size>`.

    The headers come from `fileHeaders(row, obj.httpEtag)`.
  - `GET /files/:id/thumb`: the same access check. `thumbKey` null ⇒ 404. The headers are `fileHeaders({ mime: 'image/webp', name: 'thumbnail.webp' }, etag)`, with no Range.

- [ ] **Step 1: Write failing tests** `test/files-download.test.ts` (owner, alice, bob, carol; private channel `P` alice+bob; DM alice+bob; public `GENERAL`; public `#zoo` with alice only, via `insertChannel`; messages sent with `sendMessage` + `fileIds`):
  - `uploader can fetch an unattached file; nobody else can` — alice 200; bob 404; no cookie 401; an unknown id 404.
  - `channel visibility decides access` — a file in public `#zoo` (alice the only member): carol, a workspace member who is not in the channel, gets 200. In `P` and in the DM: bob 200, carol 404. A user deactivated through the admin PATCH ⇒ 404.
  - `access follows message visibility live` (Review Focus 4):
    - bob is removed from `P` via `POST /channels/P/leave` ⇒ 404 for the `P` file;
    - alice deletes her `GENERAL` file message ⇒ bob and carol 404, alice (uploader) 200.
  - `inline vs attachment` — the PNG ⇒ `image/png`, `inline; filename="cat.png"…`; `%PDF-` ⇒ `application/pdf` inline; `video/mp4` ⇒ inline; `text/plain` ⇒ `application/octet-stream`, `attachment`. Every response has `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: private, max-age=31536000, immutable`, `Accept-Ranges: bytes`, `ETag`, `Content-Length`.
  - `hostile types and names are served inert` (Review Focus 1) — `<html><script>alert(1)</script>` uploaded as `image/png` with name `résumé "final"\r\nSet-Cookie: a=b.svg`:
    - the response has `Content-Type: application/octet-stream`;
    - `Content-Disposition` equals `` `attachment; filename="r_sum_ _final_Set-Cookie: a=b.svg"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22Set-Cookie%3A%20a%3Db.svg` ``;
    - no response header value contains `\r` or `\n`;
    - `Set-Cookie` is absent;
    - the body bytes are unchanged.
  - `Range requests` (a 1,000-byte `video/mp4`):
    - `bytes=0-99` ⇒ 206, `Content-Range: bytes 0-99/1000`, `Content-Length: 100`, the body equals bytes 0–99;
    - `bytes=-10` ⇒ the last 10;
    - `bytes=1000-` ⇒ 416 with `Content-Range: bytes */1000`;
    - `bytes=0-1,5-6` ⇒ 200 full;
    - `bytes=0-9` + `If-Range: "x"` ⇒ 200 full.
  - `If-None-Match returns 304 with no body`.
  - `thumbnails share the file's access` — no thumb ⇒ 404; after a thumb upload and attach in `P`: bob 200 `image/webp` inline, carol 404.
  - `a missing R2 object is 404` — `insertFile` with no `object`, attached raw.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** `npm test -w apps/worker` → PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(worker): file downloads with visibility, safe headers and ranges"`

### Task 6: Orphan cleanup Cron Trigger

**Files:**
- Create: `apps/worker/src/files/cleanup.ts`
- Modify: `apps/worker/src/index.ts` (add `scheduled`; the default export `satisfies ExportedHandler<Env>`), `apps/worker/wrangler.jsonc` (`"triggers": { "crons": ["0 4 * * *"] }`)
- Test: `apps/worker/test/files-cleanup.test.ts`

**Interfaces:**
- Consumes: `FILE_KEY_RE` (Task 3); `ORPHAN_TTL_MS` (Task 1).
- Produces:
  - `ORPHAN_BATCH = 100`, `ORPHAN_MAX_BATCHES = 10`.
  - `cleanupOrphans(env: Env, now: number): Promise<{ deleted: number; keysRejected: number }>`. Each batch, until a batch returns fewer than 100 rows or 10 batches have run:

    ```sql
    DELETE FROM files WHERE id IN (
      SELECT f.id FROM files f
      WHERE f.created_at < ?1 AND NOT EXISTS (SELECT 1 FROM message_files mf WHERE mf.file_id = f.id)
      ORDER BY f.created_at LIMIT 100)
    RETURNING r2_key AS key, thumb_key AS thumbKey
    ```

    `?1 = now - ORPHAN_TTL_MS`. D1 goes first, so a racing attach never loses its object. For each batch:
    - Keys failing `FILE_KEY_RE` are not deleted; they are counted and logged once as `{level:'warn',code:'orphan_key_rejected'}`.
    - The others go to one `bucket.delete(keys)`. An error is logged as `orphan_r2_delete_failed` and does not stop the run.
    - The run logs `{level:'info',code:'orphans_cleaned',deleted}`.
  - `index.ts`: `scheduled(controller, env, ctx) { ctx.waitUntil(cleanupOrphans(env, controller.scheduledTime)); }`.

- [ ] **Step 1: Write failing tests** `test/files-cleanup.test.ts` (`T = 1_800_000_000_000`; `insertFile` with objects and thumbs):

  | File | Created | State | Expected after cleanup |
  |---|---|---|---|
  | A | `T - 25h` | unattached, with thumb | D1 row and both R2 objects gone |
  | B | `T - 23h` | unattached | kept |
  | C | `T - 30d` | attached | kept |
  | D | `T - 2h` | attached to a message that `deleteMessage` then deletes | gone after a run at `T + 23h` (its upload is then 25 h old) |
  | E | old | row whose `r2_key` is `ws/01JCLUBHACK0000000000000WS/emoji/<id>` | D1 row gone, R2 object kept, `keysRejected: 1` |

  Also: a custom emoji object under `emoji/` is untouched, and `files_fts` no longer matches A's name.
  - `runs through the scheduled handler` — `import worker from '../src/index'`; `worker.scheduled!(createScheduledController({ scheduledTime: T, cron: '0 4 * * *' }), env, ctx)`; `await waitOnExecutionContext(ctx)` ⇒ A is gone.
  - `batches: 250 orphans in one run; at most 1,000 per run` — 250 rows ⇒ `deleted: 250`; 1,050 rows (no objects) ⇒ `deleted: 1000`, then a second run ⇒ 50.
  - `an R2 failure does not stop the run` — `vi.spyOn(env.BUCKET, 'delete').mockRejectedValueOnce(new Error('x'))` ⇒ it resolves, and the D1 rows are gone.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** `npm test -w apps/worker && npx tsc -p apps/worker --noEmit` → PASS / no errors.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(worker): daily cron deletes orphaned uploads"`

### Task 7: Search API — FTS5 over messages and file names, filters, visibility, cursor paging

**Files:**
- Create: `apps/worker/src/search/search.ts`, `apps/worker/src/search/routes.ts`
- Modify:
  - `apps/worker/src/messaging/rows.ts` (`messageColumns(prefix = '')`; `MESSAGE_COLUMNS = messageColumns()`)
  - `apps/worker/src/messaging/read.ts` (`VISIBLE_CHANNEL_SQL`)
  - `apps/worker/src/app.ts` (mount `searchRoutes`)
- Test: `apps/worker/test/search.test.ts`

**Interfaces:**
- Consumes: `parseSearchQuery`, `toFtsMatch`, `SearchParams`, `SearchPage`, `SnippetSegment`, the `SEARCH_*` constants (Task 1); `withReactions`, `withFiles` (Task 4); `canSeeChannel`, `requireMember`.
- Produces:
  - `read.ts`: `VISIBLE_CHANNEL_SQL(c: string, userParam: string): string` ⇒ `` `(${c}.kind = 'public' OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = ${c}.id AND cm.user_id = ${userParam}))` ``. Its comment states that it mirrors `canSeeChannel` for an active member, who is checked by `requireMember`.
  - `search.ts`:
    - `HIT_START = ''`, `HIT_END = ''`.
    - `splitSnippet(s: string): SnippetSegment[]` — splits on the markers, drops empty segments, and treats unbalanced markers as plain text.
    - `encodeCursor(o: number, t: number): string` / `decodeCursor(c: string): { o: number; t: number } | null` — base64url JSON. `o` must be an integer multiple of 20 in 0–480 and `t` a positive integer.
    - `resolveFilters(db, workspaceId, q: ParsedSearch): Promise<{ channelId?: string; userIds?: string[] } | 'none'>`:
      - `in:` ⇒ a channel in the workspace with `name = ?`, or by id;
      - `from:` ⇒ active members whose user id equals it, whose `lower(replace(display_name,' ',''))` equals it, or whose email local part equals it.
      - Unresolvable ⇒ `'none'`, meaning empty results, not an error.
    - `searchMessages(db: D1Database, input: { workspaceId: string; userId: string; query: ParsedSearch; offset: number; now: number }): Promise<{ hits: SearchHit[]; hasMore: boolean }>`:
      - **With a match** (`toFtsMatch(terms) !== null`):

        ```sql
        WITH hits(mrow, score, snip) AS (
          SELECT m.rowid, bm25(messages_fts), snippet(messages_fts, 0, char(57344), char(57345), '…', 16)
          FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
          WHERE messages_fts MATCH ?match
          UNION ALL
          SELECT m.rowid, bm25(files_fts), NULL
          FROM files_fts JOIN files f ON f.rowid = files_fts.rowid
          JOIN message_files mf ON mf.file_id = f.id JOIN messages m ON m.id = mf.message_id
          WHERE files_fts MATCH ?match AND f.workspace_id = ?ws),
        best AS (SELECT mrow, MIN(score) AS score, MAX(snip) AS snip FROM hits GROUP BY mrow)
        SELECT ${messageColumns('m.')}, best.snip AS snip, c.name AS channelName, c.kind AS kind,
               (SELECT 1 FROM channel_members x WHERE x.channel_id = c.id AND x.user_id = ?user) AS isMember
        FROM best JOIN messages m ON m.rowid = best.mrow JOIN channels c ON c.id = m.channel_id
        WHERE c.workspace_id = ?ws AND m.deleted_at IS NULL AND ${VISIBLE_CHANNEL_SQL('c', '?user')} <filters>
        ORDER BY best.score - 0.5 / (1.0 + (?now - m.created_at) / 2592000000.0), m.created_at DESC
        LIMIT 21 OFFSET ?offset
        ```

      - **Without a match** (filters only, or every term dropped): the same `SELECT` from `messages m JOIN channels c`, ordered by `m.created_at DESC`. When terms were given but all dropped, it returns `{ hits: [], hasMore: false }` instead.
      - `<filters>`: `AND m.channel_id = ?`, `AND m.user_id IN (SELECT value FROM json_each(?))`, `AND EXISTS (SELECT 1 FROM message_files z WHERE z.message_id = m.id)`, `AND m.created_at < ?`, `AND m.created_at >= ?`.
      - Every row is re-checked with `canSeeChannel({ role: 'member', kind, isMember })` and dropped if it fails (defense in depth).
      - `snippet` = `splitSnippet(snip)` when `snip` is non-null, else `[{ text: <first 200 code points of body>, hit: false }]` (`[]` for an empty body).
      - The messages go through `withReactions` then `withFiles`. Each hit's channel is `{ id, name, kind, isMember: Boolean(isMember) }`.
  - `routes.ts`: `GET /w/:slug/search?q=&cursor=` (`requireSession`):
    1. `requireMember` ⇒ 404.
    2. `SearchParams.parse`, where an overlong `q` is a `ZodError` ⇒ 400 `invalid_request`.
    3. `parseSearchQuery` failure ⇒ `400` with its `code` (`invalid_query` for `empty`) and message.
    4. A bad cursor ⇒ `400 invalid_cursor`.
    5. `now = cursor?.t ?? deps.now()`.
    6. Respond `200 SearchPage` with `nextCursor = hasMore && offset + 20 <= 480 ? encodeCursor(offset + 20, now) : null`.

- [ ] **Step 1: Write failing tests** `test/search.test.ts`. Setup: owner, alice, bob, carol; 20 filler messages in `GENERAL` without the search words, so that bm25 IDF is positive; `q(cookie, query, cursor?)` helper.
  - `finds words, highlights them, and renders nothing as HTML` — alice posts `<b>zebra</b> & stripes` ⇒ carol's search `zebra`:
    - 1 result;
    - `snippet` has a segment `{ text: 'zebra', hit: true }`;
    - joining the segments gives text that contains `<b>`;
    - `channel` is `{ id: GENERAL, name: 'general', kind: 'public', isMember: true }`.
  - `search never returns deleted or invisible messages` (Review Focus 4) — `zebra` posted in `GENERAL`, private `P` (alice+bob), the DM alice+bob, public `#zoo` (carol not a member), a deleted message, and another workspace's channel (raw inserts):
    - carol gets `GENERAL` and `#zoo` (`isMember: false`) only;
    - bob gets `GENERAL`, `P`, DM and `#zoo`;
    - after bob leaves `P`, `P` is gone from his results;
    - a deactivated user ⇒ 404.
  - `FTS syntax in user text is literal and never errors` (Review Focus 3):
    - every query in Review Focus 3 ⇒ 200;
    - `zebra OR secret` matches only a message containing all three words (`zebra or secret`), not `zebra secret`;
    - `zeb*` matches nothing;
    - `***` ⇒ `{ results: [], nextCursor: null }`.
  - `:shortcode: text is searchable as words` — `party time :tada:` is found by `tada` and by `:tada:`.
  - `file names match; has:file filters` — alice posts `see attached` with `quarterly-report.pdf`:
    - `quarterly` finds it, and its snippet is `[{ text: 'see attached', hit: false }]`;
    - an unattached `quarterly.txt` upload is not found;
    - `has:file` alone lists file messages newest first;
    - `has:file zebra` excludes non-file zebra messages.
  - `filters` — `in:#general`, `from:@alice` (email local part), and `before:`/`after:` around messages sent with `now` on 2026-11-01 and 2026-11-03: `after:2026-11-01` excludes the 1st; `before:2026-11-03` excludes the 3rd. `in:#nope` ⇒ empty; `before:2026-13-01` ⇒ 400 `invalid_date`.
  - `ranking: bm25 first, recency breaks ties` — `zebra zebra zebra` (10 days old) ranks above `zebra and some other words here today` (now); two identical `zebra crossing` bodies 60 days apart ⇒ the newer first.
  - `cursor paging` — 25 zebra messages:
    - page 1 has 20 and a `nextCursor`;
    - page 2 has 5 and `null`;
    - the ids do not overlap;
    - the union is all 25;
    - a tampered cursor ⇒ 400 `invalid_cursor`.
  - `results carry files and reactions` — the `quarterly` hit's `message.files[0].name === 'quarterly-report.pdf'`, and `reactions` is an array.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** `npm test -w apps/worker && npx tsc -p apps/worker --noEmit` → PASS / no errors.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(worker): message and file-name search with filters and safe snippets"`

### Task 8: Web state — files on messages and sends, jump-to-message

**Files:**
- Modify: `apps/web/src/state/chat.ts`, `apps/web/src/realtime/outbox.ts`, `apps/web/src/realtime/useChat.ts`
- Test: `apps/web/test/chat.test.ts`, `apps/web/test/outbox.test.ts`, `apps/web/test/jump.test.tsx`

**Interfaces:**
- Consumes: `FileInfo`, `Message.files` (Task 1).
- Produces:
  - `chat.ts`:
    - `pick` sets `files = winner.deletedAt !== null ? [] : (incoming.files ?? held.files)`, keeping the object identity when it is unchanged.
    - `ChatState.highlightId: string | null` (`initialChat` ⇒ `null`).
    - Event `{ t: 'local.highlight'; messageId: string | null }` sets it.
    - `local.open` resets it to `null`.
  - `outbox.ts`:
    - `PendingSend` gains `files: FileInfo[]`.
    - `enqueue(p: { channelId; parentId; body; alsoInChannel; files?: FileInfo[] })` defaults `files` to `[]`.
    - The transmitted frame includes `fileIds: files.map(f => f.id)` only when `files.length > 0`.
  - `useChat.ts`:
    - `ChatActions.send(channelId, body, parentId?, alsoInChannel?, files?: FileInfo[])`, passed through to `enqueue`.
    - `open()` stores its `loadLatest` promise in `latestLoads: Map<string, Promise<void>>`.
    - `ChatActions.jumpTo(t: { channelId: string; messageId: string; seq: number; parentId: string | null; alsoInChannel: boolean }): Promise<boolean>`:
      - **A reply** (`parentId !== null && !alsoInChannel`): `openThread(parentId)`, then `local.highlight` with `messageId`. Returns `true`.
      - **Otherwise:**
        1. `await (latestLoads.get(channelId) ?? loadLatest(channelId))`.
        2. While the window has no message with that id, `hasOlder` is set, and fewer than 20 older pages have been loaded: `await loadOlder(channelId)`.
        3. If found, `local.highlight` and `true`; else `false`.
    - Both the `startSession` actions and the `useChat` wrapper expose `jumpTo`.

- [ ] **Step 1: Write failing tests.** `test/chat.test.ts`:
  - `files: ack and message.new carry them; edits without files keep them; deletes clear them` — held `files:[f]`, then an edit frame without `files` ⇒ `[f]`; a delete frame ⇒ `[]`; a replayed non-deleted copy after the delete ⇒ still `[]`.
  - `local.highlight sets and local.open clears highlightId`.

  `test/outbox.test.ts`:
  - `files become fileIds; no files means no fileIds field` — the sent frame `fileIds` is `[f.id]`, and for a text-only send `'fileIds' in frame` is false; a blank body with files is transmitted as `body: ''`.

  `test/jump.test.tsx` (`boot()` harness; `stubApi.pages` serves `GEN` history in pages of 50 with `before=`):
  - `jumpTo loads older pages until the message is present and highlights it` — the target is seq 120 of 300 ⇒ resolves `true` after 3 history requests; `state.highlightId` is the target.
  - `jumpTo a thread reply opens the thread and highlights it` — `GET /messages/<parent>/thread` is requested.
  - `gives up after 20 older pages` ⇒ `false`.
- [ ] **Step 2: Run** `npm test -w apps/web` → FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** `npm test -w apps/web && npx tsc -p apps/web --noEmit` → PASS / no errors.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(web): files on messages and sends; jump to message"`

### Task 9: Upload client, browser thumbnails, composer attachments

**Files:**
- Create: `apps/web/src/files/upload.ts`, `apps/web/src/files/useUploads.ts`
- Modify:
  - `apps/web/src/components/Composer.tsx`, `apps/web/src/components/ThreadPanel.tsx` (`onSend(body, alsoInChannel, files)`, `uploadSlug`)
  - `apps/web/src/pages/Workspace.tsx` (pass `uploadSlug={slug}` and files to `actions.send`)
  - `apps/web/src/styles.css` (`.upload-list` only)
- Test: `apps/web/test/upload.test.ts`, `apps/web/test/composer.test.tsx`

**Interfaces:**
- Consumes: `FILE_MAX_BYTES`, `THUMB_MAX_BYTES`, `THUMB_MAX_SIDE`, `MAX_FILES_PER_MESSAGE`, `isRasterImage`, `FileInfo` (Task 1); `ApiClientError` (`api.ts`); `ChatActions.send` (Task 8).
- Produces:
  - `upload.ts`:
    - `uploadFile(slug: string, file: File, opts?: { onProgress?: (loaded: number, total: number) => void; signal?: AbortSignal; makeXhr?: () => XMLHttpRequest }): Promise<FileInfo>`:
      - XHR `POST /w/${slug}/files?name=${encodeURIComponent(file.name)}`, `withCredentials = true`, `Content-Type` = `file.type || 'application/octet-stream'`, body `file`.
      - `xhr.upload.onprogress` drives `onProgress`.
      - Non-2xx ⇒ `ApiClientError(status, error.code ?? 'unknown', error.message ?? 'Upload failed')`; a network error ⇒ `ApiClientError(0,'network','Upload failed. Check your connection.')`.
      - `signal` aborts the XHR and rejects with `DOMException('Aborted','AbortError')`.
    - `uploadThumbnail(fileId: string, blob: Blob): Promise<FileInfo>` — `fetch` POST `/files/${fileId}/thumb`, `credentials:'include'`, `Content-Type: image/webp`.
    - `type ThumbDeps = { decode(file: File): Promise<{ width: number; height: number; source: CanvasImageSource; close(): void }>; encode(source: CanvasImageSource, w: number, h: number, quality: number): Promise<Blob | null> }`.
    - `defaultThumbDeps`:
      - `decode` = `createImageBitmap(file)`;
      - `encode` = `OffscreenCanvas(w,h)` → `drawImage` → `convertToBlob({ type: 'image/webp', quality })`, falling back to `document.createElement('canvas')` + `toBlob`.
    - `makeThumbnail(file: File, deps = defaultThumbDeps): Promise<Blob | null>`:
      1. `null` unless `isRasterImage(file.type)`.
      2. Decode. Return `null` when `max(w,h) <= 720` **and** `file.size <= THUMB_MAX_BYTES`.
      3. Scale to fit 720 (`Math.round`, min 1).
      4. Encode at quality `0.8`, then `0.6` if over `THUMB_MAX_BYTES`.
      5. `null` when no blob, `blob.type !== 'image/webp'` (no WebP encoder), or still too big.
      6. Always `close()`; any throw ⇒ `null`.
  - `useUploads.ts`:
    - `type UploadItem = { key: string; file: File; status: 'uploading' | 'done' | 'failed'; loaded: number; info?: FileInfo; error?: string }`.
    - `useUploads(slug: string, deps?: { upload?: typeof uploadFile; thumb?: typeof makeThumbnail; putThumb?: typeof uploadThumbnail }): { items: UploadItem[]; notice: string | null; add(files: File[]): void; remove(key: string): void; retry(key: string): void; clear(): void; ready: FileInfo[]; busy: boolean }`.
      - `add` rejects files beyond 10 items in total ("You can attach up to 10 files.") and files over 25 MB (`` `"${name}" is larger than 25 MB.` ``) into `notice`, and starts the rest.
      - After an upload, `thumb` + `putThumb` run. A thumbnail failure is ignored, and `info` comes from the thumb response when it succeeds.
      - `remove` aborts an in-flight upload.
      - `busy` = any item uploading or failed.
      - `ready` = the done infos in item order.
  - `Composer` gains:
    - `uploadSlug?: string`. When set:
      - `<button type="button" aria-label="Attach files">` opens a hidden `<input type="file" multiple data-testid="file-input">`;
      - the textarea `onPaste` with `clipboardData.files` adds them (and `preventDefault`);
      - the form handles `onDragOver` (`preventDefault` when `dataTransfer.types` includes `'Files'`) and `onDrop`.
    - `<ul className="upload-list">` — per item: the name, `<progress aria-label={`Uploading ${name}`} max={size} value={loaded}>` while uploading, the error text and `<button>Retry</button>` when failed, and `<button aria-label={`Remove ${name}`}>`. `notice` goes in `role="alert"`.
    - `onSubmit: (body: string, files: FileInfo[]) => boolean | void`.
    - **Submit:** allowed when `!busy`, not `tooLong`, and (the encoded body is non-blank or `ready.length > 0`). On success it clears the text and calls `clear()`. Enter while busy does nothing and keeps the draft.
    - Edit-mode composers pass no `uploadSlug`.

- [ ] **Step 1: Write failing tests.** `test/upload.test.ts` (a `FakeXhr` class recording `open`/`setRequestHeader`/`send` and exposing `respond(status, json)`, `progress(l, t)`, `fail()`):
  - `uploadFile posts the raw file with name, type and progress` — URL `/w/clubhack/files?name=r%C3%A9sum%C3%A9%20%231.pdf`; `withCredentials` true; `Content-Type` `application/pdf`; `onProgress(50, 100)` forwarded; 201 ⇒ resolves to the `file`.
  - `errors and aborts` — 413 `{error:{code:'quota_exceeded',message:'M'}}` ⇒ `ApiClientError` 413 `quota_exceeded` `'M'`; `fail()` ⇒ code `network`; `abort()` on the signal ⇒ rejects `AbortError` and calls `xhr.abort`; an empty `file.type` ⇒ `application/octet-stream`.
  - `makeThumbnail scales to 720 WebP and skips when not needed`:
    - 2000×1000 ⇒ `encode(…, 720, 360, 0.8)`;
    - 600×400 and 100 KB ⇒ `null` with no encode;
    - 600×400 and 600 KB ⇒ encoded at 600×400;
    - a 600 KB blob at 0.8 then a 300 KB blob at 0.6 ⇒ the second;
    - an `image/png` blob ⇒ `null`;
    - `application/pdf` ⇒ `null`;
    - `close` is always called.

  Append to `test/composer.test.tsx` (`vi.mock('../src/files/upload')` with controllable promises):
  - `attach, upload, then send files with or without text` — choose 2 files via `file-input` ⇒ 2 list items with progress; resolve both; submit with empty text ⇒ `onSubmit('', [infoA, infoB])`; the list is cleared.
  - `paste and drop add files` — `fireEvent.paste(textarea, { clipboardData: { files: [f] } })` and `fireEvent.drop(form, { dataTransfer: { files: [g], types: ['Files'] } })` ⇒ 2 uploads started.
  - `cancel, failure and limits never block or corrupt the send` (Review Focus 5):
    - choosing 12 files ⇒ 10 started, alert "You can attach up to 10 files.";
    - a 30 MB file ⇒ alert `"big.bin" is larger than 25 MB.` and no upload;
    - Enter with text while one upload is pending ⇒ `onSubmit` not called and the text kept;
    - "Remove a.png" on a pending upload ⇒ its signal is aborted and it leaves the list;
    - a rejected upload ⇒ the error text plus Retry; Retry ⇒ a second `uploadFile` call; on success submit sends only the remaining files.
  - `no attach button without uploadSlug` — edit mode has no "Attach files".
- [ ] **Step 2: Run** `npm test -w apps/web` → FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** `npm test -w apps/web && npx tsc -p apps/web --noEmit` → PASS / no errors (existing Composer tests unchanged).
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(web): file uploads with progress, thumbnails, paste and drop"`

### Task 10: Rendering files in messages

**Files:**
- Create: `apps/web/src/files/MessageFiles.tsx`
- Modify: `apps/web/src/components/MessageList.tsx` (`MessageRow`, `PendingRow`), `apps/web/src/styles.css` (`.msg-files`, `.file-card`, `.file-image`, `.msg.highlighted`)
- Test: `apps/web/test/files-render.test.tsx`

**Interfaces:**
- Consumes: `FileInfo`, `fileUrl`, `thumbUrl`, `isInlineMime`, `isRasterImage` (Task 1); `ChatState.highlightId` (Task 8).
- Produces:
  - `formatBytes(n: number): string` — base 1024. `n < 1024` ⇒ `` `${n} B` ``. Otherwise KB/MB/GB with one decimal below 10, and no decimals from 10 up (`1536` ⇒ `'1.5 KB'`, `26214400` ⇒ `'25 MB'`).
  - `fitBox(w: number | null, h: number | null, box = 360): { width: number; height: number } | null` — scales down only and keeps the aspect ratio; `null` when either side is unknown.
  - `MessageFiles({ files }: { files: FileInfo[] })` → `<div className="msg-files">`, one entry per file:
    - **Raster image:** `<a href={fileUrl(id)} target="_blank" rel="noopener noreferrer"><img className="file-image" src={hasThumb ? thumbUrl(id) : fileUrl(id)} alt={name} loading="lazy" {...fitBox(width, height)} /></a>`.
    - **Inline `video/*`:** `<video controls preload="metadata" src={fileUrl(id)} />`.
    - **Inline `audio/*`:** `<audio controls preload="none" src={fileUrl(id)} />`.
    - **Anything else (PDF included):** `<div className="file-card">` with the name, `formatBytes(size)`, and for a PDF an "Open" link (`target="_blank"`).
    - **Every entry** also has `<a href={fileUrl(id)} download={name} aria-label={`Download ${name}`}>Download</a>`.
  - `MessageRow` renders `MessageFiles` below the text when `!deletedAt` and `files?.length`. `PendingRow` renders `p.files`. `MessageRow` gains `highlighted?: boolean`: `className` adds `highlighted`, and when it becomes true an effect calls `ref.current?.scrollIntoView?.({ block: 'center' })`. `MessageList`/`ThreadPanel` pass `highlighted={m.id === highlightId}` (new optional prop `highlightId?: string | null`), and `Workspace` passes `state.highlightId`.

- [ ] **Step 1: Write failing tests** `test/files-render.test.tsx`:
  - `images use the thumbnail when present, else the original` — `hasThumb:true` ⇒ `img[src="/files/<id>/thumb"]` with `alt` the name, `width=360 height=180` for 2000×1000; `hasThumb:false` ⇒ `src="/files/<id>"`; both are wrapped in links to `/files/<id>`.
  - `audio and video play inline; other files are cards` — `video[src="/files/<v>"]`, `audio[src="/files/<a>"]`; `text/plain` 1,536 bytes ⇒ the card text includes `1.5 KB`; every file has a link named `Download <name>` with a `download` attribute.
  - `file names render as text` — name `<img src=x onerror=alert(1)>.txt` ⇒ `container.querySelectorAll('img')` length 0.
  - `deleted messages show no files; pending sends show theirs` — through `boot()`, with a history message `files:[f]`, then a `message.delete` frame ⇒ no `.msg-files`; a pending send with `files:[g]` ⇒ g's Download link is present.
  - `formatBytes and fitBox` — `0` ⇒ `'0 B'`, `26214400` ⇒ `'25 MB'`; `fitBox(100, 50)` ⇒ `{100, 50}`; `fitBox(null, 5)` ⇒ `null`.
  - `highlighted row scrolls into view` — `Element.prototype.scrollIntoView = vi.fn()`; rerender with `highlighted` ⇒ called once with `{ block: 'center' }`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** `npm test -w apps/web` → PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(web): inline image previews, media players and file cards"`

### Task 11: Search UI — header box, results panel, highlights, jump

**Files:**
- Create: `apps/web/src/search/SearchPanel.tsx`
- Modify: `apps/web/src/pages/Workspace.tsx` (search form in `<header>`, panel in the right column), `apps/web/src/styles.css` (`.search-panel`, `mark`)
- Test: `apps/web/test/search-ui.test.tsx`

**Interfaces:**
- Consumes: `SearchPage`, `SearchHit`, `SnippetSegment` (Task 1); `api`, `ApiClientError`; `ChatActions.jumpTo` (Task 8); `MessageFiles` (Task 10); `navigate`; the existing `POST /channels/:id/join`.
- Produces:
  - `Snippet({ segments, members }: { segments: SnippetSegment[]; members: MemberSummary[] })` — hit segments become `<mark>{text}</mark>` and others plain text. In every segment, whole `<@ID>` tokens are replaced by `@DisplayName` ("@Unknown" when missing).
  - `SearchPanel({ slug, query, members, onJump, onClose }: { slug: string; query: string; members: MemberSummary[]; onJump: (hit: SearchHit) => void; onClose: () => void })` — `<aside className="search-panel" aria-label="Search results">`:
    - **Fetching:** `GET /w/${slug}/search?q=${encodeURIComponent(query)}` on mount and on query change; "Load more" appends `&cursor=…` while `nextCursor` is set.
    - **States:** "Searching…"; "No results"; API errors show their `message` in `role="alert"`.
    - **Help line** (exact copy): "Filters: in:#channel from:@name has:file before:YYYY-MM-DD after:YYYY-MM-DD".
    - **Each result:** a button containing the channel label (`#name`, or "Direct message"), the author's display name, the time (`toLocaleString`), `Snippet`, and the file names. Clicking calls `onJump(hit)`.
    - **Non-member public channels:** the button reads `Join #name to view`. It first `POST /channels/:id/join` and then calls `onJump`; a failure shows an alert.
    - **Closing:** Escape or the "Close search" button calls `onClose`.
  - `Workspace`:
    - `<form role="search">` with `<input type="search" aria-label="Search messages" maxLength={256}>`. Submitting a non-blank value sets `searchQuery`, which opens `SearchPanel` in the right column. An open thread panel takes precedence when `jumpTo` opens a thread.
    - `onJump(hit)`:
      1. `navigate(`${base}/${hit.channel.id}`)`.
      2. `const ok = await actions.jumpTo({ channelId: hit.channel.id, messageId: hit.message.id, seq: hit.message.seq, parentId: hit.message.parentId, alsoInChannel: hit.message.alsoInChannel })`.
      3. `!ok` ⇒ an alert "That message is too far back to show here."

- [ ] **Step 1: Write failing tests** `test/search-ui.test.tsx` (`boot()`; `stubApi.route` answers `/w/clubhack/search`):
  - `submitting the box requests the search and shows highlighted snippets as text`:
    - type `zebra <b>` and press Enter ⇒ the request URL is `/w/clubhack/search?q=zebra%20%3Cb%3E`;
    - the results show `mark` with text `zebra`;
    - `container.querySelector('.search-panel b')` is null;
    - a segment `see <@${BOB}>` renders `see @Bob`;
    - the channel label `#general` and the author `Bob` are visible.
  - `load more uses the cursor` — the first page has `nextCursor: 'C1'` ⇒ "Load more" ⇒ a second request with `&cursor=C1`; the results are appended; the button disappears when `nextCursor` is null.
  - `empty and error states` — `{results:[],nextCursor:null}` ⇒ "No results"; a 400 `{code:'invalid_date',message:'Dates use YYYY-MM-DD.'}` ⇒ an alert with that text.
  - `clicking a result jumps to the message` — a hit in `RAND` at seq 3 (present in the stubbed page) ⇒ the URL becomes `/client/clubhack/${RAND}`, and the row has class `highlighted`.
  - `a thread reply opens the thread` — hit `parentId: P` ⇒ `GET /messages/P/thread` is requested.
  - `non-member public channel joins first` — `isMember:false` ⇒ the button reads `Join #zoo to view`; click ⇒ `POST /channels/<zoo>/join`, then navigation.
  - `Escape closes the panel`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** `npm test -w apps/web && npx tsc -p apps/web --noEmit` → PASS / no errors.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(web): search box and results panel with jump to message"`

### Task 12: Local smoke, README, full suite

**Files:**
- Modify: `README.md`
- Test: whole repo

**Interfaces:**
- Consumes: everything above.
- Produces: a README section "Files & search (Phase 4)" covering:
  - what works;
  - the limits table from Global Constraints;
  - the R2 key layout and the rule that cleanup and quota never touch `emoji/`;
  - the daily cron `0 4 * * *` and how to trigger it locally (`wrangler dev --test-scheduled`, then `curl "http://localhost:<port>/__scheduled?cron=0+4+*+*+*"`);
  - the search syntax and UTC dates;
  - inline vs attachment rules and the PDF/sandbox note (Decision 9);
  - the D1 rows-written re-estimate (≈ 15 per text message, +3 per file, ≈ 8 per upload; ≈ 6k messages/day);
  - the updated `run_worker_first` list;
  - the Links section lists the Phase 4 plan.

- [ ] **Step 1: Full suite.** Run `npm test`, `npx tsc -p apps/worker --noEmit` and `npx tsc -p apps/web --noEmit`. Expected: every workspace PASSES, there are no type errors, and `grep -ciE "uncaught|unhandled"` over the test output prints `0`.
- [ ] **Step 2: Manual smoke (R5: curl, no browser).**

  **Setup:** a dev server may already hold port 8787, so do not stop it. Run `npx wrangler d1 migrations apply backroom --local` in `apps/worker`. Then run `npm run build -w apps/web`, and `npx wrangler dev --port 8788 --test-scheduled` in `apps/worker`. Every POST sends `-H 'Origin: http://localhost:8787'`, because the check compares against `APP_ORIGIN`, not the port. Sign in the owner as in the README.

  **Checks:**
  - **Upload:** `curl -s -X POST -H 'Origin: http://localhost:8787' -H "Cookie: backroom_session=<t>" -H 'Content-Type: image/png' --data-binary @<a 1600×900 png> 'http://localhost:8788/w/clubhack/files?name=smoke%20%C3%A9.png'` → `201` with `"mime":"image/png","width":1600,"height":900`.
    - A 26,214,401-byte file → `413`.
    - A `.html` file sent as `text/html` → `201`.
  - **Downloads:**
    - `curl -sI …/files/<png id>` → `200`, `content-disposition: inline; filename="smoke _.png"; filename*=UTF-8''smoke%20%C3%A9.png`, `x-content-type-options: nosniff`, `content-security-policy: default-src 'none'; sandbox`.
    - The HTML file → `attachment` with `content-type: application/octet-stream`.
    - `-H 'Range: bytes=0-9'` → `206` with `content-range: bytes 0-9/<size>`.
  - **Send and search:** send a message with that file over WS. This can use the hub test helper pattern or a quick `node` WebSocket script with the cookie. Then `GET /w/clubhack/search?q=smoke` → one result with `message.files[0].name == "smoke é.png"`, and `q=NEAR(a` → `200`.
  - **Cron:** `curl "http://localhost:8788/__scheduled?cron=0+4+*+*+*"` → the log line `orphans_cleaned`.

  Expected: every check matches, and a failure is a bug to fix before continuing.

  **Left for the human, in a browser:** drag-and-drop, paste, progress, the WebP thumbnail, inline PDF/video under `sandbox` (Decision 9), and search jump.
- [ ] **Step 3: README** per Produces.
- [ ] **Step 4: Commit** `git add -A && git commit -m "docs: Phase 4 files and search notes"`
