# Backroom Phase 2 (Messaging) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Members of `clubhack` chat in real time in public/private channels, DMs and group DMs, with threads, edits, deletes, mentions, live unread/mention badges, typing indicators, presence, browser notifications and automatic reconnect; admins manage invites and members from the web app.

**Architecture:** A `WorkspaceHub` Durable Object (SQLite-backed class, one per workspace, addressed by `env.HUB.getByName(workspaceId)`) holds hibernatable WebSockets, serializes writes per channel, persists to D1 in one `batch()` per send and fans out §5 frames. The Worker authenticates `GET /ws` and forwards a freshly built request to the hub; REST routes (channels, DMs, history, threads) live in the Worker and tell the hub about membership/channel changes over DO RPC. D1 logic lives in plain functions (`src/messaging/*`, `src/channels/*`) that the hub and routes call, so it is testable without sockets. The SPA gets a socket client with backoff and an outbox, a pure chat-state reducer, and components built on them.

**Tech Stack:** Node 26, npm workspaces, TypeScript, Hono 4.13.18, zod 4.6.7, Wrangler 4.160.1 (Durable Objects + D1), Vitest 4.1.12 + `@cloudflare/vitest-pool-workers` 0.23.0 (`runInDurableObject`, `evictDurableObject`, `runDurableObjectAlarm` from `cloudflare:test`), React 19.3.1, Vite 8.3.8, `@testing-library/react` 16.3.3 + jsdom. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-11-11-backroom-design.md` — §16 item 2, using §3, §4, §5 (all), §6 (channel/DM/history/thread rows), §12, §13, §14. Phase 1 rulings R1–R13 in `.superpowers/sdd/2026-11-11-phase-1-foundation/progress.md` still hold. Out of scope: reactions and `emoji.update` (Phase 3), files/`fileIds`/search (Phase 4), desktop bridge (Phase 5), E2E/CI (Phase 6).

## Global Constraints

- Carried from Phase 1: IDs are 26-char ULIDs (TEXT); timestamps INTEGER epoch ms; every API error body `{"error":{"code":string,"message":string}}`; every non-GET request needs `Origin` = `APP_ORIGIN` (else `403 bad_origin`); never log message bodies, full emails or tokens; pin exact dependency versions; no FOREIGN KEY constraints (R1); `compatibility_date` stays `2026-08-22` (R6).
- Wire ID validation: `/^[0-9A-Z]{26}$/` (the seed IDs `01JCLUBHACK…` contain `L`/`U`, so strict Crockford would reject them).
- All WebSocket frames are JSON `{t: <type>, ...}` validated with zod from `@backroom/protocol`.
- Message body: 1–40,000 characters (JS `string.length`), not whitespace-only.
- `seq` is assigned only by the hub, strictly increasing per channel, for every message including replies; a failed D1 batch consumes no `seq`.
- Catch-up: at most 200 messages per channel; beyond that the hub sends `stale{channelId}`.
- Client resend: same `clientId` after 10 s without ack. Reconnect backoff 1 s → 30 s with jitter, "Reconnecting…" banner, `hello` on every (re)connect.
- Presence: active iff any of the user's sockets had `hello`/`activity` within 10 min (600,000 ms). Typing: client sends at most one per 3 s; display expires 5 s after the last frame. Typing and presence never touch D1.
- `mark_read`: at most one D1 write per socket per second, and only when `seq` advances.
- History page: default 50, max 100 messages.
- A channel the user may not see (private/DM non-member, other workspace, nonexistent) is `404 not_found` over REST and `nack not_found` over WS — identical either way.
- No HTML injection: `apps/web` never uses `dangerouslySetInnerHTML`; message text renders through React text nodes; only `http:`/`https:` URLs become links (`target="_blank" rel="noopener noreferrer nofollow"`).
- Browser notification permission is requested only from a user click.
- `run_worker_first` must list every API prefix: `["/auth/*", "/me", "/w/*", "/invites/*", "/health", "/channels/*", "/messages/*", "/ws"]`.
- Free-tier budget (§13): ping/pong is answered by the hub's WebSocket auto-response (`{"t":"ping"}` → `{"t":"pong"}`), so it neither wakes the hub nor is billed.

## Review Focus

1. **Resend after a dropped connection lands on a freshly evicted hub** (deploy, or hibernation wiped the in-memory clientId map) — the user still gets one message, not two (Task 5 test `duplicate clientId after hub eviction returns the original ack`).
2. **Pressing Enter to confirm an IME candidate (Japanese/Chinese/Korean input)** — the composer must not send a half-composed message (Task 10 test `Enter during IME composition does not send`).
3. **Hostile or odd message text** — `<img src=x onerror=alert(1)>`, `javascript:alert(1)`, a URL followed by `).`, a 2,000-char unbroken URL — renders as inert text / a correctly trimmed link and never as markup (Task 10 test `renders markup as text and links only http(s)`).
4. **Laptop asleep overnight, then reopened** — more than 200 missed messages in a channel yields `stale`, and the client discards its window and refetches instead of showing a gap (Task 4 test `more than 200 missed sends stale, not messages` + Task 9 test `stale drops the channel window`).
5. **A member leaves (or is removed from) a private channel while their tab stays open** — their open socket stops receiving that channel's messages and typing immediately (Task 7 test `after leaving a private channel the socket receives nothing from it`).

---

### Task 1: Protocol — messaging types, REST bodies, WebSocket frames, mention extraction

**Files:**
- Create: `packages/protocol/src/ws.ts`, `packages/protocol/src/messaging.ts`, `packages/protocol/src/mentions.ts`
- Modify: `packages/protocol/src/rest.ts` (extend `ChannelSummary`), `packages/protocol/src/index.ts` (re-export)
- Test: `packages/protocol/test/ws.test.ts`, `packages/protocol/test/mentions.test.ts`

**Interfaces:**
- Produces (all exported from `@backroom/protocol`):
  - Constants: `MAX_BODY = 40_000`, `CATCHUP_LIMIT = 200`, `HISTORY_DEFAULT = 50`, `HISTORY_MAX = 100`, `RESEND_AFTER_MS = 10_000`, `ACTIVE_WINDOW_MS = 600_000`, `TYPING_THROTTLE_MS = 3_000`, `TYPING_TTL_MS = 5_000`, `MARK_READ_INTERVAL_MS = 1_000`, `PING_FRAME = '{"t":"ping"}'`, `PONG_FRAME = '{"t":"pong"}'`.
  - `Id = z.string().regex(/^[0-9A-Z]{26}$/)`
  - `type ChannelKind = 'public'|'private'|'dm'`; `ChannelSummary` gains `createdBy: string|null` and `dmUserIds: string[]|null` (sorted member IDs for `dm`, else null).
  - `type Message = { id: string; channelId: string; seq: number; userId: string; parentId: string|null; body: string; alsoInChannel: boolean; createdAt: number; editedAt: number|null; deletedAt: number|null; replyCount: number; lastReplyAt: number|null }` and `MessageSchema` (zod) matching it.
  - `type ChannelInfo = { id: string; name: string|null; kind: ChannelKind; topic: string|null; archivedAt: number|null }`
  - `type ChannelListing = ChannelInfo & { memberCount: number; isMember: boolean }`
  - `type HistoryPage = { messages: Message[]; hasMore: boolean }`; `type ThreadPage = { parent: Message; replies: Message[] }`; `type AdminMember = MemberSummary & { deactivatedAt: number|null }`
  - REST bodies: `ChannelCreateBody = z.object({ name: ChannelName, private: z.boolean().default(false), topic: z.string().trim().max(250).optional() })` where `ChannelName = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/)`; `ChannelPatchBody = z.object({ name: ChannelName.optional(), topic: z.string().trim().max(250).optional(), archived: z.boolean().optional() }).refine(at least one key)`; `ChannelMembersBody = z.object({ userIds: z.array(Id).min(1).max(50) })`; `DmOpenBody = z.object({ userIds: z.array(Id).min(1).max(8) })`; `HistoryQuery = z.object({ before: z.coerce.number().int().min(1).optional(), after: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).refine(not both before and after)`.
  - `type NackCode = 'invalid'|'too_long'|'not_found'|'forbidden'|'archived'|'failed'`; `type PresenceState = 'active'|'away'`; `type NotifyKind = 'dm'|'mention'|'thread'|'channel'|'here'|'all'`.
  - `ClientFrame` (zod `discriminatedUnion('t')`): `hello{lastSeen: z.record(Id, z.number().int().min(0)) (≤ 500 keys)}`, `send{clientId: z.string().min(8).max(64), channelId: Id, parentId?: Id, body, fileIds?: z.array(Id).max(10), alsoInChannel?: boolean}`, `edit{messageId: Id, body, clientId?}`, `delete{messageId: Id, clientId?}`, `mark_read{channelId: Id, seq: int ≥ 0}`, `mark_thread_read{messageId: Id, seq: int ≥ 0}`, `typing{channelId: Id, parentId?: Id}`, `activity{}`, `ping{}`. `body` = `z.string().max(MAX_BODY)` refined to non-whitespace.
  - `parseClientFrame(raw: string): { ok: true; frame: ClientFrame } | { ok: false; clientId?: string; code: 'invalid'|'too_long' }` — returns the raw `clientId` when the JSON had a string one, so the hub can nack it; `code` is `too_long` when the only failure is body length.
  - `HubFrame` (zod plain `z.union([...])`, because the two `membership` shapes share `t`): `ack{clientId, message}`, `nack{clientId, code: NackCode}`, `message.new{message}`, `message.edit{message}`, `message.delete{message}`, `read{channelId, seq}`, `channel.update{channel: ChannelInfo}`, `membership{action:'added', channel: ChannelSummary}`, `membership{action:'removed', channelId}`, `presence{userId, state}`, `typing{channelId, userId, parentId?}`, `notify{kind: NotifyKind, channelId, messageId, parentId: string|null, fromUserId, preview: string}`, `catchup{messages: Message[], presence: {userId, state}[]}`, `stale{channelId}`, `pong{}`. `parseHubFrame(raw: string): HubFrame | null` (null on bad JSON or schema).
  - `type ParsedMentions = { userIds: string[]; channel: boolean; here: boolean }`; `extractMentions(body: string): ParsedMentions` — user mentions are tokens `<@ID>` (`/<@([0-9A-Z]{26})>/g`), deduped in first-seen order, capped at 50; `@channel`/`@here` count only when preceded by start-of-text or a character outside `[A-Za-z0-9_@<]` and not followed by `[A-Za-z0-9_-]`.

- [ ] **Step 1: Write failing tests** `packages/protocol/test/ws.test.ts`:

```ts
const GN = '01JCLUBHACK0000000000000GN';
it('accepts seed IDs and a valid send', () => {
  const r = parseClientFrame(JSON.stringify({ t: 'send', clientId: 'c-12345678', channelId: GN, body: 'hi' }));
  expect(r.ok).toBe(true);
});
it('body of 40,000 chars passes, 40,001 is too_long with clientId', () => {
  expect(parseClientFrame(JSON.stringify({ t: 'send', clientId: 'c-12345678', channelId: GN, body: 'a'.repeat(40_000) })).ok).toBe(true);
  expect(parseClientFrame(JSON.stringify({ t: 'send', clientId: 'c-12345678', channelId: GN, body: 'a'.repeat(40_001) })))
    .toEqual({ ok: false, clientId: 'c-12345678', code: 'too_long' });
});
it('whitespace-only body is invalid', () => {
  expect(parseClientFrame(JSON.stringify({ t: 'send', clientId: 'c-12345678', channelId: GN, body: ' \n ' })))
    .toEqual({ ok: false, clientId: 'c-12345678', code: 'invalid' });
});
it('rejects bad JSON and unknown types without clientId', () => {
  expect(parseClientFrame('{nope')).toEqual({ ok: false, code: 'invalid' });
  expect(parseClientFrame('{"t":"react","messageId":"x"}').ok).toBe(false);
});
it('parseHubFrame accepts both membership shapes and rejects junk', () => {
  expect(parseHubFrame(JSON.stringify({ t: 'membership', action: 'removed', channelId: GN }))).not.toBeNull();
  expect(parseHubFrame('{"t":"message.new"}')).toBeNull();
});
```

`packages/protocol/test/mentions.test.ts`:

```ts
const A = '01HZZZZZZZZZZZZZZZZZZZZZZA', B = '01HZZZZZZZZZZZZZZZZZZZZZZB';
it('extracts user tokens deduped in order', () => {
  expect(extractMentions(`<@${B}> hi <@${A}> <@${B}>`)).toEqual({ userIds: [B, A], channel: false, here: false });
});
it('finds @channel and @here at word boundaries only', () => {
  expect(extractMentions('@channel look')).toMatchObject({ channel: true, here: false });
  expect(extractMentions('ping @here.')).toMatchObject({ here: true });
  expect(extractMentions('mail me@channel.io or @channels')).toMatchObject({ channel: false, here: false });
});
it('caps user mentions at 50', () => {
  const ids = Array.from({ length: 60 }, (_, i) => `01H${String(i).padStart(23, '0')}`);
  expect(extractMentions(ids.map((i) => `<@${i}>`).join(' ')).userIds).toHaveLength(50);
});
```

- [ ] **Step 2: Run** `npm test -w packages/protocol` → FAIL (exports missing).
- [ ] **Step 3: Implement** the three modules and the `ChannelSummary` extension per Interfaces; re-export from `src/index.ts`.
- [ ] **Step 4: Run** `npm test -w packages/protocol` → PASS. Run `npx tsc -p apps/worker --noEmit` and fix the two new required `ChannelSummary` fields by returning them from `getBootstrap` (`c.created_by AS createdBy`; `dmUserIds` = `dm_key.split(',')` for `dm`, else `null`) — no behavior change otherwise.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(protocol): messaging types, REST bodies, WS frames, mentions"`

### Task 2: Migration 0004 and the D1 write path (send, edit, delete) + mention-count fix

**Files:**
- Create: `apps/worker/migrations/0004_messaging.sql`, `apps/worker/src/messaging/rows.ts`, `apps/worker/src/messaging/store.ts`
- Modify: `apps/worker/src/workspace/bootstrap.ts` (mentionCount), `apps/worker/test/bootstrap.test.ts`, `apps/worker/test/helpers.ts`
- Test: `apps/worker/test/messaging-store.test.ts`

**Interfaces:**
- Consumes: `newId` (`src/lib/ids.ts`); `Message`, `NackCode`, `ParsedMentions`, `extractMentions` (Task 1).
- Produces:
  - `0004_messaging.sql`: `ALTER TABLE messages ADD COLUMN client_id TEXT;` and `CREATE UNIQUE INDEX idx_messages_client ON messages(user_id, client_id) WHERE client_id IS NOT NULL;` (durable backstop for clientId dedupe across hub eviction). No FKs (R1).
  - `rows.ts`: `MESSAGE_COLUMNS` (SQL select list aliasing to `Message` field names) and `rowToMessage(row: Record<string, unknown>): Message` (`also_in_channel` → boolean).
  - `store.ts`:
    - `type MemberNotify = { userId: string; notify: 'all'|'mentions'|'none' }`
    - `type Audience = { kind: ChannelKind; members: MemberNotify[]; followers: string[]; mentions: ParsedMentions }` — `mentions.userIds` already filtered to channel members other than the author.
    - `type SendInput = { clientId: string; channelId: string; userId: string; parentId: string|null; body: string; alsoInChannel: boolean; fileIds: string[]; now: number }`
    - `sendMessage(db: D1Database, input: SendInput): Promise<{ ok: true; message: Message; duplicate: boolean; audience: Audience } | { ok: false; code: NackCode }>`
    - `editMessage(db: D1Database, input: { messageId: string; userId: string; body: string; now: number }): Promise<{ ok: true; message: Message } | { ok: false; code: NackCode }>`
    - `deleteMessage(db: D1Database, input: { messageId: string; userId: string; now: number }): Promise<{ ok: true; message: Message } | { ok: false; code: NackCode }>`
  - `test/helpers.ts` additions: `seedUsers(app: Hono<AppEnv>, sent: {to:string;url:string}[], emails: string[]): Promise<{ email: string; cookie: string; userId: string }[]>` (first email must be `owner@test.dev`; the rest sign in through one owner-created invite; `userId` from `GET /me`); `insertChannel(opts: { name: string|null; kind: ChannelKind; memberIds: string[]; dmKey?: string; createdBy?: string }): Promise<string>` (direct D1 insert into `clubhack`, `last_read_seq` 0); `GENERAL = '01JCLUBHACK0000000000000GN'`.

Send rules (`sendMessage`, in order):
1. `fileIds.length > 0` ⇒ `invalid` (files arrive in Phase 4).
2. One read: channel row (workspace, kind, archived_at), the sender's `channel_members` row, all members with `notify`; if `parentId`, the parent row. Not a member / no channel ⇒ `not_found`; archived ⇒ `archived`; parent missing, in another channel, or itself a reply ⇒ `invalid`. If `parentId`, also read `thread_follows` user IDs for the parent.
3. Mentions: `extractMentions(body)`; keep `userIds` that are channel members and not the author.
4. One `db.batch`, `id = newId(now)`:
   - `INSERT INTO messages (id, channel_id, seq, user_id, parent_id, body, also_in_channel, created_at, client_id) SELECT ?, id, last_seq + 1, … FROM channels WHERE id = ?`
   - `UPDATE channels SET last_seq = last_seq + 1 WHERE id = ?`
   - one `INSERT INTO mentions` per kept user (`kind 'user'`), plus `(id, NULL, 'channel')` / `(id, NULL, 'here')` when flagged
   - parent: `UPDATE messages SET reply_count = reply_count + 1, last_reply_at = ? WHERE id = ?`
   - `INSERT OR IGNORE INTO thread_follows (message_id, user_id, last_read_reply_seq)` for the author on the thread root (the new message when top-level, the parent when a reply); for a reply, then `UPDATE thread_follows SET last_read_reply_seq = (SELECT seq FROM messages WHERE id = ?)` for the author
   - top-level or `alsoInChannel`: `UPDATE channel_members SET last_read_seq = MAX(last_read_seq, (SELECT seq FROM messages WHERE id = ?)) WHERE channel_id = ? AND user_id = ?` (your own post marks the channel read)
5. Batch throws: if a row exists for `(user_id, client_id)`, return it as `{ ok: true, duplicate: true }` with a freshly loaded audience; else `{ ok: false, code: 'failed' }`. Read the inserted row back with `MESSAGE_COLUMNS`.

Edit: author only (`forbidden`), not deleted (`not_found`); in one batch set `body`, `edited_at`, then `DELETE FROM mentions WHERE message_id = ?` and re-insert from `extractMentions` (filtered as in send). Delete: author, or workspace `owner`/`admin` of the channel's workspace (`forbidden` otherwise); already deleted ⇒ `not_found`; one batch sets `deleted_at = now`, `body = ''`, deletes its `mentions`. Edits/deletes of messages the user cannot see ⇒ `not_found`.

- [ ] **Step 1: Write failing tests** `test/messaging-store.test.ts` (`beforeEach(resetDb)`; users from `seedUsers(app, sent, ['owner@test.dev','alice@test.dev','bob@test.dev'])`; `const input = (o: Partial<SendInput>) => ({ clientId: crypto.randomUUID(), channelId: GENERAL, userId: alice, parentId: null, body: 'hi', alsoInChannel: false, fileIds: [], now: 1_000, ...o })`):
  - `assigns consecutive seqs and bumps last_seq` — three sends ⇒ seqs `[1,2,3]`, `channels.last_seq` 3.
  - `failed batch consumes no seq` — insert a raw `messages` row at `(GENERAL, seq 1)` without touching `last_seq`; `sendMessage` ⇒ `{ ok: false, code: 'failed' }` and `last_seq` still 0; delete that row; next send ⇒ seq 1.
  - `same clientId twice returns the original message` — second call ⇒ `duplicate: true`, same `message.id`; `SELECT count(*) FROM messages` = 1.
  - `non-member and missing channel both give not_found` — private channel via `insertChannel({ kind: 'private', memberIds: [bob] })`; alice ⇒ `not_found`; random 26-char ID ⇒ `not_found`.
  - `archived channel gives archived`; `fileIds gives invalid`; `reply to a reply gives invalid`.
  - `writes mention rows for members only` — body `` `<@${bob}> <@${outsider}> @here` `` where `outsider` is not in the channel ⇒ `mentions` rows exactly `[{user_id: bob, kind:'user'}, {user_id: null, kind:'here'}]`; `audience.mentions.userIds` = `[bob]`.
  - `reply increments parent and follows thread` — parent by alice, reply by bob ⇒ parent `reply_count` 1, `last_reply_at` = reply `now`; `thread_follows` has `(parent, alice)` and `(parent, bob)`; reply leaves bob's `channel_members.last_read_seq` unchanged; `audience.followers` (read before the batch) = `[alice]`.
  - `own top-level post advances own last_read_seq`.
  - `edit by non-author is forbidden; edit replaces mentions and sets editedAt`.
  - `delete clears body, keeps the row, removes mentions; admin may delete others' messages; plain member may not`; `editing a deleted message is not_found`.
  - Bootstrap fix (add to `test/bootstrap.test.ts`): `own @channel does not count toward own mentionCount` — owner posts (via `sendMessage`) `@channel hi` ⇒ owner's `mentionCount` 0 while alice's is 1. In the existing `mentionCount counts direct and @channel mentions` test, author `m3` as `'u-other'` (it is the `@channel` row) so the expectation of 2 stays valid.
- [ ] **Step 2: Run** `npm test -w apps/worker` → FAIL.
- [ ] **Step 3: Implement** the migration, `rows.ts`, `store.ts` per the rules above, and change the `mentionCount` predicate in `getBootstrap` to `(mn.user_id = ?1 OR (mn.kind IN ('channel','here') AND m.user_id <> ?1))`.
- [ ] **Step 4: Run** `npm test -w apps/worker` → PASS (all Phase 1 tests too).
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(worker): message write path, clientId backstop, own-mention fix"`

### Task 3: Read path — history paging, threads, catch-up, and their REST routes

**Files:**
- Create: `apps/worker/src/messaging/read.ts`, `apps/worker/src/messaging/routes.ts`
- Modify: `apps/worker/src/app.ts` (mount), `apps/worker/wrangler.jsonc` (`run_worker_first` adds `"/channels/*"`, `"/messages/*"`)
- Test: `apps/worker/test/history.test.ts`

**Interfaces:**
- Consumes: `MESSAGE_COLUMNS`, `rowToMessage` (Task 2); `HistoryQuery`, `HistoryPage`, `ThreadPage`, `CATCHUP_LIMIT` (Task 1); `requireSession`; `seedUsers`, `insertChannel`, `sendMessage` in tests.
- Produces:
  - `type ChannelRow = { id: string; workspaceId: string; name: string|null; kind: ChannelKind; topic: string|null; archivedAt: number|null; lastSeq: number; createdBy: string|null; isMember: boolean }`
  - `requireChannelRead(db: D1Database, channelId: string, userId: string): Promise<ChannelRow>` — visible iff the user is an active member of the channel's workspace and (is a channel member, or the channel is `public`); else `ApiError(404,'not_found','Channel not found.')`.
  - `listMessages(db: D1Database, channelId: string, q: { before?: number; after?: number; limit: number }): Promise<HistoryPage>` — channel view only (`parent_id IS NULL OR also_in_channel = 1`), returned ascending by `seq`; no cursor ⇒ newest page; `before` ⇒ `seq < before`; `after` ⇒ `seq > after`; fetch `limit + 1` to compute `hasMore` (older pages: more older exist; `after`: more newer exist). Deleted messages are included as placeholders.
  - `getThread(db: D1Database, messageId: string): Promise<ThreadPage | null>` — parent must be top-level; replies ascending by `seq`, at most 1,000.
  - `catchUp(db: D1Database, channelIds: string[], lastSeen: Record<string, number>): Promise<{ messages: Message[]; stale: string[] }>` — only channels present in both; per channel (one `db.batch`): if `last_seq - lastSeen > 200` ⇒ stale, else all messages (including replies) with `seq > lastSeen` ascending, limit 200. Messages ordered by channel then `seq`.
  - Routes: `GET /channels/:id/messages` (query via `HistoryQuery`) → `HistoryPage`; `GET /messages/:id/thread` → `ThreadPage` (404 when the message is missing, is a reply, or its channel fails `requireChannelRead`).

- [ ] **Step 1: Write failing tests** `test/history.test.ts`:
  - `pages backwards by seq` — 120 top-level sends ⇒ no cursor: seqs 71–120, `hasMore: true`; `before=71`: 21–70, `hasMore: true`; `before=21&limit=100`: 1–20, `hasMore: false`.
  - `after returns newer messages ascending` — `after=115` ⇒ 116–120, `hasMore: false`.
  - `before and after together is 400 invalid_request`; `limit=101 is 400`.
  - `channel view excludes plain replies but includes also_in_channel replies`.
  - `deleted message appears as placeholder` — `body ''`, `deletedAt` set.
  - `thread returns parent and replies in order; thread of a reply is 404`.
  - `private channel history and thread are 404 for non-members, identical to unknown IDs` — compare status and JSON body for the private channel and a random ID.
  - `public channel is readable by a non-member workspace member`.
  - `catchUp returns missed messages including replies` — lastSeen 3 of 5 ⇒ seqs `[4,5]`.
  - `catchUp marks a channel stale past 200` — 201 sends, lastSeen 0 ⇒ `stale: [GENERAL]`, no messages; lastSeen 1 ⇒ 200 messages.
  - `catchUp ignores channels the user is not in` — lastSeen for a private non-member channel ⇒ nothing returned.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per Interfaces; mount routes in `createApp`; update `run_worker_first`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(worker): history paging, threads, catch-up"`

### Task 4: WorkspaceHub — binding, `/ws` upgrade route, hibernatable sockets, hello/catch-up, presence

**Files:**
- Create: `apps/worker/src/hub/WorkspaceHub.ts`, `apps/worker/src/hub/attachment.ts`, `apps/worker/src/hub/client.ts`, `apps/worker/src/hub/ws-route.ts`, `apps/worker/test/ws.ts`
- Modify: `apps/worker/wrangler.jsonc`, `apps/worker/src/env.ts`, `apps/worker/src/index.ts`, `apps/worker/src/app.ts`, `apps/worker/src/auth/sessions.ts` (`SessionInfo`), `apps/worker/src/middleware/session.ts`
- Test: `apps/worker/test/hub-connect.test.ts`

**Interfaces:**
- Consumes: `catchUp` (Task 3); `requireMember`, `loadSession`; `ClientFrame`, `HubFrame`, `parseClientFrame`, `PING_FRAME`, `PONG_FRAME`, `ACTIVE_WINDOW_MS` (Task 1).
- Produces:
  - `wrangler.jsonc`: `"durable_objects": { "bindings": [{ "name": "HUB", "class_name": "WorkspaceHub" }] }`, `"migrations": [{ "tag": "v1", "new_sqlite_classes": ["WorkspaceHub"] }]`, `run_worker_first` adds `"/ws"`.
  - `Env.HUB: DurableObjectNamespace<WorkspaceHub>`; `src/index.ts` adds `export { WorkspaceHub } from './hub/WorkspaceHub'`.
  - `SessionInfo = { userId: string; token: string; via: 'cookie'|'bearer' }`. `loadSession` tries the cookie token first and falls back to the Bearer token when the cookie is absent, empty or does not resolve (fixes the Phase 1 deferred `??` finding).
  - `attachment.ts`: `type SocketAttachment = { userId: string; workspaceId: string; channelIds: string[]; lastActivityAt: number; announced: PresenceState }`; `getAtt(ws: WebSocket): SocketAttachment`; `setAtt(ws: WebSocket, a: SocketAttachment): void` (wraps `serializeAttachment`/`deserializeAttachment`).
  - `client.ts`: `hubFor(env: Env, workspaceId: string): DurableObjectStub<WorkspaceHub>` = `env.HUB.getByName(workspaceId)`.
  - `ws-route.ts`: `GET /ws?workspace=<slug>` in order: `Upgrade` header (case-insensitive) must be `websocket` ⇒ else `426 upgrade_required`; session required ⇒ `401 unauthenticated`; Origin: when `session.via === 'cookie'`, `Origin` must equal `APP_ORIGIN`; when `'bearer'`, `Origin` must be absent or equal ⇒ else `403 bad_origin`; `requireMember(slug)` ⇒ `404`; then `return hubFor(env, workspaceId).fetch(new Request('https://hub/connect', { headers: { Upgrade: 'websocket', 'X-Backroom-User': userId, 'X-Backroom-Workspace': workspaceId } }))` — a fresh request so no client header reaches the hub.
  - `class WorkspaceHub extends DurableObject<Env>` (`import { DurableObject } from 'cloudflare:workers'`; keeps no data in DO storage, only its alarm — the SQLite class is required on the Free plan):
    - `now: () => number = () => Date.now()` (public, tests override through `runInDurableObject`).
    - constructor: `ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_FRAME, PONG_FRAME))`.
    - `fetch(req: Request): Promise<Response>` — 426 without `Upgrade`; loads the user's non-archived channel IDs in this workspace from D1; `new WebSocketPair()`; `ctx.acceptWebSocket(server, [userId])` (tag = userId); `setAtt(server, { …, lastActivityAt: 0, announced: 'away' })`; `new Response(null, { status: 101, webSocket: client })`.
    - `webSocketMessage(ws: WebSocket, raw: string|ArrayBuffer): Promise<void>` — binary or > 262,144 chars ⇒ `ws.close(1009, 'too large')`; parse with `parseClientFrame`; invalid frames without `clientId` are dropped; dispatch by `t` (this task: `hello`, `activity`, `ping`; later tasks add the rest).
    - `hello`: `catchUp(db, att.channelIds, lastSeen)` ⇒ send `catchup{messages, presence: snapshot}` then one `stale{channelId}` per stale channel; counts as activity.
    - Activity (`hello`/`activity`): set `lastActivityAt = now()`; if the user's `announced` was `away`, broadcast `presence{userId,'active'}` to every socket and set `announced: 'active'` on all the user's sockets; ensure an alarm is set at `min(existing, lastActivityAt + ACTIVE_WINDOW_MS)`.
    - `webSocketClose(ws, code, reason, wasClean)`: `try { ws.close(code, reason) } catch {}`; if the user has no other open socket and was `announced: 'active'`, broadcast `presence{userId,'away'}`.
    - `alarm()`: for each user whose sockets' max `lastActivityAt + ACTIVE_WINDOW_MS <= now()` and `announced === 'active'` ⇒ broadcast `away`, set `announced: 'away'`; reschedule at the earliest remaining expiry, if any.
    - Private helpers (names fixed for later tasks): `socketsForChannel(channelId: string): WebSocket[]`, `socketsForUser(userId: string): WebSocket[]` (`ctx.getWebSockets(userId)`), `sendFrame(ws: WebSocket, f: HubFrame): void` (swallows send errors on closing sockets), `isActive(userId: string): boolean`.
  - `test/ws.ts`: `type TestSocket = { frames: HubFrame[]; send(f: ClientFrame | string): void; next<T extends HubFrame['t']>(t: T, timeoutMs?: number): Promise<Extract<HubFrame, { t: T }>>; none(t: HubFrame['t'], ms?: number): Promise<void>; closed(): Promise<{ code: number }>; close(): void }`; `upgrade(app, headers: Record<string,string>, slug = 'clubhack'): Promise<Response>`; `connect(app, cookie: string): Promise<TestSocket>` (sends `Origin: https://app.test`, `Upgrade: websocket`; throws unless 101; calls `res.webSocket!.accept()`); `hubStub(): DurableObjectStub<WorkspaceHub>` (for `clubhack`). Every test file closes its sockets in `afterEach`.

- [ ] **Step 1: Write failing tests** `test/hub-connect.test.ts` (`beforeEach(resetDb)`):
  - `upgrade without Upgrade header is 426`; `without session is 401`; `cookie with Origin https://evil.test is 403 bad_origin`; `cookie with no Origin is 403`; `Bearer with no Origin is 101`; `unknown workspace slug is 404`.
  - `stale cookie does not block a valid Bearer` — `GET /me` with `Cookie: backroom_session=garbage` and a valid `Authorization: Bearer` ⇒ 200.
  - `ping is answered with pong` — `send('{"t":"ping"}')` ⇒ `next('pong')`.
  - `hello replays missed messages as catchup` — 3 messages via `sendMessage`; `hello{lastSeen:{[GENERAL]:1}}` ⇒ `catchup.messages.map(m => m.seq)` = `[2,3]`.
  - `more than 200 missed sends stale, not messages` — 201 messages; `hello{lastSeen:{[GENERAL]:0}}` ⇒ `catchup.messages` = `[]` and `next('stale')` = `{ t:'stale', channelId: GENERAL }`.
  - `presence: activity announces active to others; closing the last socket announces away`.
  - `presence goes away after 10 minutes via alarm` — set `hub.now` to `T`, alice `activity`; set `hub.now` to `T + 600_000`; `runDurableObjectAlarm(hubStub())` ⇒ bob receives `presence{userId: alice, state:'away'}`.
  - `attachment survives hibernation with 60 channels` — alice is a member of 60 extra channels (`insertChannel`); connect; `evictDurableObject(hubStub())` (default hibernates sockets); `runInDurableObject(hubStub(), (hub, state) => state.getWebSockets(alice).map(ws => getAtt(ws).channelIds.length))` ⇒ `[61]`, and a later `hello` on the same socket still answers `catchup`. If `serializeAttachment` rejects the size, keep only `{userId, workspaceId, lastActivityAt, announced}` in the attachment and rebuild an in-memory `Map<userId, Set<channelId>>` from D1 on first use after wake; the test stays the same.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per Interfaces; mount `wsRoute` in `createApp`.
- [ ] **Step 4: Run** `npm test -w apps/worker` → PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(worker): WorkspaceHub with hibernatable sockets, /ws, catch-up, presence"`

### Task 5: Hub send/edit/delete — ordering, dedupe, ack/nack, fan-out, isolation

**Files:**
- Modify: `apps/worker/src/hub/WorkspaceHub.ts`
- Test: `apps/worker/test/hub-send.test.ts`

**Interfaces:**
- Consumes: `sendMessage`, `editMessage`, `deleteMessage` (Task 2); hub helpers (Task 4).
- Produces (inside `WorkspaceHub`):
  - `private queues = new Map<string, Promise<unknown>>()`; `private enqueue<T>(channelId: string, fn: () => Promise<T>): Promise<T>` — chains per channel so D1 writes and broadcasts leave in `seq` order.
  - `private recent = new Map<string, { at: number; result: Promise<HubFrame> }>()` keyed `${userId}:${clientId}`; entries expire after 300,000 ms; at most 1,000 entries (drop oldest); a `nack` result deletes its entry so the client can retry.
  - `send`: if the channel is not in `att.channelIds` ⇒ `nack not_found` without touching D1; else `enqueue(channelId, () => sendMessage(...))`; on success broadcast `message.new{message}` to `socketsForChannel(channelId)` except the sending socket, then `ack{clientId, message}` to the sender. The `notify` fan-out hook is called here (implemented in Task 6). A duplicate (in-memory hit or `duplicate: true`) only re-sends the `ack` — no broadcast.
  - `edit`/`delete`: run inside `enqueue(channelId)` (channel from the message row); on success broadcast `message.edit{message}` / `message.delete{message}` to all channel sockets including the sender; on failure `nack{clientId, code}` when the frame carried a `clientId`, otherwise nothing.
  - Invalid frames that carry a `clientId` ⇒ `nack{clientId, code}` with `code` from `parseClientFrame`.

- [ ] **Step 1: Write failing tests** `test/hub-send.test.ts` (owner, alice, bob, carol via `seedUsers`; all connected):

```ts
it('seq ordering under concurrent sends', async () => {
  for (let i = 0; i < 10; i++) {
    alice.send({ t: 'send', clientId: `a-${i}-xxxxxx`, channelId: GENERAL, body: `a${i}` });
    bob.send({ t: 'send', clientId: `b-${i}-xxxxxx`, channelId: GENERAL, body: `b${i}` });
  }
  const seen: number[] = [];
  for (let i = 0; i < 20; i++) seen.push((await carol.next('message.new')).message.seq);
  expect(seen).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  const ch = await env.DB.prepare('SELECT last_seq FROM channels WHERE id=?').bind(GENERAL).first<{ last_seq: number }>();
  expect(ch!.last_seq).toBe(20);
});
```

  - `sender gets ack, others get message.new, sender's socket gets no message.new` — alice's second socket does receive `message.new`.
  - `duplicate clientId returns the same ack once stored` — same frame twice ⇒ two `ack`s with equal `message.id`; carol gets exactly one `message.new` (`none('message.new')` after the first); D1 count 1.
  - `duplicate clientId after hub eviction returns the original ack` — send, await ack, `evictDurableObject(hubStub())`, reconnect alice, resend the same frame ⇒ `ack.message.id` equals the first; D1 count 1.
  - `D1 failure nacks failed without consuming seq` — pre-insert a raw row at `(GENERAL, seq 1)`; send ⇒ `nack{code:'failed'}`; `last_seq` 0.
  - `40,001-char body is nacked too_long; 40,000 is acked`.
  - `private channel isolation` — private channel with alice+bob (inserted before connecting): carol's socket gets no `message.new` (`none`, 200 ms); carol sending to it ⇒ `nack not_found`; carol editing a message in it ⇒ `nack not_found`.
  - `edit by author broadcasts message.edit to all members; by another member nacks forbidden`.
  - `delete broadcasts placeholder` — `message.delete.message.body === ''` and `deletedAt` set.
  - `reply is broadcast to channel members with parentId set`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(worker): hub send/edit/delete with ordering and dedupe"`

### Task 6: Hub read state, typing and notifications

**Files:**
- Create: `apps/worker/src/messaging/notify.ts`
- Modify: `apps/worker/src/hub/WorkspaceHub.ts`
- Test: `apps/worker/test/notify.test.ts`, `apps/worker/test/hub-realtime.test.ts`

**Interfaces:**
- Consumes: `Audience` (Task 2); hub helpers (Tasks 4–5); `MARK_READ_INTERVAL_MS`, `NotifyKind`.
- Produces:
  - `notifyTargets(audience: Audience, message: Message, isActive: (userId: string) => boolean): { userId: string; kind: NotifyKind }[]` — one entry per member other than the author, first matching rule wins: `dm` (channel kind `dm`) → `mention` (in `mentions.userIds`) → `thread` (reply and member in `followers`) → `channel` (`mentions.channel` and `notify !== 'none'`) → `here` (`mentions.here`, `notify !== 'none'`, `isActive`) → `all` (top-level and `notify === 'all'`); otherwise none.
  - Hub after a successful (non-duplicate) send: for each target, `notify{kind, channelId, messageId, parentId, fromUserId, preview: body.slice(0, 140)}` to `socketsForUser(target)`.
  - `mark_read{channelId, seq}`: ignored unless the channel is in `att.channelIds`; per socket (in-memory `WeakMap<WebSocket, { lastWriteAt: number; lastSeq: number; pending?: number; timer?: number }>`): ignore if `seq <= lastSeq`; if `now() - lastWriteAt >= 1000` write now, else keep the max as `pending` and flush with `setTimeout` at `lastWriteAt + 1000`. A write is `UPDATE channel_members SET last_read_seq = MIN(?, (SELECT last_seq FROM channels WHERE id = ?)) WHERE channel_id = ? AND user_id = ? AND last_read_seq < ?`; after it, send `read{channelId, seq}` to the user's other sockets.
  - `mark_thread_read{messageId, seq}`: same throttle (keyed by messageId) on `UPDATE thread_follows SET last_read_reply_seq = ? WHERE message_id = ? AND user_id = ? AND last_read_reply_seq < ?`; no frame.
  - `typing{channelId, parentId?}`: only if the channel is in `att.channelIds`; broadcast `typing{channelId, userId, parentId?}` to channel sockets not belonging to the sender. No D1.

- [ ] **Step 1: Write failing tests.** `test/notify.test.ts` (pure, table-driven): `dm notifies every other participant`; `direct mention beats @channel and ignores notify none`; `@channel respects notify none`; `@here only reaches active members`; `followers get thread replies, author never notified`; `notify all gets top-level messages only`.
  `test/hub-realtime.test.ts`:
  - `mark_read sends read to the user's other sockets only` — alice has sockets A1, A2; bob connected; A1 `mark_read{GENERAL, 2}` (last_seq 3) ⇒ A2 gets `read{GENERAL,2}`; A1 and bob get none; D1 `last_read_seq` 2.
  - `mark_read is coalesced to one write per second` — A1 sends seq 1, 2, 3 back-to-back ⇒ A2 gets `read` 1 immediately, then `read` 3 within 1,500 ms, never `read` 2.
  - `mark_read never moves backwards or past last_seq` — seq 3 then 1 ⇒ no second `read`; seq 99 with last_seq 3 ⇒ D1 value 3.
  - `typing reaches other members, not the sender or non-members` — private channel alice+bob; alice types ⇒ bob gets `typing{userId: alice}`; alice's other socket and carol get none.
  - `DM message notifies the recipient only`.
  - `@here notifies active members only` — bob sent `activity`, carol connected without activity ⇒ bob gets `notify{kind:'here'}`, carol none.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(worker): read state, typing and notifications in the hub"`

### Task 7: Channels and DMs REST, hub RPC for membership/channel changes, deactivation disconnect

**Files:**
- Create: `apps/worker/src/channels/channels.ts`, `apps/worker/src/channels/dms.ts`, `apps/worker/src/channels/routes.ts`
- Modify: `apps/worker/src/hub/WorkspaceHub.ts` (RPC methods), `apps/worker/src/app.ts` (mount), `apps/worker/src/workspace/routes.ts` + `apps/worker/src/workspace/invites.ts` (`patchMember` writes in one `db.batch`; disconnect on deactivate)
- Test: `apps/worker/test/channels.test.ts`

**Interfaces:**
- Consumes: `requireMember`, `requireChannelRead` (Task 3), `hubFor` (Task 4); `ChannelCreateBody`, `ChannelPatchBody`, `ChannelMembersBody`, `DmOpenBody`, `ChannelListing`, `ChannelInfo`, `ChannelSummary` (Task 1).
- Produces:
  - Hub RPC (public methods on `WorkspaceHub`): `membershipChanged(change: { action: 'added'; userIds: string[]; channel: ChannelSummary } | { action: 'removed'; userIds: string[]; channelId: string }): Promise<void>` — updates `channelIds` in each listed user's socket attachments and sends them `membership{…}`; `channelUpdated(channel: ChannelInfo): Promise<void>` — `channel.update{channel}` to the channel's sockets; `disconnectUser(userId: string): Promise<void>` — closes the user's sockets with code `4001`, reason `deactivated`.
  - `channelSummaryFor(db: D1Database, channelId: string): Promise<ChannelSummary>` — the summary a just-joined member sees (`lastReadSeq = lastSeq`, zero counts).
  - Routes (all `requireSession`; errors as listed):
    - `GET /w/:slug/channels` → `{ channels: ChannelListing[] }`: non-archived public channels plus private channels the caller belongs to, ordered by name.
    - `POST /w/:slug/channels` (`ChannelCreateBody`) → `201 { channel: ChannelSummary }`; creator becomes the only member; name taken (including archived) ⇒ `409 name_taken`; hub `membershipChanged(added, [creator])`.
    - `PATCH /channels/:id` (`ChannelPatchBody`) → `{ channel: ChannelInfo }`: caller must be a channel member (else `404` for private/DM, `403 not_member` for public); `topic` by any member (`''` ⇒ NULL); `name`/`archived` only by the creator or a workspace owner/admin (`403 forbidden`); `general` cannot be renamed or archived and DMs cannot be patched (`403 forbidden`); `409 name_taken`; hub `channelUpdated`.
    - `POST /channels/:id/join` → `{ channel: ChannelSummary }`: public and non-archived only, else `404`; idempotent; `last_read_seq = last_seq`; hub `membershipChanged(added)`.
    - `POST /channels/:id/leave` → `{ ok: true }`: `general` or a DM ⇒ `403 cannot_leave`; hub `membershipChanged(removed)`.
    - `POST /channels/:id/members` (`ChannelMembersBody`) → `{ added: string[] }`: caller must be a member; DM or archived ⇒ `403 forbidden`; any ID that is not an active workspace member ⇒ `400 invalid_user` (nothing added); hub `membershipChanged(added)` for newly added users.
    - `POST /w/:slug/dms` (`DmOpenBody`) → `{ channel: ChannelSummary }` (`200`, or `201` when created): participants = unique(`userIds` ∪ caller), all active workspace members else `400 invalid_user`; `dm_key` = sorted IDs joined by `,`; `INSERT … ON CONFLICT(workspace_id, dm_key) DO NOTHING`, then insert members `OR IGNORE`; hub `membershipChanged(added)` for all participants only when created. A DM with only yourself is allowed.
  - `PATCH /w/:slug/members/:userId`: after `patchMember` succeeds with `deactivated: true`, `await hubFor(env, workspaceId).disconnectUser(userId)`.

- [ ] **Step 1: Write failing tests** `test/channels.test.ts`:
  - `create public channel; creator is member; duplicate name is 409`; `name "Has Space" is 400`; `"  Design " is stored as "design"`.
  - `browse lists public channels with isMember and hides others' private channels`.
  - `join public adds member and pushes membership.added to the joiner's socket`; `join private is 404, same body as an unknown ID`.
  - `after leaving a private channel the socket receives nothing from it` — alice+bob in private P, both connected; bob leaves via REST ⇒ bob gets `membership{action:'removed', channelId:P}`; alice then sends to P and types in P ⇒ bob gets no `message.new`/`typing` (`none`, 200 ms); bob's own send to P ⇒ `nack not_found`.
  - `cannot leave general or a DM (403 cannot_leave)`.
  - `PATCH topic by any member; rename by plain member is 403; archive by creator broadcasts channel.update with archivedAt; general cannot be archived`.
  - `members add rejects non-workspace user IDs atomically (400 invalid_user, nothing added)`.
  - `open DM is idempotent regardless of order` — alice opens `[bob]`, bob opens `[alice]` ⇒ same channel ID; `dmUserIds` sorted; third call ⇒ 200 not 201.
  - `group DM key includes the caller`; `DM is invisible to non-participants` — carol's history request ⇒ 404.
  - `deactivating a member closes their socket with 4001`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** `npm test -w apps/worker` → PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(worker): channels and DMs REST with live membership updates"`

### Task 8: Web realtime client — socket with backoff, and the outbox

**Files:**
- Create: `apps/web/src/realtime/socket.ts`, `apps/web/src/realtime/outbox.ts`, `apps/web/test/fakeSocket.ts`
- Test: `apps/web/test/socket.test.ts`, `apps/web/test/outbox.test.ts`

**Interfaces:**
- Consumes: `ClientFrame`, `HubFrame`, `parseHubFrame`, `PING_FRAME`, `RESEND_AFTER_MS`, `Message`, `NackCode` (Task 1).
- Produces:
  - `backoffDelay(attempt: number, random: number): number` = `base / 2 + (random * base) / 2` where `base = Math.min(30_000, 1_000 * 2 ** attempt)`.
  - `type SocketState = 'connecting'|'open'|'reconnecting'|'closed'`
  - `class HubSocket { constructor(opts: { url: string; onFrame: (f: HubFrame) => void; onState: (s: SocketState) => void; onOpen: () => void; onAuthLost: () => void; probeAuth: () => Promise<boolean>; WebSocketImpl?: typeof WebSocket; random?: () => number }); start(): void; stop(): void; send(f: ClientFrame): boolean }` — `onOpen` fires after each successful open (the caller sends `hello` then `activity`); sends `PING_FRAME` every 30,000 ms and reconnects if no `pong` arrives within 10,000 ms; on close/error schedules `backoffDelay(attempt++)` and reports `reconnecting`; attempt resets on open; close code `4001` ⇒ `onAuthLost()` with no reconnect; from the second consecutive failure, `probeAuth()` resolving `false` ⇒ `onAuthLost()`. Unparseable frames are dropped.
  - `wsUrl(slug: string): string` = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?workspace=${encodeURIComponent(slug)}`.
  - `type PendingSend = { clientId: string; channelId: string; parentId: string|null; body: string; alsoInChannel: boolean; status: 'sending'|'failed'; error?: NackCode; attempts: number; lastSentAt: number }`
  - `class Outbox { constructor(opts: { send: (f: ClientFrame) => boolean; onChange: (pending: PendingSend[]) => void; now?: () => number }); enqueue(p: { channelId: string; parentId: string|null; body: string; alsoInChannel: boolean }): string /* clientId = crypto.randomUUID() */; ack(clientId: string): void; nack(clientId: string, code: NackCode): void; retry(clientId: string): void; discard(clientId: string): void; flush(): void /* resend all 'sending' after (re)connect */; tick(): void /* called every 1 s */ }` — resend with the same `clientId` when `now - lastSentAt >= 10_000`; after 3 attempts without ack ⇒ `failed`; `nack` ⇒ `failed` with `error`; `retry` resets attempts and sends again with the same `clientId`.
  - `test/fakeSocket.ts`: `class FakeWebSocket` (static `instances`, `sent: string[]`, `open()`, `receive(frame: object|string)`, `serverClose(code: number)`), installed with `vi.stubGlobal('WebSocket', FakeWebSocket)`.

- [ ] **Step 1: Write failing tests** (`vi.useFakeTimers()`):
  - `backoff grows to 30 s with jitter` — `backoffDelay(0,0)` 500, `backoffDelay(0,1)` 1000, `backoffDelay(10,1)` 30000, `backoffDelay(10,0)` 15000.
  - `reconnects with backoff and calls onOpen each time` — close after open ⇒ state `reconnecting`; after `backoffDelay(0, 0.5)` ms a new `FakeWebSocket` exists; opening it calls `onOpen` a second time.
  - `close code 4001 calls onAuthLost and stops`; `second failed attempt probes auth; false calls onAuthLost`.
  - `missing pong forces reconnect` — after open, advance 30,000 ⇒ `sent` ends with `{"t":"ping"}`; advance 10,000 without pong ⇒ socket closed and reconnect scheduled.
  - Outbox: `resends with same clientId after 10 s`; `ack removes the entry`; `three unacked attempts mark failed`; `nack too_long marks failed with error; retry resends same clientId`; `flush resends pending after reconnect`.
- [ ] **Step 2: Run** `npm test -w apps/web` → FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(web): hub socket with backoff and send outbox"`

### Task 9: Web chat state reducer

**Files:**
- Create: `apps/web/src/state/chat.ts`
- Test: `apps/web/test/chat.test.ts`

**Interfaces:**
- Consumes: `Bootstrap`, `ChannelSummary`, `HubFrame`, `HistoryPage`, `ThreadPage`, `Message`, `PresenceState`, `extractMentions`, `TYPING_TTL_MS` (Task 1); `PendingSend`, `SocketState` (Task 8).
- Produces:
  - `type ChannelWindow = { messages: Message[] /* channel view, ascending seq, unique by id */; hasOlder: boolean; loaded: boolean }`
  - `type ChatState = { me: string; bootstrap: Bootstrap|null; channels: Record<string, ChannelSummary>; windows: Record<string, ChannelWindow>; threads: Record<string, ThreadPage>; pending: PendingSend[]; presence: Record<string, PresenceState>; typing: { channelId: string; parentId: string|null; userId: string; until: number }[]; lastSeen: Record<string, number>; connection: SocketState; openChannelId: string|null; openThreadId: string|null; focused: boolean }`
  - `type ChatEvent = HubFrame | { t: 'local.bootstrap'; bootstrap: Bootstrap } | { t: 'local.history'; channelId: string; page: HistoryPage; mode: 'replace'|'prepend' } | { t: 'local.thread'; page: ThreadPage } | { t: 'local.open'; channelId: string } | { t: 'local.openThread'; parentId: string|null } | { t: 'local.focus'; focused: boolean } | { t: 'local.pending'; pending: PendingSend[] } | { t: 'local.connection'; state: SocketState } | { t: 'local.tick'; now: number }`
  - `initialChat(me: string): ChatState`; `reduce(state: ChatState, e: ChatEvent, now: number): ChatState` (pure).
  - `isViewing(s: ChatState, channelId: string): boolean` = `s.focused && s.openChannelId === channelId`.
  - `lastSeenFor(s: ChatState): Record<string, number>` — per channel `max(lastSeen, channel.lastSeq)`; used for `hello`.
  - Rules: `message.new`/`ack`/catch-up messages update `lastSeen` and the channel's `lastSeq`; a top-level (or `alsoInChannel`) message joins its window if loaded; a reply joins `threads[parentId]` if loaded and bumps the parent's `replyCount`/`lastReplyAt` wherever the parent is held; messages from others in a channel that is not viewed and counts as channel-view ⇒ `unreadCount + 1`, and `mentionCount + 1` when `extractMentions` hits `me`, `@channel` or `@here`; `message.edit`/`message.delete` replace by id everywhere; `read` ⇒ `lastReadSeq = max`, and counts zeroed when `seq >= lastSeq`; `local.open` ⇒ counts zeroed for that channel; `stale` ⇒ delete that window (and threads in that channel) so it is refetched; `membership added` inserts the channel, `removed` deletes it and its window; `channel.update` with `archivedAt` removes the channel, otherwise merges name/topic; `typing` adds/refreshes an entry with `until = now + TYPING_TTL_MS`; `local.tick` drops expired typing; `presence`/`catchup.presence` set presence; `local.bootstrap` replaces channels (fresh counts) and keeps loaded windows.

- [ ] **Step 1: Write failing tests** `test/chat.test.ts` (fixtures `msg(seq, o?)`):
  - `new message in a background channel increments unread; in the viewed channel it does not`.
  - `mention of me, @channel and @here bump mentionCount; my own @channel does not`.
  - `replies do not bump unread unless alsoInChannel; they bump parent replyCount`.
  - `read event clears counts when seq reaches lastSeq`.
  - `history prepend keeps order and dedupes by id`.
  - `stale drops the channel window`.
  - `typing expires after 5 s on tick`.
  - `membership removed deletes the channel and window; archived channel.update removes it`.
  - `lastSeenFor uses the larger of bootstrap lastSeq and seen seq`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** per Interfaces. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(web): chat state reducer"`

### Task 10: Safe message text and the composer

**Files:**
- Create: `apps/web/src/text/tokenize.ts`, `apps/web/src/components/MessageText.tsx`, `apps/web/src/components/Composer.tsx`
- Test: `apps/web/test/tokenize.test.ts`, `apps/web/test/composer.test.tsx`

**Interfaces:**
- Consumes: `MemberSummary`, `MAX_BODY`, `TYPING_THROTTLE_MS` (Task 1).
- Produces:
  - `type Token = { kind: 'text'; text: string } | { kind: 'link'; href: string; text: string } | { kind: 'user'; userId: string } | { kind: 'broadcast'; which: 'channel'|'here' }`
  - `tokenize(body: string): Token[]` — links match `https?://[^\s<>"]+` with trailing `.,!?:;'"` and an unbalanced trailing `)` trimmed back to text; a link token is produced only if `new URL(text).protocol` is `http:` or `https:`; user tokens from `<@ID>`; broadcasts with the same boundary rule as `extractMentions`.
  - `encodeMentions(text: string, picked: Map<string, string> /* displayName → userId */): string` — replaces `@DisplayName` (longest names first, followed by end/whitespace/punctuation) with `<@userId>`.
  - `decodeMentions(body: string, members: MemberSummary[]): { text: string; picked: Map<string, string> }` — the inverse, for editing (unknown IDs stay as tokens).
  - `MessageText({ body, members, me }: { body: string; members: MemberSummary[]; me: string })` — renders tokens as React text/elements inside `<span className="msg-text">` (CSS `white-space: pre-wrap; overflow-wrap: anywhere`): links as `<a href target="_blank" rel="noopener noreferrer nofollow">`; user mentions as `<span className="mention">@Name</span>` (`mention me` when it is `me`; `@unknown` for unknown IDs); broadcasts as `<span className="mention">@channel</span>`. `:shortcode:` stays plain text.
  - `Composer({ placeholder, members, initial, onSubmit, onTyping, onCancel }: { placeholder: string; members: MemberSummary[]; initial?: string; onSubmit: (body: string) => void; onTyping?: () => void; onCancel?: () => void })` — `<textarea aria-label={placeholder}>`; Enter submits `encodeMentions(text, picked)` when `text.trim()` is non-empty and `length <= MAX_BODY` (then clears); Shift+Enter inserts a newline; Enter while `event.nativeEvent.isComposing` or `keyCode === 229` does nothing; Escape calls `onCancel`; `onTyping` at most once per 3,000 ms while text is non-empty; typing `@` plus letters opens a `listbox` of matching members (display-name prefix, max 8), where ArrowUp/Down move, Enter/Tab/click insert `@Name ` and record it in `picked`; over-limit text shows "Message is too long (max 40,000 characters)." and does not submit. `initial` (edit mode) is passed through `decodeMentions`.

- [ ] **Step 1: Write failing tests.** `test/tokenize.test.ts`:

```ts
it('renders markup as text and links only http(s)', () => {
  expect(tokenize('<img src=x onerror=alert(1)>')).toEqual([{ kind: 'text', text: '<img src=x onerror=alert(1)>' }]);
  expect(tokenize('javascript:alert(1)').every((t) => t.kind === 'text')).toBe(true);
  expect(tokenize('see (https://ex.com/a_(b)).')).toEqual([
    { kind: 'text', text: 'see (' },
    { kind: 'link', href: 'https://ex.com/a_(b)', text: 'https://ex.com/a_(b)' },
    { kind: 'text', text: ').' },
  ]);
});
it('encode/decode mentions round-trip', () => {
  const picked = new Map([['Ann Lee', A]]);
  expect(encodeMentions('hi @Ann Lee!', picked)).toBe(`hi <@${A}>!`);
  expect(decodeMentions(`hi <@${A}>!`, [{ id: A, displayName: 'Ann Lee', role: 'member', avatarKey: null }]).text).toBe('hi @Ann Lee!');
});
```

  Also: `MessageText` render test — body `` `<b>x</b> <@${A}> https://ex.com` `` renders with `container.querySelector('b')` null, exactly one `a` whose `getAttribute('href')` is `https://ex.com` and `rel` is `noopener noreferrer nofollow`, and the mention text `@Ann Lee`.
  `test/composer.test.tsx`: `Enter sends trimmed-nonempty text and clears`; `Shift+Enter inserts newline without sending`; `Enter during IME composition does not send` (`fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true })` and with `keyCode: 229` ⇒ `onSubmit` not called); `whitespace-only is not sent`; `40,001 chars shows the limit message and does not send`; `autocomplete inserts @Name and submits a <@id> token`; `onTyping is throttled to once per 3 s` (fake timers).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** per Interfaces (add `.msg-text`, `.mention`, `.mention.me`, listbox styles to `src/styles.css`). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(web): safe message text and composer"`

### Task 11: Workspace view — live sidebar, message list, typing, reconnect banner, notifications

**Files:**
- Create: `apps/web/src/realtime/useChat.ts`, `apps/web/src/components/Sidebar.tsx`, `apps/web/src/components/MessageList.tsx`, `apps/web/src/components/TypingIndicator.tsx`, `apps/web/src/notifications.ts`
- Modify: `apps/web/src/pages/Workspace.tsx` (rewrite), `apps/web/src/App.tsx` (routes), `apps/web/src/styles.css`, `apps/web/test/workspace.test.tsx` (stub `WebSocket` with `FakeWebSocket`; answer `/messages` with `{"messages":[],"hasMore":false}`)
- Test: `apps/web/test/workspace.test.tsx`, `apps/web/test/notifications.test.ts`

**Interfaces:**
- Consumes: Tasks 8–10; REST from Tasks 3 and 7; `navigate` (`src/nav.ts`).
- Produces:
  - Routes in `App.tsx`: `/client/:slug` and `/client/:slug/:channelId` → `<Workspace slug channelId?>`; `/client/:slug/admin` → `<Admin slug>` (Task 13; until then a placeholder). With no `channelId`, Workspace replaces the URL with `general`'s ID (else the first channel).
  - `useChat(slug: string): { state: ChatState; actions: ChatActions }` where `ChatActions = { open(channelId: string): void; loadOlder(channelId: string): Promise<void>; openThread(parentId: string|null): void; send(channelId: string, body: string, parentId?: string|null, alsoInChannel?: boolean): void; retry(clientId: string): void; discard(clientId: string): void; edit(messageId: string, body: string): void; remove(messageId: string): void; typing(channelId: string, parentId?: string|null): void; refresh(): Promise<void> }`. It fetches bootstrap (401 ⇒ `navigate('/login', { replace: true })`), runs `HubSocket` (`url: wsUrl(slug)`; `probeAuth` = `api('/me')` resolving `false` only on a 401 `ApiClientError`; `onAuthLost` ⇒ `navigate('/login', { replace: true })`; `onOpen`: send `hello{lastSeen: lastSeenFor(state)}`, `activity{}`, `outbox.flush()`, then refetch bootstrap and the open channel's latest page and open thread), feeds frames to `reduce`, routes `ack`/`nack` to the `Outbox`, sends `mark_read{channelId, lastSeq}` when the viewed channel's `lastSeq` exceeds `lastReadSeq` (at most once per 1,000 ms), sends `activity{}` on keydown/pointerdown at most once per 60,000 ms, ticks every 1,000 ms (`local.tick`, `outbox.tick()`), and tracks `focus`/`blur`/`visibilitychange`.
  - `Sidebar` — channel list (`#name`; DMs as the other participants' display names joined by `, `, or your own name for a self-DM), bold when `unreadCount > 0`, mention badge `aria-label="{n} mentions"`; members list with a presence dot (`aria-label="active"` / `"away"`); buttons "Browse channels", "New message" (Task 12), "Admin" for owner/admin linking to `/client/:slug/admin`, and "Enable notifications" while `Notification.permission === 'default'`.
  - `MessageList({ window, pending, members, me, myRole, onLoadOlder, onOpenThread, onEdit, onDelete, onRetry, onDiscard })` — "Load older messages" button while `hasOlder`; groups consecutive messages by the same author less than 300,000 ms apart (author name and time shown only on the first of a group); deleted ⇒ "This message was deleted."; edited ⇒ "(edited)"; `replyCount > 0` ⇒ button "{n} replies" (`1 reply`) opening the thread; own messages get "Edit" and "Delete" (Delete also for owner/admin), Edit swaps in a `Composer` with `initial`, Delete asks `window.confirm('Delete this message?')`; pending sends render at the bottom with "Sending…" or "Failed to send" + "Retry"/"Discard"; stays scrolled to the bottom when new messages arrive if it was at the bottom.
  - `TypingIndicator({ userIds, members })` — "Ann is typing…", "Ann and Bo are typing…", "Several people are typing…" (3+), nothing when empty.
  - Reconnect banner: `<div role="status">Reconnecting…</div>` while `connection === 'reconnecting'`.
  - `notifications.ts`: `showNotification(n: Extract<HubFrame,{t:'notify'}>, ctx: { viewing: boolean; title: string; body: string; onClick: () => void }): boolean` — returns false and does nothing when `viewing` or `Notification` is undefined or permission is not `granted`; otherwise `new Notification(title, { body, tag: n.messageId })` with `onclick` → `window.focus()` + `onClick()`. `requestNotificationPermission(): Promise<NotificationPermission>`. Titles: `dm` → sender name; others → `#channel` (or DM names); body = preview rendered as plain text (mention tokens → `@Name`).

- [ ] **Step 1: Write failing tests** (`FakeWebSocket`, stubbed `fetch`):
  - `workspace.test.tsx`: `sends hello with lastSeen from bootstrap on open`; `renders history and appends message.new live`; `background message bumps the sidebar badge and bold state` (mention text ⇒ badge `1 mentions`); `opening a channel sends mark_read and clears its badge`; `Load older fetches before=<oldest seq>&limit=50 and prepends`; `groups messages within 5 minutes under one author header`; `shows Reconnecting… after the socket closes and hides it after reopen`; `typing frame shows "Bob is typing…" for 5 s`; `optimistic message shows Sending… then is replaced by the acked message`; `nack failed shows Retry, which resends the same clientId`; `presence frame flips the member dot`; `Edit and Delete appear only on own messages for members`; existing sign-out and redirect tests still pass.
  - `notifications.test.ts`: `suppressed while viewing the channel`; `shown when not viewing and permission granted, with tag = messageId`; `permission is requested only on click` — rendering Workspace with `Notification.permission = 'default'` makes no `requestPermission` call until "Enable notifications" is clicked.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** per Interfaces (layout: sidebar 260px, message column, thread panel column reserved for Task 12; light/dark via existing tokens). **Step 4: Run** `npm test -w apps/web` → PASS; `npm run build -w apps/web` succeeds.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(web): live workspace view with messages, badges, typing, presence"`

### Task 12: Threads panel, channel browser/create/settings, new DM

**Files:**
- Create: `apps/web/src/components/ThreadPanel.tsx`, `apps/web/src/components/ChannelBrowser.tsx`, `apps/web/src/components/ChannelSettings.tsx`, `apps/web/src/components/NewDmDialog.tsx`
- Modify: `apps/web/src/pages/Workspace.tsx`, `apps/web/src/styles.css`
- Test: `apps/web/test/thread.test.tsx`, `apps/web/test/channels-ui.test.tsx`

**Interfaces:**
- Consumes: `useChat` actions (Task 11), `Composer`, `MessageList` grouping rules (reuse the same message row component), REST from Task 7.
- Produces:
  - `ThreadPanel({ page, pending, members, me, myRole, typingUserIds, onSend, onClose, … })` — `<aside aria-label="Thread">` with the parent, replies, a `Composer` with placeholder "Reply…", and a checkbox "Also send to #<channel>" (for DMs "Also send to conversation") mapped to `alsoInChannel`; opening fetches `GET /messages/:id/thread` (dispatch `local.thread`), sends `mark_thread_read{messageId, seq: last reply seq}` when replies arrive while open; "Close" button.
  - `ChannelBrowser({ slug, onJoined, onClose })` — `role="dialog"` titled "Browse channels"; lists `GET /w/:slug/channels` with member counts, "Join" (`POST /channels/:id/join`) or "Open" if member; a "Create channel" form (fields "Name", "Topic", checkbox "Private") posting `POST /w/:slug/channels`; `409` shows "That name is already taken."; `400` shows "Use lowercase letters, numbers, - and _ (max 80)."; success navigates to the channel.
  - `ChannelSettings({ channel, canManage, onClose })` — header "Channel settings": topic (any member), name and "Archive channel" (only when `canManage` = creator or owner/admin, and not `general`), "Leave channel" (hidden for `general` and DMs); calls `PATCH /channels/:id` / `POST /channels/:id/leave`; after leave/archive navigate to `general`. Channel header shows `#name`, topic, and a "Channel settings" button.
  - `NewDmDialog({ slug, members, me, onOpened, onClose })` — `role="dialog"` "New message": checkbox list of other members (1–8), "Open" posts `POST /w/:slug/dms` and navigates to the returned channel.

- [ ] **Step 1: Write failing tests:**
  - `thread.test.tsx`: `opening "2 replies" loads the thread and shows replies`; `reply with "Also send to #general" sends alsoInChannel true and parentId`; `live reply appears in the open thread and bumps the count in the channel`.
  - `channels-ui.test.tsx`: `browse lists channels and Join posts then navigates`; `create posts lowercase name and private flag; 409 shows the taken message`; `settings hides Archive for non-managers and Leave for general`; `new DM posts selected userIds and navigates to the returned channel`; `DM appears in the sidebar labelled with the other member's name` (after `membership added`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** per Interfaces. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(web): threads, channel browser and settings, DMs"`

### Task 13: Admin page — invites and members (R12)

**Files:**
- Create: `apps/web/src/pages/Admin.tsx`
- Modify: `apps/web/src/App.tsx`, `apps/worker/src/workspace/routes.ts`, `apps/worker/src/workspace/invites.ts`
- Test: `apps/worker/test/invites.test.ts`, `apps/web/test/admin.test.tsx`

**Interfaces:**
- Consumes: Phase 1 `POST/GET /w/:slug/invites`, `DELETE /invites/:id`, `PATCH /w/:slug/members/:userId`; `AdminMember`, `InviteSummary`, `Bootstrap` (`me.role`).
- Produces:
  - `listMembers(db: D1Database, workspaceId: string): Promise<AdminMember[]>` and route `GET /w/:slug/members` (admin only; `403 forbidden` for members) → `{ members: AdminMember[] }` including deactivated members, ordered by display name. (Needed to reactivate someone; the bootstrap lists active members only.)
  - `Admin({ slug })` at `/client/:slug/admin` — loads bootstrap (non-admin ⇒ "You need to be an admin to see this page."), invites and members. Invites: "Create invite" form (number inputs "Max uses" default 50, "Expires in days" default 14) → shows the returned URL in a read-only input with "Copy link" (`navigator.clipboard.writeText(url)`, then "Copied"); table of active invites (uses/max, expiry date) with "Revoke" (`DELETE /invites/:id`). Members: name, role, status; role `<select>` (admin/member) only when the viewer is the owner and the row is not the owner; "Deactivate"/"Reactivate" for admins on non-owner rows other than themselves (`PATCH … {deactivated}`); API errors show their `message` in `role="alert"`. "Back to chat" links to `/client/:slug`.

- [ ] **Step 1: Write failing tests:** worker `admin lists members including deactivated; plain member gets 403`. Web `admin.test.tsx`: `create invite shows the link and copies it`; `revoke removes the invite row`; `owner sees role select, admin does not`; `deactivate then reactivate toggles the button`; `non-admin sees the not-allowed message`.
- [ ] **Step 2: Run** `npm test -w apps/worker && npm test -w apps/web` → FAIL. **Step 3: Implement** per Interfaces. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: admin page for invites and members"`

### Task 14: Local end-to-end smoke, README, full suite

**Files:**
- Modify: `README.md`
- Test: whole repo

**Interfaces:**
- Consumes: everything above.
- Produces: README sections "Messaging (Phase 2)" (what works, the `/ws` endpoint, that `wrangler dev` runs the hub locally) and an updated deploy note: the first deploy after this phase creates the `WorkspaceHub` class from the `v1` migration tag; `run_worker_first` list as in Global Constraints.

- [ ] **Step 1: Full suite.** `npm test` → all workspaces PASS; `npx tsc -p apps/worker --noEmit` and `npx tsc -p apps/web --noEmit` → no errors.
- [ ] **Step 2: Manual smoke (R5: curl, no browser).** In `apps/worker`: `npx wrangler d1 migrations apply backroom --local`, then `npm run dev:all`. Sign in the owner and a second invited user with curl as in the README; then:
  - `curl -s -o /dev/null -w '%{http_code}' -H 'Upgrade: websocket' -H 'Connection: Upgrade' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Origin: http://localhost:8787' -H "Cookie: backroom_session=<token>" 'http://localhost:8787/ws?workspace=clubhack' --max-time 2` → `101`; the same with `Origin: http://evil.test` → `403`.
  - `POST /w/clubhack/channels {"name":"smoke"}`, `POST /w/clubhack/dms {"userIds":["<second user id>"]}`, `GET /channels/<general id>/messages` → expected statuses `201`, `201`, `200`.
  - `GET /client/clubhack` → the SPA `index.html` (not a Worker 404), and `GET /channels/<id>/messages` without a cookie → `401` JSON (Worker, not SPA).
  Expected: every check matches; a failure is a bug to fix before continuing. The two-browser chat walkthrough is left for the human.
- [ ] **Step 3: README** per Produces.
- [ ] **Step 4: Commit** `git add -A && git commit -m "docs: Phase 2 messaging notes"`
