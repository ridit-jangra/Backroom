# Hide deleted messages completely Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a message is deleted, it disappears everywhere. No "This message was deleted." placeholder in channels, threads or anywhere else. Deleting a thread starter deletes its replies too, behind a confirmation.

**Architecture:** Deletion stays a soft delete in the database (the row keeps `id`, `channel_id`, `seq`, `parent_id`, timestamps and `deleted_at`, with an empty body and no mentions, reactions or file links; this already happens today). The row has to remain because per-channel `seq` ordering, unread counts and offline catch-up depend on it, and an offline client can only learn about a deletion from it. The change is:
1. the server also keeps the parent's reply counters right and cascades a thread starter's deletion to its replies;
2. clients never render a tombstone, close a thread whose starter is deleted, show correct reply counts, and ask for confirmation before deleting a starter that has replies.

**Tech Stack:** existing (Hono worker, hub frames, React web app, zod protocol, vitest, Playwright).

**Spec:** docs/superpowers/specs/2026-11-11-backroom-design.md (messages/threads/deletion sections; Task 3 updates them).

## Global Constraints

- Wire compatibility: only optional fields or NEW frame types; tabs stay open across deploys, so an OLD client must safely ignore anything new (verify how the web client and `parseHubFrame` treat unknown frame types and unknown optional fields before adding one). A tombstone must keep arriving through `message.delete` and `catchup` exactly as today so old clients keep working.
- Do not change the D1 schema unless unavoidable (if a column is needed, a new migration `0009_...sql`, additive, no foreign keys).
- Tombstones keep their `seq` and `parent_id`; unread math and `last_read_seq` logic must not change.
- Never log message bodies, emails or tokens.
- Files of a deleted message are removed from storage by the existing nightly orphan cleanup (04:00); do not add immediate blob deletion.
- Subagents run on Sonnet (user's instruction). Commit messages end with a blank line and `Claude-Session: https://claude.ai/code/session_0163nEV5tSsJFQCKT3iMKfqb`.
- The machine is low on memory: run ONE heavy command at a time. Never use port 8787; the e2e suite uses 8788; integration tests use 8900-8999. Do not push, tag or publish anything. No ssh, no Cloudflare commands, no real email (`RESEND_API_KEY=dev` in every test server), never read `apps/worker/.dev.vars`.

## Review Focus

1. A deleted message is visible nowhere: not in the channel view, a thread panel, the "also sent to channel" view, search (already excluded), notifications, the jump-to-message path, or after a reconnect/catch-up of a client that was offline when the deletion happened.
2. A thread starter's deletion removes all replies for every connected client AND for a client that reconnects later; reply counts and "last reply" never show a deleted reply; a user who has that thread open sees it close.
3. No data is lost for anything else: unread counts, mention counts, read pointers, other messages' ordering and the dedupe by `clientId` are unchanged; a double delete or a delete racing with a reply is safe.
4. Permissions are unchanged (author, workspace owner/admin); a cascade can't be used to delete messages the caller couldn't delete one by one. Ruling: an author deleting their own starter may cascade-delete other people's replies, because the starter is the thread's anchor, and the confirmation says how many replies will go.

---

### Task 1: Server: cascade, counters and frames

**Files:** `apps/worker/src/messaging/store.ts` (`deleteMessage`, row/Message loaders), `apps/worker/src/messaging/rows.ts` if needed, `apps/worker/src/hub/WorkspaceHub.ts` (the delete path ~line 462-470 and broadcasting), `packages/protocol/src/ws.ts` and `messaging.ts` only if a new frame or optional field is needed, `apps/server` only if the shim needs changes (it should not), tests in `apps/worker/test` and `packages/protocol/test`.

- [ ] Reply deletion: after marking the reply deleted, update the parent's `reply_count` (never below 0) and `last_reply_at` (the newest `created_at` among the parent's remaining LIVE replies, `NULL` if none), in the same `db.batch` as the delete so the counters can't drift. Recompute from live replies (`SELECT COUNT(*)`/`MAX(created_at)` where `deleted_at IS NULL`) rather than blind arithmetic so a retried or racing delete cannot corrupt the count.
- [ ] Starter deletion: mark ALL live replies of the starter deleted in the same batch (`UPDATE messages SET deleted_at = ?, body = '' WHERE parent_id = ? AND deleted_at IS NULL`), purge their `mentions`, `reactions` and `message_files` rows with set-based statements (`DELETE ... WHERE message_id IN (SELECT id FROM messages WHERE parent_id = ?)`), and set the starter's `reply_count` to 0 and `last_reply_at` to NULL. Return the starter AND the replies that were just deleted so the hub can broadcast each tombstone. Frames per reply are fine up to 500 replies; beyond that, document the limit (clients also drop all replies of a deleted starter locally, see Task 2).
- [ ] Hub: after `deleteMessage`, broadcast `message.delete` for the starter and for each cascaded reply (existing frame, existing audience rules), and for a deleted REPLY also tell clients the parent's new counters. Choose the least invasive wire change: a NEW frame type (for example `thread.counts` with `channelId`, `parentId`, `replyCount`, `lastReplyAt`) that old clients ignore, OR optional fields on `message.delete`. Verify old-client behaviour first (read `apps/web/src/realtime` and `parseHubFrame`; record what you found). The parent `Message` in `catchup` and history responses must carry the corrected counters (they come from the row).
- [ ] Idempotence and races: deleting an already deleted message is `not_found` as today; a reply insert already refuses a deleted parent (store.ts ~96): add a test for that; a reply that landed between the starter check and the cascade is still swept because the cascade statement is set-based on `parent_id`.
- [ ] History endpoints: tombstones keep being returned in message pages (clients need them for seq continuity); do not change page shapes. Confirm a starter's `reply_count` in a page equals its number of live replies.
- [ ] Tests first (red runs recorded): worker tests for reply delete (counters, last_reply_at, double delete, a second reply deleted), starter delete (cascade on all live replies, purge of mentions/reactions/file links, counters zero, other threads untouched, replies by other authors deleted, a third user is refused, an admin can), frames (starter and replies broadcast, counters frame for a reply delete), catch-up after a cascade for a client that missed it (tombstones for starter and replies arrive in `catchup`), protocol schema test for any new frame, and an old-client compatibility test (the existing parser ignores the new frame without throwing).
- [ ] Run `npm test -w apps/worker`, `npm test -w packages/protocol`, `npm test -w apps/server` (one at a time) and tsc for worker/server/protocol. Commit `feat(worker): deleting a thread starter deletes its replies; reply counters stay exact`.

### Task 2: Web: never render deleted messages

**Files:** `apps/web/src/components/MessageList.tsx`, `ThreadPanel.tsx`, `apps/web/src/state/chat.ts`, `apps/web/src/realtime/useChat.ts`, `apps/web/src/pages/Workspace.tsx`, `apps/web/src/search/SearchPanel.tsx` (if it can show a deleted hit), `apps/web/src/styles.css` (remove dead placeholder styles), tests in `apps/web/test`.

- [ ] State keeps tombstones (seq continuity, "deleted wins" merging, dedupe), but a selector used by EVERY renderer filters them out: the channel list, the thread panel (starter and replies), the thread-reply-in-channel rows, message grouping (the "same author within 5 minutes collapses the author line" logic must skip hidden tombstones), scroll anchoring and "jump to message" (jumping to a deleted message shows a clear alert such as "That message was deleted."; decide and test), unread dividers/counts (unchanged), notifications (already skipped for deleted).
- [ ] Remove the placeholder markup and its CSS ("This message was deleted.") and the `deleted` branches that only existed to render it, keeping logic needed for merging.
- [ ] Thread behaviour: when the open thread's starter becomes deleted (frame or local delete), close the thread panel; the reply count shown on the starter row uses the server counters (new frame or optional field from Task 1) and never counts deleted replies; when a starter's tombstone arrives, drop its replies from local state and close the thread; a reply tombstone removes that reply from the open thread and updates the counter; the "N replies" button disappears at zero.
- [ ] Confirmation: Delete on a starter with replies opens the existing `Dialog`: title "Delete this message?", body "This also deletes {n} {reply|replies}. This can't be undone.", buttons "Delete" (destructive) and "Cancel", focus on Cancel, Escape cancels; a message with no replies deletes immediately as before. Errors keep the existing alert path.
- [ ] Reconnect/catch-up: tombstones from `catchup` and history pages remove live copies and render nothing; a client that missed a cascade learns every deleted reply from catch-up.
- [ ] Tests first (red runs recorded): MessageList/ThreadPanel render tests (no placeholder text, grouping after a hidden tombstone, thread closes when the starter is deleted, counters, confirm dialog flows including Cancel, Escape and keyboard-only, no confirm for a plain message), reducer tests (delete frame, counters frame, catch-up with tombstones, cascade), and a regression test that `This message was deleted` appears nowhere in the app source or rendered output. UPDATE existing tests that assert the placeholder text (record which tests changed and why).
- [ ] Run `npm test -w apps/web` and tsc. Commit `feat(web): deleted messages disappear; thread starters confirm before deleting replies`.

### Task 3: End-to-end test, spec and docs

**Files:** `e2e/specs/*.spec.ts` (one new spec), the messages/threads/deletion sections of `docs/superpowers/specs/2026-11-11-backroom-design.md`, README feature list if it mentions deletion.

- [ ] E2E (Playwright, the existing Node-server suite, `npm run e2e`, 8788, console-mailer guard unchanged): user A posts a message and user B sees it; A deletes it and it disappears for both with no placeholder; A posts a thread starter, B and A add replies, B has the thread open; A deletes the starter (the confirm dialog shows the right count, Cancel keeps it, Delete removes it); B's open thread closes and the starter and replies vanish for both; a third context that signs in AFTER the deletion sees none of them. The suite must be green twice in a row.
- [ ] Update the spec: deletion semantics (tombstone retained, content purged, never displayed, starter cascade with confirmation, counters, the new frame or fields, catch-up behaviour) and mention the nightly file cleanup.
- [ ] Run all suites one at a time (`npm test -w apps/worker`, `-w apps/web`, `-w packages/protocol`, `-w apps/server`), tsc, then `npm run e2e` twice. Commit `test(e2e): deleting messages and thread starters; docs`.
