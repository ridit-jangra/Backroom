# Backroom — Design Spec

- **Date:** 2026-11-11
- **Status:** Draft for review
- **First workspace:** `clubhack`

## 1. Purpose and success criteria

Backroom is a self-hosted, Slack-style team chat that a small group (under 50
people) uses day to day. It is an original application: it reuses no Slack code,
name, logo, sounds or proprietary emoji artwork. It reproduces familiar
*features and conventions* (channels, threads, `:shortcode:` emoji, reactions,
mentions), not Slack's implementation.

**v1 is done when:**

1. A member invited to `clubhack` can sign in with an email magic link on the web
   app and on the Linux desktop app.
2. Members can chat in real time in public/private channels, DMs and group DMs,
   with threads, edits, deletes, mentions, unread counts and typing indicators.
3. Every standard Unicode emoji is available by its common `:shortcode:` in
   messages, the picker and reactions; admins can add custom emoji (singly or by
   bulk zip import).
4. Members can upload files/images (previewed inline) and full-text search
   messages they are allowed to see.
5. The desktop app shows OS notifications and an unread badge.
6. Messages and files survive restarts and redeploys.
7. The whole system runs on free tiers (Cloudflare Workers Free, Resend Free).

**Non-goals for v1 (later phases):** voice/video calls and huddles, canvases,
workflows, bots/apps/integrations, mobile apps, email/push notifications to
offline users, Windows/macOS desktop builds, desktop auto-update, message
retention policies, SSO, multi-workspace switching UI (the data model supports
multiple workspaces; the UI ships with one).

## 2. Research input: Slack desktop (REA study)

A static REA analysis of the locally installed Slack desktop
(`/usr/lib/slack`, `slack-desktop` 4.53.276) informed the desktop design only.
Findings (static, partial coverage — minified bundles, dynamic IPC channel names):

- The package is a hardened Electron shell; the messaging client and data model
  are served by Slack's servers and are **not** in the package, so Backroom's
  server and database design is independent.
- Electron fuses: RunAsNode, NODE_OPTIONS and `--inspect` disabled;
  OnlyLoadAppFromAsar and cookie encryption enabled.
- Separate purpose-built preloads per window type (main client, child windows,
  magic-login window, embedded components), each exposing a narrow
  `contextBridge` API (e.g. `desktop.accessibility.toggleCaretBrowsing`,
  `slackPlatform.isWayland`).
- OS notification-state checks (Focus Assist / macOS notification state) before
  notifying; a dedicated notifications window; Sentry telemetry.

**Adopted:** equivalent fuse hardening; a single narrow preload API; a dedicated
magic-link login hand-off. **Not adopted:** custom notification window (native
notifications instead), telemetry. Slack's local caches (LevelDB, Local
Storage, Cookies) were not opened.

## 3. Architecture

```
 Browser / Electron ──HTTPS──▶ Worker (Hono router) ──▶ D1 (SQLite + FTS5)
        │                         │      │
        └──WebSocket──────────────┘      ├──▶ R2 (files, custom emoji, thumbnails)
                                  ▼      └──▶ Resend (magic-link email)
                      Durable Object: WorkspaceHub
                      (one per workspace: sockets, ordering, fan-out)
```

| Unit | Responsibility | Depends on |
|---|---|---|
| `apps/web` | React + Vite SPA: sidebar, channel view, threads, composer, emoji picker, search, uploads, admin | REST API, WebSocket protocol |
| `apps/worker` | Hono API: auth, invites, history, search, files, custom emoji, admin; serves SPA static assets; routes WS upgrades | D1, R2, Resend, WorkspaceHub |
| `WorkspaceHub` (Durable Object, SQLite-backed) | Holds hibernatable sockets for one workspace; assigns per-channel `seq`; validates and persists writes to D1; fans out events; presence and typing | D1 |
| `packages/protocol` | Shared TypeScript types + zod schemas for REST and WS messages | — |
| `packages/emoji` | Shortcode table (from `emoji-datasource`), shortcode parse/render, skin tones | — |
| `apps/desktop` | Electron shell: hardened window, preload bridge, notifications, tray/badge, deep links, keychain session | Hosted web app |

Monorepo with npm workspaces (no global tool installs needed); TypeScript throughout.

**Why one hub per workspace:** ordering and fan-out are trivial and one Durable
Object comfortably serves <50 users. It can be split per channel later without a
data-model change.

## 4. Data model (D1)

IDs are ULIDs (TEXT). Timestamps are INTEGER epoch milliseconds. Token columns
store SHA-256 hashes only.

```sql
users(id PK, email UNIQUE NOT NULL, display_name, avatar_key, created_at)
workspaces(id PK, slug UNIQUE, name, settings_json, created_at)
workspace_members(workspace_id, user_id, role CHECK(role IN ('owner','admin','member')),
                  joined_at, deactivated_at, PRIMARY KEY(workspace_id,user_id))
invites(id PK, workspace_id, token_hash UNIQUE, created_by, expires_at, max_uses, uses)
login_tokens(token_hash PK, email, invite_id NULL, expires_at, used_at NULL)
sessions(token_hash PK, user_id, created_at, expires_at, user_agent)
login_codes(code_hash PK, user_id, expires_at, used_at NULL) -- desktop hand-off; session created on exchange
rate_limits(key PK, window_start, count)

channels(id PK, workspace_id, name NULL, kind CHECK(kind IN ('public','private','dm')),
         topic, dm_key NULL, last_seq INTEGER DEFAULT 0, created_by, created_at, archived_at NULL,
         UNIQUE(workspace_id,name), UNIQUE(workspace_id,dm_key))
channel_members(channel_id, user_id, last_read_seq INTEGER DEFAULT 0,
                notify CHECK(notify IN ('all','mentions','none')) DEFAULT 'mentions',
                joined_at, PRIMARY KEY(channel_id,user_id))
messages(id PK, channel_id, seq INTEGER, user_id, parent_id NULL, body TEXT,
         also_in_channel INTEGER DEFAULT 0, created_at, edited_at NULL, deleted_at NULL,
         reply_count INTEGER DEFAULT 0, last_reply_at NULL, UNIQUE(channel_id,seq))
thread_follows(message_id, user_id, last_read_reply_seq INTEGER DEFAULT 0,
               PRIMARY KEY(message_id,user_id))
mentions(message_id, user_id NULL, kind CHECK(kind IN ('user','channel','here')))
reactions(message_id, user_id, emoji, created_at, PRIMARY KEY(message_id,user_id,emoji))
custom_emoji(id PK, workspace_id, name, r2_key NULL, alias_for NULL, created_by, created_at,
             UNIQUE(workspace_id,name))
files(id PK, workspace_id, uploader_id, r2_key, thumb_key NULL, name, mime, size,
      width NULL, height NULL, created_at)
message_files(message_id, file_id, PRIMARY KEY(message_id,file_id))
messages_fts  -- FTS5(body, content='messages', content_rowid='rowid'), kept in sync by triggers
files_fts     -- FTS5(name, content='files')
```

Rules:

- **DMs:** a `dm` channel whose `dm_key` is the sorted, comma-joined member IDs;
  opening a DM with the same people always returns the same channel.
- **`seq`:** assigned only by the hub; strictly increasing per channel. Every
  message has one, including thread replies.
- **Threads:** replies have `parent_id`. They do not increment channel unread
  counts unless `also_in_channel = 1`. Posting or replying auto-follows.
- **Deletes:** soft delete sets `deleted_at` and clears `body`; the row stays as
  a "message deleted" placeholder so threads stay intact. FTS triggers remove it
  from search.
- **Unread:** count of top-level (or `also_in_channel`) messages with
  `seq > last_read_seq`. Mention badge: `mentions` rows for the user (or
  `channel`/`here`) on messages with `seq > last_read_seq`.
- **Seed:** migration creates workspace `clubhack` with `#general` and
  `#random`. The env var `OWNER_EMAIL` designates who becomes owner on first
  sign-in; every member auto-joins `#general`.

## 5. Real-time protocol (WebSocket)

All frames are JSON `{t: <type>, ...}` validated with zod in `packages/protocol`.

**Connect:** `GET /ws?workspace=<slug>` → Worker validates session (cookie on
web, `Authorization: Bearer` on desktop) and membership, checks `Origin`, then
forwards to the workspace hub. The hub accepts with hibernation and attaches
`{userId, channelIds}` to the socket (serialized attachment, survives
hibernation).

**Client → hub:** `hello{lastSeen}`, `send{clientId, channelId, parentId?, body,
fileIds?, alsoInChannel?}`, `edit{messageId, body}`, `delete{messageId}`,
`react{messageId, emoji, on}`, `mark_read{channelId, seq}`,
`mark_thread_read{messageId, seq}`, `typing{channelId, parentId?}`,
`activity{}`, `ping{}`.

**Hub → client:** `ack{clientId, message}`, `nack{clientId, code}`,
`message.new`, `message.edit`, `message.delete`, `reaction`, `read{channelId,
seq}` (to the same user's other sockets), `channel.update`,
`membership{added|removed}`, `emoji.update`, `presence{userId, state}`,
`typing{channelId, userId, parentId?}`, `notify{...}`, `catchup{...}`,
`stale{channelId}`, `pong{}`.

**Send path:** validate membership, body ≤ 40,000 chars, file ownership →
`seq = last_seq + 1` → parse mentions → one D1 `batch()` (insert message,
mentions, message_files, update `channels.last_seq`, parent `reply_count`,
thread follows) → broadcast `message.new` to channel members' sockets → `ack`
the sender. On D1 failure: `nack`, `seq` not consumed. The hub keeps a short
in-memory map of recent `clientId`s per user and returns the original `ack` for
duplicates.

**Client resilience:** optimistic "sending…" state; resend with the same
`clientId` after 10 s without ack; reconnect with exponential backoff
(1 s → 30 s, jitter) and "Reconnecting…" banner; on reconnect send `hello`.
The hub replays missed *messages* by `seq` (up to 200 per channel, read from
D1); beyond that it sends `stale` and the client refetches via REST. Edits,
deletes and reactions carry no `seq`, so after any reconnect the client also
refetches the latest page of the open channel/thread, and other channels
refresh when opened. Unread/mention counts are refreshed from `bootstrap`.

**Presence/typing:** in-memory only. Active if any socket had `activity`
within 10 min. Typing throttled client-side to one per 3 s, expires after 5 s.

**Notifications:** hub emits `notify` only to the target user's sockets for:
direct mentions, `@channel`/`@here` (respecting `notify = none`), every DM
message, and replies in followed threads. The client suppresses it if that
channel is open and focused; otherwise shows a browser Notification (web) or
calls the desktop bridge. Offline users get nothing in v1.

**Throttles to protect free quota:** `mark_read` at most 1/s per socket and
only when `seq` advances; typing never touches D1; presence never touches D1.

## 6. REST API (Worker)

| Method & path | Purpose |
|---|---|
| `POST /auth/start` | `{email, inviteToken?}` → always 200 "check your email" |
| `POST /auth/verify` | `{token}` → consume token → session cookie (or, when started from desktop, a one-time `code` for `backroom://auth?code=`). The emailed link opens the SPA page `/verify?t=…`, which shows a "Sign in" button that makes this POST, so link scanners that prefetch URLs cannot consume the token. |
| `POST /auth/desktop/exchange` | `{code}` → session token (one-time, 2 min TTL) |
| `POST /auth/logout`, `POST /auth/logout-all` | end session(s) |
| `GET /me`, `PATCH /me` | profile (display name, avatar) |
| `GET /w/:slug/bootstrap` | workspace, my channels + unread/mention counts, members, custom emoji |
| `GET /w/:slug/channels`, `POST` | list/browse public channels; create channel |
| `PATCH /channels/:id`, `POST /channels/:id/join`, `/leave`, `/members` | channel settings, membership |
| `POST /w/:slug/dms` | `{userIds}` → open or get DM/group DM |
| `GET /channels/:id/messages?before=&after=&limit=` | history paging by `seq` |
| `GET /messages/:id/thread` | parent + replies |
| `GET /w/:slug/search?q=` | message search with filters |
| `POST /w/:slug/files`, `GET /files/:id`, `GET /files/:id/thumb` | upload / download |
| `GET /w/:slug/emoji`, `POST`, `DELETE /emoji/:id` | custom emoji |
| `POST /w/:slug/invites`, `GET`, `DELETE /invites/:id` | admin invites |
| `PATCH /w/:slug/members/:userId` | admin: role, deactivate |

Errors: `{error: {code, message}}` with an appropriate HTTP status. All
state-changing requests require a matching `Origin`.

## 7. Auth

- Magic-link email via Resend, from a domain the operator verifies in Resend.
- `POST /auth/start` rate limits: 5/hour per email, 20/hour per IP (D1
  `rate_limits`). Same response whether or not the address is eligible.
- Eligible to receive a link: existing active member, holder of a valid invite,
  or `OWNER_EMAIL` while the workspace has no owner.
- Login token: 32 random bytes, base64url, 15-minute TTL, single use.
- Session: 32 random bytes; 30-day sliding expiry (renewed when < 15 days left);
  cookie `backroom_session`, `HttpOnly; Secure; SameSite=Lax; Path=/`.
- Desktop: login starts from the app, which opens the system browser to
  `/login?desktop=1`; verification redirects to `backroom://auth?code=…`; the
  app exchanges the code for a session token and stores it with Electron
  `safeStorage`, sending it as a Bearer token.
- Deactivated members: all sessions deleted and sockets closed immediately.

## 8. Files

- Upload streams the request body to R2 at `ws/<workspaceId>/<fileId>`.
  Limits: 25 MB per file, 2 GB per workspace (tracked by summing `files.size`).
- Image dimensions read from headers on upload. Thumbnails (max 720 px, WebP)
  are generated in the browser and uploaded alongside the original.
- Download checks the user can see a message referencing the file (or is the
  uploader of a not-yet-posted file). Inline `Content-Disposition` only for
  images (except SVG), PDF, audio and video; everything else, including HTML and
  SVG, is forced to `attachment`. Always `X-Content-Type-Options: nosniff` and a
  restrictive `Content-Security-Policy: sandbox` on file responses.
- Orphaned uploads (never attached to a message) are deleted after 24 h by a
  daily Cron Trigger.

## 9. Emoji

- **Data:** `emoji-datasource` (MIT) for the Unicode emoji list, categories and
  shortcodes including aliases such as `:+1:`/`:thumbsup:`; skin tones as
  `:wave::skin-tone-3:`.
- **Art:** Twemoji SVGs (graphics CC-BY 4.0), bundled as static assets
  (~3,700 files, under the 20,000-file limit). Attribution appears in the
  app's About page.
- **Storage:** messages and reactions store shortcodes/text, never images.
- **Picker:** search, categories, frequently used (per user, localStorage),
  skin-tone preference, Custom tab.
- **Custom emoji:** PNG/GIF/JPEG ≤ 128 KB, ≥ 32×32; names `^[a-z0-9_-]{1,32}$`,
  unique per workspace and not colliding with built-ins; aliases allowed; who may
  add is a workspace setting (admins only by default). Deleting one makes
  existing uses render as `:name:` text.
- **Bulk import:** the browser unzips an archive of `name.ext` images (e.g. an
  export from another workspace) and uploads each through the normal endpoint,
  showing per-file results. Done client-side to stay within the Worker's 10 ms
  CPU limit.

## 10. Search

- `messages_fts` with `bm25` ranking plus a small recency boost; `snippet()`
  highlights; 20 results/page.
- Results are always joined against channels the user is a member of, or public
  channels in the workspace.
- Query syntax: free text plus `in:#channel`, `from:@user`, `has:file`,
  `before:YYYY-MM-DD`, `after:YYYY-MM-DD`. User text is escaped into FTS5
  phrase terms so FTS operators cannot be injected.
- `files_fts` matches file names for `has:file` / file-name searches.

## 11. Desktop app (`apps/desktop`)

- Electron, Linux builds (AppImage, `.deb`) via `electron-builder`.
- Fuses via `@electron/fuses`: RunAsNode off, NODE_OPTIONS off, CLI inspect off,
  OnlyLoadAppFromAsar on, cookie encryption on, embedded ASAR integrity on
  (effective on Windows/macOS later).
- Main window: loads `APP_URL`; `contextIsolation: true`, `sandbox: true`,
  `nodeIntegration: false`; `will-navigate`/`setWindowOpenHandler` restrict to
  the app origin and open everything else in the default browser; permission
  handler grants only `notifications`.
- Preload exposes `window.backroomDesktop`:
  `notify({title, body, channelId})`, `setBadge(count)`,
  `onNavigate(cb)`, `getPlatform()`. IPC uses fixed literal channel names; the
  main process verifies `event.senderFrame.origin === APP_ORIGIN`.
- Native `Notification`; click focuses the window and sends `navigate` to the
  channel. Tray icon with unread count; `app.setBadgeCount` where supported.
- Single-instance lock; `backroom://` protocol registered; deep links route to
  auth hand-off or channel navigation.

## 12. Error handling and logging

- API: typed errors `{error: {code, message}}`; UI shows toasts for
  user-actionable errors and inline states for load failures.
- Realtime: nack/retry/backoff/stale-refetch as in §5.
- Uploads: failures keep the draft and offer retry; quota errors state the
  limit.
- Email: Resend errors or daily cap → "couldn't send email, try later" for the
  user and a banner in the admin view.
- Free-tier exhaustion (Workers/DO/D1 daily limits) → requests fail until
  00:00 UTC reset; the client shows "Backroom is over its daily limit" when it
  sees Cloudflare error 1027 / quota failures.
- Logs: structured JSON via Workers Logs; never log message bodies, emails in
  full, or tokens.

## 13. Free-tier budget (verified 2026-11-11 against Cloudflare docs)

| Resource (Free) | Limit | Backroom usage estimate (50 users) |
|---|---|---|
| Worker requests | 100k/day | page loads, history, search, uploads — a few thousand/day |
| Worker CPU | 10 ms/request | no heavy work server-side (thumbnails and zip import are client-side) |
| Request body | 100 MB | uploads capped at 25 MB |
| DO requests | 100k/day; incoming WS messages billed 20:1, outgoing free | ~2k–10k/day |
| D1 rows written | 100k/day | ~5–10 rows per message incl. FTS → ~10k messages/day headroom |
| D1 rows read | 5M/day | ample |
| D1 / DO storage | 5 GB total | text is small |
| R2 | 10 GB storage free | capped at 2 GB/workspace |
| Static assets | 20,000 files, 25 MiB/file | ~3,700 emoji SVGs + app bundle |
| Resend | free tier (~100 emails/day) | magic links only |

If usage grows past these, the upgrade path is the Workers Paid plan ($5/month)
with no code changes.

## 14. Testing

- **Unit (Vitest):** shortcode parse/render, mention extraction, search query
  parser/escaping, permission helpers, seq/dedupe logic.
- **Integration (`@cloudflare/vitest-pool-workers`, local Worker + DO + D1 +
  R2):** magic-link flow and rate limits; invite-only eligibility; session
  expiry; seq ordering under concurrent sends; clientId dedupe; reconnect
  catch-up and `stale`; private channel and DM isolation (messages, search,
  files); file disposition headers; custom emoji validation.
- **E2E (Playwright):** two users sign in via captured magic links, chat,
  thread, react, upload, search; a third user is denied a private channel.
- **Desktop smoke (Playwright `_electron`):** launches, bridge present, notify
  and badge calls reach main, deep-link routing, navigation lockdown.
- **CI:** GitHub Actions on push.

## 15. Deployment

- `wrangler.toml` defines the Worker, `WorkspaceHub` DO (SQLite class),
  D1 binding, R2 bucket, static assets, Cron Trigger.
- Secrets: `RESEND_API_KEY`, `OWNER_EMAIL`, `APP_ORIGIN`, `EMAIL_FROM`.
- `wrangler d1 migrations apply` for schema; seed migration creates `clubhack`.
- Default URL `https://backroom.<account>.workers.dev`; custom domain optional.
- Operator prerequisites: free Cloudflare account; free Resend account with a
  verified sending domain (Resend requires a domain to email arbitrary
  recipients).

## 16. Phases

1. **Foundation:** monorepo, protocol package, D1 schema + seed, auth (magic
   link, sessions, invites), bootstrap endpoint, minimal web shell.
2. **Messaging:** WorkspaceHub, send/edit/delete, history, channels/DMs,
   threads, unread, mentions, presence/typing, reconnect.
3. **Emoji & reactions:** emoji package, rendering, picker, reactions, custom
   emoji + bulk import.
4. **Files & search:** uploads/thumbnails/downloads, FTS search UI.
5. **Desktop:** Electron shell, bridge, notifications, tray/badge, deep links,
   Linux packaging.
6. **Hardening & deploy:** E2E suite, CI, deployment docs, first deploy.
