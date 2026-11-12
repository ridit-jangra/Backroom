# Backroom

Backroom is a Slack-style chat app for small communities. It runs entirely on Cloudflare: a Worker serves the API and the React single-page app, and a D1 database stores the data. Sign-in is by emailed magic link; new people join through invite links created by the workspace owner. Phase 1 covers sign-in, the single `clubhack` workspace with its `#general` channel, invites, and the member list. Phase 2 adds real-time messaging and Phase 3 adds emoji and reactions, and Phase 4 adds file uploads and search (see below).

## Prerequisites

- Node 26 and npm (the repo uses npm workspaces; no global installs needed, Wrangler runs via `npx`)
- A free Cloudflare account (to deploy)
- A free Resend account with a verified sending domain (to deploy; not needed locally)

## Local development

```sh
npm install
cp apps/worker/.dev.vars.example apps/worker/.dev.vars   # RESEND_API_KEY=dev, OWNER_EMAIL=you@example.com
cd apps/worker && npx wrangler d1 migrations apply backroom --local && cd ../..
npm run dev:all
```

`.dev.vars` is git-ignored; never commit it. With `RESEND_API_KEY=dev` no email is sent: the sign-in link is printed in the terminal as `Sign-in link for <email>: <url>`. Set `OWNER_EMAIL` to the address you will sign in with; that person becomes the workspace owner.

`npm run dev:all` (run from the repo root) builds the web app and starts `wrangler dev` on http://localhost:8787. `wrangler dev` also runs the `WorkspaceHub` Durable Object locally, so chat works end to end without deploying.

Open the app at the same origin as APP_ORIGIN (http://localhost:8787 by default); other origins are rejected by design.

Safari refuses Secure cookies on http://localhost — use Chrome or Firefox locally.

### Browser walkthrough

1. Open http://localhost:8787 and request a sign-in link for your `OWNER_EMAIL`.
2. Copy the `Sign-in link ...` URL from the terminal, open it, and click "Sign in". You land in `clubhack` with the `#general` channel.
3. Create an invite. In the browser dev tools, copy the value of the `backroom_session` cookie, then run:

   ```sh
   curl -s http://localhost:8787/w/clubhack/invites \
     -H 'Origin: http://localhost:8787' \
     -H 'Content-Type: application/json' \
     -H 'Cookie: backroom_session=<paste cookie value>' \
     -d '{}'
   ```

   The response contains a `url` like `http://localhost:8787/invite/<token>`.
4. Open that URL in a private window, enter a second email, copy the new sign-in link from the terminal, and sign in. Both people now appear in the members list.

## Messaging (Phase 2)

What works:

- Public and private channels, direct messages and group DMs.
- Real-time sending, replies in threads, edits and deletes, `@name` mentions and `@channel` / `@here`.
- Live unread and mention badges, typing indicators and presence, browser notifications (permission is requested only when you click the button), and automatic reconnect with a "Reconnecting..." banner.
- Admins manage invites and members from the web app.
- Reactions arrived in Phase 3, and file uploads and search in Phase 4 (below).

Real time runs over a WebSocket at `GET /ws?workspace=clubhack`. The browser sends its session cookie. Checks run in this order: no valid session gives `401`, then an `Origin` other than `APP_ORIGIN` gives `403`. Each workspace has one `WorkspaceHub` Durable Object that holds the sockets, assigns message sequence numbers and fans out events. Message history, channel and DM management are plain REST routes (`/w/:slug/channels`, `/w/:slug/dms`, `/channels/:id/messages`, `/messages/:id/thread`).

To check it locally without a browser, start `npm run dev:all`, sign in two users as in the walkthrough above, then open the socket with the session cookie:

```sh
curl -s -o /dev/null -w '%{http_code}\n' --max-time 2 \
  -H 'Upgrade: websocket' -H 'Connection: Upgrade' -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  -H 'Origin: http://localhost:8787' -H 'Cookie: backroom_session=<cookie>' \
  'http://localhost:8787/ws?workspace=clubhack'   # 101; with another Origin: 403
```

For the real thing, sign in as two different people in two browser windows (one private) and chat in `#general`.

## Emoji & reactions (Phase 3)

What works:

- Every standard Unicode emoji by its `:shortcode:`, including aliases (`:+1:` and `:thumbsup:`) and skin tones (`:wave::skin-tone-3:`), in messages, an emoji picker, composer autocomplete and reactions. All art is Twemoji, served from Backroom's own origin at `/twemoji/<name>.svg`, never from a CDN.
- Reactions over the existing WebSocket (`react` frame in, `reaction` frame out). Aliases collapse into one reaction; skin tones stay distinct. At most 50 distinct emoji per message. Reacting needs channel membership.
- Custom emoji, added one at a time or by importing a zip in the browser (the server never unzips). Changes reach open tabs as an `emoji.update` frame.

Custom emoji limits:

- PNG, GIF or JPEG only, detected from the file's magic bytes (the filename and declared type are ignored).
- At most 131,072 bytes (128 KB), and 32x32 to 4,096x4,096 pixels.
- Name matches `^[a-z0-9_-]{1,32}$`, is unique per workspace and cannot equal a built-in emoji name or alias.
- At most 2,000 per workspace.
- By default only admins may add them. The owner can allow everyone with `PATCH /w/:slug/settings` and body `{"customEmojiPolicy":"everyone"}` (or `"admins"` to switch back). The creator, an admin or the owner may delete an emoji (`DELETE /emoji/:id`); deleting it also deletes aliases pointing to it.
- Images are served by `GET /emoji/:id` to active workspace members only, with `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox` and long-lived private caching.

Build and deploy notes:

- `npm install` generates the emoji table from `emoji-datasource` into `packages/emoji/src/generated/` (git-ignored); `pretest`, `predev` and `prebuild` hooks regenerate it.
- `npm run build` copies 3,526 Twemoji SVGs into `apps/web/dist/twemoji/`.
- Before the first deploy, create the R2 bucket that stores custom emoji: `npx wrangler r2 bucket create backroom`. The `r2_buckets` binding `BUCKET` in `apps/worker/wrangler.jsonc` already points at it.
- `assets.run_worker_first` must now be `["/auth/*", "/me", "/w/*", "/invites/*", "/health", "/channels/*", "/messages/*", "/emoji/*", "/ws"]`. Twemoji live under `/twemoji/`, which is served from static assets and deliberately does not collide with `/emoji/*`.

Check it locally without a browser (replace `<cookie>` with the `backroom_session` value; use a PNG of at least 32x32):

```sh
curl -s -w '%{http_code}\n' -H 'Origin: http://localhost:8787' -H 'Cookie: backroom_session=<cookie>' \
  -F name=smoke -F image=@smoke.png http://localhost:8787/w/clubhack/emoji          # 201; again 409
curl -sI -H 'Cookie: backroom_session=<cookie>' http://localhost:8787/emoji/<id>   # 200 image/png; no cookie 401
curl -sI http://localhost:8787/twemoji/1f44d.svg                                   # 200 image/svg+xml
```

Attribution: emoji graphics by Twemoji, CC-BY 4.0. Twemoji is from [jdecked/twemoji](https://github.com/jdecked/twemoji); the graphics are licensed under [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/), and the code under MIT. The app shows this notice on its About page (`/about`).

## Files & search (Phase 4)

What works:

- Upload files from the composer (picker, drag-and-drop or paste), with progress, cancel and retry. Up to 10 files per message; a message may be only files. Images get a WebP thumbnail made in the browser; the server never decodes images, runs a transform over upload bytes, or unzips anything.
- Files are shown inline or as a download card, and download only for people who can see the message they are attached to. Deleting a message detaches its files.
- Search the workspace from the top bar: free text, filters, 20 results per page, jump to the message.
- A daily cron deletes files that were uploaded but never attached.

Limits:

| Limit | Value |
|---|---|
| File size | 26,214,400 bytes (25 MB) |
| Workspace storage | 2,147,483,648 bytes (2 GB, sum of file sizes) |
| Thumbnail | at most 524,288 bytes and 720 px on the long side |
| Files per message | 10 |
| File name | 255 code points |
| Unattached upload lifetime | 86,400,000 ms (24 h), then the cron removes it |
| Search query | 256 characters, 16 terms |
| Search page | 20 results; at most offset 480 |

R2 key layout (bucket `BUCKET`):

- original: `ws/<workspaceId>/<fileId>`
- thumbnail: `ws/<workspaceId>/<fileId>-thumb`
- custom emoji (Phase 3): `ws/<workspaceId>/emoji/<id>`

Code that deletes file objects first checks the key against `/^ws\/[0-9A-Z]{26}\/[0-9A-Z]{26}(-thumb)?$/`, which can never match an `emoji/` key, so cleanup and quota never touch emoji. Nothing lists R2 to compute quota or find orphans; both come from D1.

Cleanup cron: `triggers.crons` is `["0 4 * * *"]` (daily, 04:00 UTC). To run it locally:

```sh
cd apps/worker && npx wrangler dev --test-scheduled
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+4+*+*+*"   # use the port wrangler prints; answers "ok"
```

The log shows `orphans_cleaned` with a count. (The older `/__scheduled` path is not in `run_worker_first`, so the static-asset layer answers it with the SPA page; use the `/cdn-cgi/handler/scheduled` path.) Each run is bounded to 10 batches of 100 files.

Search syntax: free text; `"quoted phrases"`; `in:#channel`; `from:@name`; `has:file`; `before:YYYY-MM-DD`; `after:YYYY-MM-DD`. Filters are case-insensitive and a repeated filter keeps the last one. Dates are UTC days. Every term is matched literally, so `OR`, `NEAR(`, `*` and quotes typed by a user are just words, and terms with no letter or digit are ignored. Results come only from messages you can see: public channels and channels or DMs you are in; deleted messages never appear.

Serving rules (`GET /files/:id`, `GET /files/:id/thumb`):

- Always sent with `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: private, max-age=31536000, immutable` and an `ETag` (`If-None-Match` gives `304`). Single `Range` requests give `206`; an unsatisfiable range gives `416`.
- The stored type is decided at upload from magic bytes for PNG, GIF, JPEG, WebP and PDF. Audio and video are taken as declared only if on the whitelist (mp3/mp4/aac/ogg/wav/webm/flac audio; mp4/webm/ogg/quicktime video). A declared image or PDF without matching bytes becomes `application/octet-stream`.
- Inline (`Content-Disposition: inline`, real `Content-Type`) only for PNG, GIF, JPEG, WebP, PDF and the audio/video whitelist. Everything else (HTML, SVG, text, archives) is an `attachment` served as `application/octet-stream`.
- The file name is sent as `filename="<ASCII fallback>"; filename*=UTF-8''<percent-encoded>`.
- PDF and sandbox: the `sandbox` CSP applies to a PDF opened inline, and some browsers' built-in PDF viewers refuse to render sandboxed documents. If a PDF shows blank in your browser, download it instead.

D1 write budget (index entries count as rows written; the free plan allows 100k rows/day): a text message writes about 15 rows, each attached file adds about 3, and an upload writes about 8. That leaves roughly 6k messages/day of headroom.

Troubleshooting: while developing, workerd may print `uncaught` pipe or stream errors when a client aborts a request (a cancelled upload or download). These are expected and harmless.

Deploy notes: `assets.run_worker_first` must now be `["/auth/*", "/me", "/w/*", "/invites/*", "/health", "/channels/*", "/messages/*", "/emoji/*", "/files/*", "/ws"]`, and `wrangler.jsonc` must keep the `triggers.crons` entry. Run `npx wrangler d1 migrations apply backroom --remote` for the new migrations.

## Running tests

```sh
npm test                       # all workspaces
npx tsc -p apps/worker         # type-check the worker
npx tsc -p apps/web            # type-check the web app
```

## Deploying to Cloudflare

1. `npx wrangler login`
2. `npx wrangler d1 create backroom` and paste the printed `database_id` into `apps/worker/wrangler.jsonc`.
3. `npx wrangler d1 migrations apply backroom --remote` (run from `apps/worker`, or pass `-c apps/worker/wrangler.jsonc`).
4. `npx wrangler secret put RESEND_API_KEY` and `npx wrangler secret put OWNER_EMAIL` (same `-c` note applies).
5. In `apps/worker/wrangler.jsonc`, set the `APP_ORIGIN` var to the deployed URL exactly, with no trailing slash (e.g. `https://backroom.example.workers.dev`), and `EMAIL_FROM` to a sender on your Resend-verified domain. Resend will refuse to send from an unverified domain.
6. `npx wrangler r2 bucket create backroom` (the `BUCKET` binding in `wrangler.jsonc`; custom emoji images live there).
7. `npm run build && npx wrangler deploy -c apps/worker/wrangler.jsonc`

The first deploy after Phase 2 creates the `WorkspaceHub` Durable Object class from the `v1` migration tag in `wrangler.jsonc`; do not rename the class or change that tag. The `assets.run_worker_first` list in `wrangler.jsonc` must keep every API prefix so the Worker, not the SPA, answers them: `["/auth/*", "/me", "/w/*", "/invites/*", "/health", "/channels/*", "/messages/*", "/emoji/*", "/files/*", "/ws"]`. (The SPA route `/client/:slug` is served from static assets.)

Do not set `RESEND_API_KEY` to `dev` in production; that value switches to the console mailer.

## Project layout

- `apps/worker` - Cloudflare Worker (Hono API, D1 migrations, tests)
- `apps/web` - React single-page app, built to `apps/web/dist` and served by the Worker as static assets
- `packages/protocol` - shared types and schemas used by both apps
- `packages/emoji` - generated emoji table, shortcode helpers and the Twemoji copy script
- `docs/superpowers` - design spec and implementation plan

## Links

- Spec: [docs/superpowers/specs/2026-11-11-backroom-design.md](docs/superpowers/specs/2026-11-11-backroom-design.md)
- Phase 1 plan: [docs/superpowers/plans/2026-11-11-phase-1-foundation.md](docs/superpowers/plans/2026-11-11-phase-1-foundation.md)
- Phase 2 plan: [docs/superpowers/plans/2026-11-11-phase-2-messaging.md](docs/superpowers/plans/2026-11-11-phase-2-messaging.md)
- Phase 3 plan: [docs/superpowers/plans/2026-11-12-phase-3-emoji.md](docs/superpowers/plans/2026-11-12-phase-3-emoji.md)
- Phase 4 plan: [docs/superpowers/plans/2026-11-12-phase-4-files-search.md](docs/superpowers/plans/2026-11-12-phase-4-files-search.md)
