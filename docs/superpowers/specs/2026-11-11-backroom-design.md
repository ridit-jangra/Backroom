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

**Adopted:** a single narrow bridge API (as Tauri capability-scoped commands
since the G4 switch to Tauri); a dedicated magic-link login hand-off. **Not adopted:** custom notification window (native
notifications instead), telemetry. Slack's local caches (LevelDB, Local
Storage, Cookies) were not opened.

## 3. Architecture

*Updated in Phase 7: Backroom runs as a self-hosted Node.js server. The original
Cloudflare design (Worker, Durable Object, D1, KV/R2) is described at the end of
this section as history.*

```
 Browser / Tauri ──HTTPS──▶ reverse proxy (Caddy / nginx / Cloudflare) ──HTTP──▶ Node server (apps/server)
        │                                                                  │  Hono app (apps/worker code)
        └──WebSocket /ws ──────────── same path ──────────────────────────▶│  WorkspaceHub (in-process)
                                                                           ├──▶ SQLite file (node:sqlite, WAL, FTS5)
                                                                           ├──▶ blobs/ folder on local disk
                                                                           └──▶ Resend (magic-link email)
```

| Unit | Responsibility | Depends on |
|---|---|---|
| `apps/web` | React + Vite SPA: sidebar, channel view, threads, composer, emoji picker, search, uploads, admin | REST API, WebSocket protocol |
| `apps/server` | Node 26 HTTP server: static files and SPA fallback, API routing, WebSocket upgrades, trusted client IP, body limits, daily maintenance at 04:00 local time, graceful shutdown, `--maintenance` and `--backup`. Adapters give the worker code what Cloudflare used to: a D1-compatible database over `node:sqlite`, a filesystem `BlobStore`, a Durable Object runtime shim over `ws`. Bundled by esbuild into one file. | `apps/worker` code, SQLite file, `DATA_DIR/blobs`, Resend |
| `apps/worker` | The application core: Hono API (auth, invites, history, search, files, custom emoji, admin), SQL migrations, maintenance job. Also keeps a Workers entry point so its test suite runs under workerd. | Database, blob store, Resend, WorkspaceHub (all injected) |
| `WorkspaceHub` | One instance per workspace, in the server process: holds the sockets; assigns per-channel `seq`; validates and persists writes; fans out events; presence and typing | Database |
| `packages/protocol` | Shared TypeScript types + zod schemas for REST and WS messages | — |
| `packages/emoji` | Shortcode table (from `emoji-datasource`), shortcode parse/render, skin tones | — |
| `apps/desktop` | Tauri 2 shell: locked-down remote window, capability-scoped commands, notifications, tray/badge, deep links, PKCE desktop login | Hosted web app |

There is no Durable Object, R2, KV or Worker in production: one process, one
SQLite file (`DATA_DIR/backroom.sqlite`) and one folder of files
(`DATA_DIR/blobs/`). Only one server may use a data folder at a time
(`server.lock`). Operator documentation: `docs/SELF_HOSTING.md`.

Monorepo with npm workspaces (no global tool installs needed); TypeScript throughout.

**Why one hub per workspace:** ordering and fan-out are trivial and one hub
comfortably serves <50 users. It can be split per channel later without a
data-model change.

**History (Phases 1–6).** The app first ran on Cloudflare: a Worker served the
API and the SPA, a SQLite-backed Durable Object per workspace held hibernatable
sockets, D1 stored the data and Workers KV (with an optional R2 adapter) stored
blobs. That path is kept in `apps/worker` for testing and is unmaintained as a
deployment target (`docs/DEPLOY.md`).

## 4. Data model (SQLite)

*Phase 7: one SQLite file on the server (`node:sqlite` behind a D1-compatible adapter; the schema and migrations
are the ones written for D1 in Phases 1–6, unchanged).*

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
- **Deletes:** a deleted message is never displayed (no placeholder). Soft
  delete keeps a tombstone row (id, channel, `seq`, `parent_id`, timestamps,
  `deleted_at`, empty `body`) because per-channel `seq`, unread math and catch-up
  depend on it; its content is purged in the same batch: body, mentions,
  reactions and `message_files` links (FTS triggers remove it from search).
  Deleting a thread starter deletes all its replies, whoever wrote them, and the
  client asks for confirmation first ("This also deletes n replies"); a reply can
  be deleted by its author or a workspace admin/owner. `reply_count` and
  `last_reply_at` of the starter are recomputed from the live replies in the
  same batch, so they stay exact. Uploaded files of deleted messages are removed
  by the daily orphan cleanup (04:00), not immediately.
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
`stale{channelId}`, `pong{}`, `thread.counts{channelId, parentId, replyCount,
lastReplyAt}` (a starter's counters after one of its replies was deleted, sent
right after that reply's `message.delete`; a starter delete sends a
`message.delete` per tombstone, at most 500 replies, and no counts frame, and
clients also drop every reply of a deleted starter locally). A client that
predates `thread.counts` ignores unknown frame types and only keeps a stale
reply count until its next refetch.

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
deletes and reactions carry no `seq`, and catch-up only returns messages newer
than the client's last `seq`, so a client that was offline during a delete would
keep the message. Therefore on every connect (the first one included) the client
refetches the latest page of the open channel/thread over REST (REST pages are
exact; tombstones in them replace live copies), and after a reconnect the cached
windows of other channels are dropped and refetched when opened. Unread/mention counts are refreshed from `bootstrap`.

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
- `POST /auth/start` rate limits: 5/hour per email, 100/hour per IP (D1
  `rate_limits`). Same response whether or not the address is eligible.
- Eligible to receive a link: existing active member, holder of a valid invite,
  or `OWNER_EMAIL` while the workspace has no owner.
- Login token: 32 random bytes, base64url, 15-minute TTL, single use.
- Session: 32 random bytes; 30-day sliding expiry (renewed when < 15 days left);
  cookie `backroom_session`, `HttpOnly; Secure; SameSite=Lax; Path=/`.
- Desktop (revised 2026-11-13): the in-app login form asks the Rust side for a
  PKCE-style challenge (`login_challenge()` → SHA-256 of a 32-byte verifier
  held only in Rust) and sends it with `POST /auth/start`. The emailed link opens
  in the system browser; `/verify` of a desktop token creates no browser session
  and instead returns a one-time desktop code (32 bytes, 2-minute TTL, stored
  hashed), and the page redirects to `backroom://auth?code=…`. The app then loads
  `<server origin>/desktop-auth#code=…&verifier=…` in its webview, which calls
  `POST /auth/desktop/exchange {code, verifier}`; the server checks
  `sha256(verifier)` against the stored challenge and sets the session cookie in
  the webview. A code injected by another local app fails without the verifier.
- The session cookie's `Secure` attribute is set only when `APP_ORIGIN` is
  https (local http dev in WebKit otherwise drops it).
- Deactivated members: all sessions deleted and sockets closed immediately.

## 8. Files

*Updated in Phase 7 for the Node server.*

- Upload streams the request body to blob storage under the key
  `ws/<workspaceId>/<fileId>`. On the server, blobs are files on local disk in
  `DATA_DIR/blobs/<shard>/` behind the same `BlobStore` interface: bytes stream
  to `blobs/.tmp`, are counted and fsynced, then renamed into place under a
  name that carries a random etag, so data files are immutable; a small JSON
  sidecar `{contentType, size, etag}` is the commit point. Ranges are native
  positioned reads; `If-None-Match` compares the stored etag. Leftover temp
  files are swept at startup.
- Limits are configurable: `FILE_MAX_BYTES` (default 25 MB per file, also the
  largest request body) and `FILES_QUOTA_BYTES` (default 900 MB per workspace
  for all blobs together: originals, thumbnails and custom emoji, tracked as
  `SUM(files.size + files.thumb_size) + SUM(custom_emoji.size)`, checked
  atomically by every upload, thumbnail and emoji insert). The web client
  refuses files over 25 MB on its own.
- Image dimensions read from headers on upload. Thumbnails (max 720 px, WebP)
  are generated in the browser and uploaded alongside the original.
- Download checks the user can see a message referencing the file (or is the
  uploader of a not-yet-posted file). Inline `Content-Disposition` only for
  images (except SVG), PDF, audio and video; everything else, including HTML and
  SVG, is forced to `attachment`. Always `X-Content-Type-Options: nosniff` and a
  restrictive `Content-Security-Policy: sandbox` on file responses.
- Orphaned uploads (never attached to a message) are deleted after 24 h by the
  daily maintenance job, at most 200 blob deletes per run; the rest wait for
  the next run.
- Backups: `--backup <dir>` snapshots the database (online backup, verified
  with `PRAGMA integrity_check`) and mirrors `blobs/` incrementally.

**Historical (Cloudflare, Phases 4–6).** Blobs lived in Workers KV (free
without a payment card), with an R2 adapter used only when `BLOBS` was not
bound. KV has no range or conditional reads, so its adapter stored the metadata
on each value, served `Range` by streaming from the start and slicing, and
answered `If-None-Match` from the stored etag. KV's daily limits (1k writes and
1k deletes) led to `503 storage_busy`, the 200-deletes-per-run cap and the
200-custom-emoji-uploads-per-day limit (the latter two are still in the code).
KV's eventual consistency led to `503 blob_pending` with `Retry-After: 5`, which
the web client retries; the filesystem store is strongly consistent, so on
the server it only appears if a blob file has gone missing. The 25 MB file limit came from KV's 25 MiB value limit.

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
  CPU limit. At most 200 custom emoji image uploads per workspace per UTC day
  (each is a KV write; aliases are free), so imports leave about 800 of KV's
  1k daily writes for files: over it, `429 emoji_daily_limit` ("Custom emoji
  limit reached for today. Try again tomorrow."). The importer stops at the
  first 429 or 503 and says how many were imported and how many remain.

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

*Revised 2026-11-13 (user decision G4): Tauri 2 replaces Electron.*

- Tauri 2 (Rust + system WebKitGTK 4.1 on Linux); Linux bundles `.deb` and
  AppImage via `tauri build`. `@tauri-apps/cli` is a dev dependency (no global
  installs).
- Server address (revised 2026-11-15, Phase 8, P8-R1): chosen at runtime, so
  one released build works with any self-hosted server. Stored in
  `server.json` in the app config dir (Linux `~/.config/app.backroom.desktop/`;
  dir 0700, file 0600, written atomically) as `{"serverUrl": "<origin>"}`.
  Precedence at startup: a valid stored origin, then the optional build-time
  default `BACKROOM_APP_URL` (only when there is no `server.json` at all; used
  by smoke tests and distro builds), then the bundled setup page. A file that
  is unreadable, oversized, malformed or holds a refused address is never
  trusted: the app shows the setup page.
- Address rules (Rust, `config::normalize_server_url`; the page's own checks
  count for nothing): trimmed, `https://` added when no scheme is given, http or
  https only, no credentials, no path other than `/`, no query or fragment, no
  port 0, at most 263 characters; host lowercased and punycoded, default port
  dropped; a domain host must be dot-separated LDH labels (letters, digits,
  hyphens) and not `*.localhost`; IPv4 and IPv6 literals are accepted. The
  result is a bare origin, and only after its capability URL pattern (host
  escaped for URLPattern syntax, e.g. `http://[\:\:1]:8787/*`) parses and
  matches exactly that origin. The same rules (`src/origin.rs`) run in
  `build.rs`, so a refused `BACKROOM_APP_URL` fails the build (and is logged as
  `build_default_refused` if it ever reaches runtime). Plain http is accepted only
  for `localhost`, loopback, RFC 1918 addresses and `.local` names, and the page
  then warns that traffic is not encrypted and asks for a second Connect.
- Setup page (`apps/desktop/dist/`, served from the app's own origin
  `tauri://localhost`, or `http(s)://tauri.localhost` on Windows; each platform
  accepts only its own spelling): one field,
  Connect, an inline error (`role="alert"`), light/dark, no external resources,
  its own CSP. It calls `check_server(url) -> {origin, insecure}` (normalises,
  then `GET <origin>/health` from Rust: 5 s timeout, no redirects, 1 KiB body
  cap, User-Agent `Backroom-Desktop/<version>`, TLS verified against the OS
  trust store like the webview, expects HTTP 200 and exactly `{"ok":true}`;
  unreachable, timeout, untrusted certificate, other TLS failure, redirect,
  unhealthy status and "not a Backroom server" each get their own message) and `save_server(url)` (normalises again, saves, adds the remote
  capability for that origin, then navigates the main window there from Rust;
  once per process). Both are granted only by the static LOCAL capability
  `capabilities/setup-page.json` (main window, app origin, no remote URLs).
- "Change server…" (tray menu; macOS app menu; a small window menu bar when
  Linux has no tray host, so it works even when the remote page is broken)
  writes `{"serverUrl": null}` and restarts the app. Tauri cannot remove a
  runtime capability, so the restart is what revokes the old origin: its
  capability and all in-memory state (page, pending verifier, pending
  navigation) die with the process. Persistent WebKit storage for the old
  origin (cookies including its session, localStorage, cache) stays in the
  app's data directory and is used again if the user later returns to that
  server. The new process shows the setup page, even when a build-time
  default exists.
- Main window is created in Rust and loads the server origin (or the setup
  page). Navigation lockdown (origin read from managed state on every
  request): `on_navigation` allows only the server origin; any other http(s)
  URL opens in the default browser and is denied in-app; new-window requests
  are denied in-app and opened in the default browser. No other schemes load.
  While the setup page shows, only the app's own origin loads, nothing opens
  in the browser and no viewer opens; deep links are ignored (an auth link
  keeps its verifier).
- Remote-page IPC is granted by a capability added at runtime whose `remote.urls`
  is exactly the server origin, permitting only the app's own commands plus
  event listening (never the setup commands). The web app reaches them through
  `apps/web/src/desktop/bridge.ts` (`@tauri-apps/api`), and is a no-op outside
  the desktop app.
- Commands: `notify({title, body, channelId})`, `set_badge(count)`,
  `platform()`, `login_challenge()`, `take_pending_navigation()`. Command
  arguments are validated in Rust (lengths, ULID channel ids, count bounds).
- `take_pending_navigation() -> channelId | null` (Phase 6, P5-R9): Rust keeps
  the last `backroom://channel/<id>` link (cold start or while running) in a
  one-slot store with a 60 s TTL; a newer link replaces an older one, and the id
  is re-validated as a ULID. The command returns the id at most once. Every
  channel link is both stored and emitted live as `backroom://navigate`; the
  page pulls once right after subscribing (covers a cold start) and drains the
  slot when a live event arrives. A duplicate only reopens the same channel.
- Native notifications (via the notification plugin / notify-rust); clicking
  focuses the window and emits `backroom://navigate` with the channel id. Tray
  icon with Show/Quit menu and unread count in the tooltip; window badge count
  where the desktop supports it. Closing the main window hides it to the tray.
  At startup (Linux) a D-Bus probe with a 500 ms timeout checks the session bus
  for an owner of `org.kde.StatusNotifierWatcher`; with no tray host (or no
  session bus) closing the main window quits the app instead, and
  `tray_unavailable` is logged.
- Single-instance plugin (with deep-link forwarding); `backroom://` scheme via
  the deep-link plugin. Deep links route to the auth hand-off or channel
  navigation; anything else is ignored.
- Session: the normal `backroom_session` cookie inside the webview's persistent
  data store (the token is never exposed to JS or written by Rust).
- Not adopted from the Electron design: fuses (no Node runtime exists), preload
  scripts (replaced by capabilities), `safeStorage`/Bearer storage (replaced by
  the webview cookie).

## 12. Error handling and logging

- API: typed errors `{error: {code, message}}`; UI shows toasts for
  user-actionable errors and inline states for load failures.
- Realtime: nack/retry/backoff/stale-refetch as in §5.
- Uploads: failures keep the draft and offer retry; quota errors state the
  limit.
- Email: Resend errors or daily cap → "couldn't send email, try later" for the
  user and a banner in the admin view.
- Capacity: there are no platform daily limits on the Node server; overload
  shows up as slow responses, and `MAX_CONNECTIONS` drops new connections past
  the cap. (Historical: on Cloudflare's free tier, requests failed until the
  00:00 UTC reset and the client showed "Backroom is over its daily limit" on
  error 1027.)
- Logs: structured JSON lines on stdout (`time, level, code, …fields`), one per
  event, collected by systemd's journal or the supervisor's log file; error
  details are the error class and errno code only. No access log (sign-in URLs
  carry tokens). Never log message bodies, emails, tokens or blob keys; the
  console mailer's development-only sign-in line is the one exception.

## 13. Capacity

*Updated in Phase 7.* There is no platform quota any more: capacity is bounded
by the server's hardware. One Node process with one SQLite connection handles
every request; writes are synchronous and fsynced (`synchronous=FULL`), so they
are serialised, which is ample for a team of a few dozen people on a small VPS.
Disk holds the database and the files (900 MB per workspace by default,
`FILES_QUOTA_BYTES`). `MAX_CONNECTIONS` (default 2048) caps open connections,
WebSockets included. Email volume is bounded by the Resend plan (the free tier
allows about 100 emails a day; only sign-in links are sent).

**Historical note.** On the Cloudflare free tier (verified 2026-11-11) the
budget was: Worker requests 100k/day, 10 ms CPU per request, Durable Object
requests 100k/day (incoming WebSocket messages billed 20:1), D1 100k rows
written and 5M read per day, 5 GB D1/DO storage, Workers KV 1 GB stored with
1k writes and 1k deletes a day (about 500 image messages a day), and 20,000
static asset files. Those limits shaped some rules that remain in the code
(the custom emoji daily upload cap, the orphan cleanup cap per run).

## 14. Testing

- **Unit (Vitest):** shortcode parse/render, mention extraction, search query
  parser/escaping, permission helpers, seq/dedupe logic.
- **Integration (`@cloudflare/vitest-pool-workers`, local Worker + DO + D1 +
  KV + R2; the file and emoji suites run once per blob backend):** magic-link flow and rate limits; invite-only eligibility; session
  expiry; seq ordering under concurrent sends; clientId dedupe; reconnect
  catch-up and `stale`; private channel and DM isolation (messages, search,
  files); file disposition headers; custom emoji validation.
- **E2E (Playwright):** two users sign in via captured magic links, chat,
  thread, react, upload, search; a third user is denied a private channel.
- **Desktop:** `cargo test` for the pure Rust logic (origin allowlist, deep-link
  parsing, argument validation, PKCE); a smoke mode (`BACKROOM_SMOKE=1`) that
  launches under `xvfb-run`, loads the app URL, and exits 0 after the page load
  finishes on the allowed origin.
- **CI:** GitHub Actions on push.

## 15. Deployment

*Updated in Phase 7: self-hosted.*

- Target: a Linux machine the operator controls, with Node 26+, a domain and a
  reverse proxy for HTTPS (Caddy, nginx, or Cloudflare's proxy/tunnel in front
  of one). Cloudflare Workers is not a supported target.
- Build: `npm ci`, `npm run build -w apps/web`, `npm run build -w apps/server`
  (one bundle, `apps/server/dist/server.mjs`, plus `dist/migrations/`; no
  `node_modules` at runtime).
- Configuration by environment: `APP_ORIGIN`, `OWNER_EMAIL`, `RESEND_API_KEY`,
  `EMAIL_FROM`, `DATA_DIR`, `PORT`, `HOST`, `TRUSTED_PROXY_HEADER`,
  `TRUSTED_PROXY_SECRET`, `WEB_DIST`, `FILES_QUOTA_BYTES`, `FILE_MAX_BYTES`,
  `KEEP_ALIVE_TIMEOUT_MS`, `MAX_CONNECTIONS`. Unset `RESEND_API_KEY` selects the
  console mailer (development only).
- Migrations (the same `apps/worker/migrations/*.sql`, tracked in a
  wrangler-compatible `d1_migrations` table) are applied at startup; the seed
  migration creates `clubhack`.
- Supervision: systemd (example unit in `docs/SELF_HOSTING.md`) or
  `scripts/run-forever.sh` where there is no systemd. SIGTERM shuts down
  gracefully.
- Backups: `node server.mjs --backup <dir> --keep 7` from cron.
- Operator prerequisites: a server, a domain, and a free Resend account with a
  verified sending domain (Resend requires a domain to email arbitrary
  recipients).
- Historical: Phases 1–6 deployed with `wrangler` (Worker, SQLite-class Durable
  Object, D1, KV namespace `BLOBS`, static assets, Cron Trigger); see
  `docs/DEPLOY.md` (unmaintained).

## 16. Phases

1. **Foundation:** monorepo, protocol package, D1 schema + seed, auth (magic
   link, sessions, invites), bootstrap endpoint, minimal web shell.
2. **Messaging:** WorkspaceHub, send/edit/delete, history, channels/DMs,
   threads, unread, mentions, presence/typing, reconnect.
3. **Emoji & reactions:** emoji package, rendering, picker, reactions, custom
   emoji + bulk import.
4. **Files & search:** uploads/thumbnails/downloads, FTS search UI.
5. **Desktop:** Tauri 2 shell, bridge, notifications, tray/badge, deep links,
   desktop login hand-off, Linux packaging.
6. **Hardening & deploy:** E2E suite, CI, deployment docs, first deploy.
