# Backroom

Backroom is a Slack-style team chat for small groups (a club, a class, a small team). It is open source (MIT) and self-hosted: you run it on your own server.

What it does:

- Public and private channels, direct messages and group DMs
- Threads, edits, deletes, `@name`, `@channel` and `@here` mentions
- Reactions with every Unicode emoji (by `:shortcode:`, with skin tones) and custom emoji, added one by one or imported from a zip
- File uploads (picker, drag and drop or paste) with image thumbnails, inline previews and ranged downloads
- Full-text search with filters (`in:#channel`, `from:@name`, `has:file`, `before:`/`after:` dates, quoted phrases)
- Live unread and mention badges, typing indicators, presence and browser notifications
- Sign-in by emailed magic link (no passwords); new people join through invite links from an admin
- A Linux desktop app (Tauri) with a tray, native notifications, an unread badge and `backroom://` links

## How it works

- One Node.js process (`apps/server`) serves the REST API, the WebSocket at `/ws` and the web app.
- Data lives in a single SQLite file (with FTS5 for search). Uploaded files live in a folder on disk, next to the database.
- The web app (`apps/web`) is a React single-page app. The desktop app (`apps/desktop`) is a Tauri window around it.
- Sign-in links are emailed through [Resend](https://resend.com). In development the links are printed in the terminal instead.
- A built-in daily job (04:00 server time) removes abandoned uploads and expired sessions, tokens and rate-limit rows.

## You need a server

Backroom is a self-hosted open source project. To use it, or to try it anywhere beyond your own machine, you need a server you control:

- a VPS or any Linux machine with **Node.js 26 or newer**,
- a **domain name** pointing at it,
- a **reverse proxy for HTTPS** in front of it (Caddy, nginx, or Cloudflare's proxy or tunnel in front of one of those).

It is **not** a serverless or Cloudflare app. This repository does not support Cloudflare Workers as a deployment target. The Workers entry point in `apps/worker` exists so the application code can be tested under Cloudflare's runtime (workerd), and the old deployment notes are kept in [docs/DEPLOY.md](docs/DEPLOY.md), marked as unmaintained. You are welcome to adapt it, but it is not maintained here.

The full guide (install, configuration, reverse proxy examples, systemd, backups, upgrades) is in **[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md)**.

One server runs one workspace, named `clubhack` in this version.

## Quick start (local development)

You need Node 26 and npm. Nothing is installed globally.

```sh
git clone <this repository's URL> backroom
cd backroom
npm ci                         # also generates the emoji table
npm run build -w apps/web      # -> apps/web/dist
npm run build -w apps/server   # -> apps/server/dist/server.mjs
APP_ORIGIN=http://localhost:8080 OWNER_EMAIL=you@example.com npm start -w apps/server
```

Open http://localhost:8080 (the same origin as `APP_ORIGIN`; other origins are refused by design) and request a sign-in link for the `OWNER_EMAIL` address. That address becomes the workspace owner.

`RESEND_API_KEY` is not set, so the server uses the console mailer: no email is sent, and the link is printed in the terminal as

```
Sign-in link for you@example.com: http://localhost:8080/verify?t=...
```

Open it and click "Sign in". To add people, open Admin in the web app, create an invite and send its link. Each person signs in through the link with their own email.

Data goes to `apps/server/data/` (the default `DATA_DIR` when started this way). Delete that folder to start over. Stop the server with Ctrl+C; it shuts down gracefully.

For working on the code: rebuild the web app or the server and restart after changes. `npm run dev` still starts the older `wrangler dev` loop on port 8787 (Cloudflare's local runtime; no Cloudflare account needed), which some contributors use for the API.

## Desktop app

Desktop installers: coming soon. Until then, build from source.

`apps/desktop` is a Tauri 2 app (Rust) that opens your Backroom server in a locked-down native window. Linux only for now (`.deb` and AppImage). You need Rust (stable), the WebKitGTK 4.1 and libsoup 3 development packages and the usual Tauri Linux build libraries. On Debian/Ubuntu that is `libwebkit2gtk-4.1-dev libsoup-3.0-dev libayatana-appindicator3-dev librsvg2-dev`.

```sh
BACKROOM_APP_URL=https://chat.example.com npm run build -w apps/desktop
```

`BACKROOM_APP_URL` is compiled in. It must be your server's exact public origin (scheme, host and port, no path, no redirects). The packages land in `apps/desktop/src-tauri/target/release/bundle/`. Sign-in uses the same email link: the link opens in your browser, which hands a one-time code back to the app through a `backroom://` link (PKCE, so an intercepted code is useless).

## Repository layout

| Path | What it is |
|---|---|
| `apps/server` | The Node server: HTTP and WebSocket server, SQLite and filesystem adapters, static files, daily maintenance, backups. Built with esbuild into one file, `dist/server.mjs`. |
| `apps/worker` | The application core: the Hono API, the `WorkspaceHub` real-time hub, auth, files, search, and the SQL migrations. The server bundles this code. It also has a Cloudflare Workers entry point, used to run its test suite under workerd. |
| `apps/web` | The React + Vite single-page app. |
| `apps/desktop` | The Tauri desktop app. |
| `packages/protocol` | Shared types and zod schemas for the REST API and WebSocket frames. |
| `packages/emoji` | The emoji table (generated from `emoji-datasource`), shortcode helpers, and the Twemoji copy script. |
| `e2e` | Playwright end-to-end tests. |
| `scripts` | `run-forever.sh` (a supervisor for hosts without systemd) and the old Cloudflare preflight script. |
| `docs` | The self-hosting guide, the design spec and the implementation plans. |

## Testing

```sh
npm test                         # every workspace (the desktop part needs Rust and the GTK libraries)
npm test -w apps/server          # or one workspace at a time: apps/server, apps/worker, apps/web, packages/protocol
npx tsc -p apps/server           # type checks: apps/server, apps/worker, apps/web
npm run e2e                      # Playwright end-to-end suite
```

The end-to-end suite builds the web app into `e2e/.tmp/dist` and the server into `e2e/.tmp/server`. It then starts the server on `127.0.0.1:8788` with a fresh data folder and the console mailer, and signs people in with the links the server prints. Locally it uses your installed Chrome. In CI (`CI=1`) it uses Playwright's Chromium (`npx playwright install chromium`).

CI (`.github/workflows/ci.yml`) runs the unit tests, type checks, `cargo clippy` for the desktop app, and the end-to-end suite. It needs no secrets.

## Security notes

- Sign-in is by single-use magic link (15 minutes). Sign-in requests are rate limited to 5 per hour per email address and 100 per hour per client IP. Desktop code exchanges are limited to 30 per hour per IP. Over the limit nothing is sent, and the page shows the same message, so it reveals nothing. Each WebSocket may send about 10 frames per second.
- Rate limits use the TCP peer address unless you configure `TRUSTED_PROXY_HEADER`. Only do that when the server can be reached through your proxy alone, otherwise clients can forge the header. See [the guide](docs/SELF_HOSTING.md#security).
- The API checks `Origin` against `APP_ORIGIN`. Cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` when `APP_ORIGIN` is https.
- Uploaded files are served with `nosniff` and a sandboxing Content-Security-Policy. Only images, PDF, audio and video are shown inline; everything else is a download. The server never decodes images or unzips archives (thumbnails and zip imports happen in the browser).
- Logs are JSON lines without message bodies, email addresses, tokens or file keys. The console mailer's sign-in line is the one exception, and it is meant for development only. The server warns at startup when it is used with an https `APP_ORIGIN`.
- The data folder is created with mode 700. Keep your environment file (it holds the Resend key) at mode 600.

## License

MIT, see [LICENSE](LICENSE).

Emoji graphics by Twemoji, CC-BY 4.0. Twemoji is from [jdecked/twemoji](https://github.com/jdecked/twemoji); the graphics are licensed under [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/), and the code under MIT. The app shows this notice on its About page (`/about`). Fonts: Atkinson Hyperlegible and Bricolage Grotesque (SIL Open Font License), self-hosted through `@fontsource`.

## More

- [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md): running Backroom on your server
- [docs/superpowers/specs/2026-11-11-backroom-design.md](docs/superpowers/specs/2026-11-11-backroom-design.md): the design spec (data model, protocol, limits)
- [docs/DEPLOY.md](docs/DEPLOY.md): the unmaintained Cloudflare Workers notes
