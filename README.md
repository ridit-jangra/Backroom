# Backroom

Backroom is a Slack-style chat app for small communities. It runs entirely on Cloudflare: a Worker serves the API and the React single-page app, and a D1 database stores the data. Sign-in is by emailed magic link; new people join through invite links created by the workspace owner. Phase 1 covers sign-in, the single `clubhack` workspace with its `#general` channel, invites, and the member list. Phase 2 adds real-time messaging (see below).

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
- Not in this phase: reactions, file uploads and search.

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
6. `npm run build && npx wrangler deploy -c apps/worker/wrangler.jsonc`

The first deploy after Phase 2 creates the `WorkspaceHub` Durable Object class from the `v1` migration tag in `wrangler.jsonc`; do not rename the class or change that tag. The `assets.run_worker_first` list in `wrangler.jsonc` must keep every API prefix so the Worker, not the SPA, answers them: `["/auth/*", "/me", "/w/*", "/invites/*", "/health", "/channels/*", "/messages/*", "/ws"]`. (The SPA route `/client/:slug` is served from static assets.)

Do not set `RESEND_API_KEY` to `dev` in production; that value switches to the console mailer.

## Project layout

- `apps/worker` - Cloudflare Worker (Hono API, D1 migrations, tests)
- `apps/web` - React single-page app, built to `apps/web/dist` and served by the Worker as static assets
- `packages/protocol` - shared types and schemas used by both apps
- `docs/superpowers` - design spec and implementation plan

## Links

- Spec: [docs/superpowers/specs/2026-11-11-backroom-design.md](docs/superpowers/specs/2026-11-11-backroom-design.md)
- Phase 1 plan: [docs/superpowers/plans/2026-11-11-phase-1-foundation.md](docs/superpowers/plans/2026-11-11-phase-1-foundation.md)
- Phase 2 plan: [docs/superpowers/plans/2026-11-11-phase-2-messaging.md](docs/superpowers/plans/2026-11-11-phase-2-messaging.md)
