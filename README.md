# Backroom

Backroom is a Slack-style team chat for small groups (a club, a class, a small team). It is open source (MIT) and self-hosted: you run it on your own server.

What it does:

- Public and private channels, direct messages and group DMs
- Threads, edits, deletes (a deleted message disappears completely, and deleting a thread starter deletes its replies after a confirmation), `@name`, `@channel` and `@here` mentions
- Reactions with every Unicode emoji (by `:shortcode:`, with skin tones) and custom emoji, added one by one or imported from a zip
- File uploads (picker, drag and drop or paste) with image thumbnails, inline previews and ranged downloads
- Full-text search with filters (`in:#channel`, `from:@name`, `has:file`, `before:`/`after:` dates, quoted phrases)
- Live unread and mention badges, typing indicators, presence and notifications
- Sign-in by emailed magic link (no passwords); new people join through invite links from an admin
- A desktop app (Tauri) for Linux, Windows and macOS, with a tray, native notifications, an unread badge and `backroom://` links: see [Desktop app](#desktop-app)

## How it works

- One Node.js process (`apps/server`) serves the REST API, the WebSocket at `/ws` and the web app.
- Data lives in a single SQLite file (with FTS5 for search). Uploaded files live in a folder on disk, next to the database.
- The web app (`apps/web`) is a React single-page app. The desktop app (`apps/desktop`) is a Tauri window that shows your server's web app.
- Sign-in links are emailed through [Resend](https://resend.com). In development the links are printed in the terminal instead.
- A built-in daily job (04:00 server time) removes abandoned uploads and expired sessions, tokens and rate-limit rows.

## You need a server

Backroom is a self-hosted open source project. To use it, or to try it anywhere beyond your own machine, you need a server you control. The [desktop app](#desktop-app) is only a client: it needs a server to talk to and does not replace one.

- a VPS or any Linux machine with **Node.js 26 or newer**,
- a **domain name** pointing at it,
- a **reverse proxy for HTTPS** in front of it (Caddy, nginx, or Cloudflare's proxy or tunnel in front of one of those).

Backroom is a Node.js server, not a serverless app. Cloudflare Workers is not a supported deployment target. The Workers entry point in `apps/worker` exists so the application code can be tested under Cloudflare's runtime (workerd), and the old deployment notes are kept in [docs/DEPLOY.md](docs/DEPLOY.md), marked as unmaintained. Cloudflare's proxy or a Cloudflare Tunnel in front of your own server is fine: see the [self-hosting guide](docs/SELF_HOSTING.md#cloudflare-in-front).

The full guide (install, configuration, reverse proxy examples, systemd, backups, upgrades) is in **[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md)**.

One server runs one workspace. It is shown as "Backroom"; its internal id in URLs is `clubhack`.

## Quick start (local development)

You need Node 26 and npm. Nothing is installed globally.

```sh
git clone https://github.com/ridit-jangra/Backroom.git backroom
cd backroom
npm ci                                   # also generates the emoji table
OWNER_EMAIL=you@example.com npm run dev  # builds the web app and the server, then starts it on port 8080
```

Open http://localhost:8080 and request a sign-in link for the `OWNER_EMAIL` address. That address becomes the workspace owner. (Without `OWNER_EMAIL` it defaults to `owner@localhost`.) Use exactly that origin: requests from other origins are refused by design.

`npm run dev` always uses the console mailer (`RESEND_API_KEY=dev`): no email is sent, and the link is printed in the terminal as

```
Sign-in link for you@example.com: http://localhost:8080/verify?t=...
```

Open it and click "Sign in". To add people, open Admin in the web app, create an invite and send its link. Each person signs in through the link with their own email.

Data goes to `apps/server/data/`. Delete that folder to start over. Stop the server with Ctrl+C; it shuts down gracefully. Other settings can be given the same way (`PORT=8090 npm run dev`; `APP_ORIGIN` follows `PORT` unless you set it). See `apps/server/.env.example`.

What the scripts do:

| Script | What it runs |
|---|---|
| `npm run build` | `npm run build -w apps/web` (to `apps/web/dist`) and `npm run build -w apps/server` (to `apps/server/dist/server.mjs`) |
| `npm run dev` (`dev:all` is the same) | `build`, then `dev:start` |
| `npm run dev:start` | starts the built server with the console mailer, without rebuilding (after a change, rerun `npm run dev`) |
| `npm run dev:worker`, `dev:worker:all` | the old, unmaintained `wrangler dev` loop on port 8787 (Cloudflare's local runtime; no account needed). Not needed for normal development. |

## Desktop app

The desktop app (`apps/desktop`, Tauri 2) opens your Backroom server in a native window. It adds a tray icon, native notifications, an unread badge and `backroom://` links. It is only a client: it needs a [server](#you-need-a-server) to talk to, and it does not include one.

### Install

**Nothing has been released yet.** No release tag has been pushed and no package manager has accepted a package. Everything below describes what a release will contain once the first release is published. Until then, [build it from source](#build-from-source).

#### Download from GitHub Releases

Once the first release is published, the [Releases page](https://github.com/ridit-jangra/Backroom/releases) will list these files (`<v>` is the version, for example `1.0.0`):

| Platform | File | Notes |
|---|---|---|
| Windows | `Backroom_<v>_x64-setup.exe` | installer, installs for your user only (no administrator prompt) |
| Windows | `Backroom_<v>_x64_en-US.msi` | MSI installer |
| macOS (Apple silicon and Intel) | `Backroom_<v>_universal.dmg` | one disk image for both |
| Debian, Ubuntu | `Backroom_<v>_amd64.deb` | `sudo apt install ./Backroom_<v>_amd64.deb` |
| Fedora, openSUSE | `Backroom-<v>-1.x86_64.rpm` | `sudo dnf install ./Backroom-<v>-1.x86_64.rpm` |
| Any Linux | `Backroom_<v>_amd64.AppImage` | run `chmod +x Backroom_<v>_amd64.AppImage`, then start it |
| Arch Linux | `backroom-bin-<v>-1-x86_64.pkg.tar.zst` | `sudo pacman -U backroom-bin-<v>-1-x86_64.pkg.tar.zst` |
| All | `SHA256SUMS` | check a download with `sha256sum -c SHA256SUMS --ignore-missing` (macOS: `shasum -a 256 -c SHA256SUMS --ignore-missing`) |

The Linux files, and the Arch package, are built and checked on a Linux machine. The Windows and macOS file names come from Tauri's documentation and have not been produced yet: the first release run confirms them. Pre-releases (versions such as `1.0.0-beta.1`) have no `.rpm`, `.msi` or Arch package.

#### Package managers

Each of these is **available once the maintainer publishes it**. The manifests are in the repository, but none has been submitted yet, so these commands do not work today. How they are published is described in [packaging/README.md](packaging/README.md).

| Platform | Command |
|---|---|
| Arch Linux (AUR, prebuilt) | `yay -S backroom-bin` |
| Arch Linux (AUR, built from source) | `yay -S backroom` |
| macOS (Homebrew, through the maintainer's tap) | `brew install --cask <maintainer>/backroom/backroom` |
| Windows (Scoop, through the maintainer's bucket) | `scoop bucket add backroom <bucket URL>`, then `scoop install backroom` |
| Windows (winget) | `winget install Ridit.Backroom` |

The tap and bucket names depend on where the maintainer publishes them; the release notes will give the exact commands.

#### First launch: enter your server's address

The app has no server built in. On first launch it shows one field asking for your server's address, for example `https://chat.example.com`. It checks that a Backroom server answers there (it asks `<address>/health`) and remembers the address (in `server.json` in the app's config folder; on Linux `~/.config/app.backroom.desktop/server.json`. On Windows and macOS the file lives in the app's config folder for `app.backroom.desktop`; the exact location is unconfirmed until a release has been built and run on those systems). `https://` is required, except for `localhost`, private network addresses and `.local` names, where plain `http://` is accepted.

To switch servers later, use **Change server…** in the tray menu (or in the window's menu if your desktop has no tray). The app restarts and asks again.

Sign-in uses the same email link as the web app. The link opens in your browser, which hands a one-time code back to the app through a `backroom://` link (PKCE, so an intercepted code is useless).

#### Warnings about unsigned installers

The project has no code-signing certificates, so installers are not signed by a known publisher. Your system will warn you on first run. The checksums in `SHA256SUMS` let you verify what you downloaded.

- **Windows:** SmartScreen shows "Windows protected your PC". Click **More info**, then **Run anyway**. The MSI shows "Unknown publisher".
- **macOS:** the app is ad-hoc signed but not notarized, so Gatekeeper refuses the first launch. Drag Backroom to Applications, then right-click (or Control-click) it, choose **Open**, then **Open** again. On macOS 15 and later use **System Settings → Privacy & Security → Open Anyway**. If macOS says the app is damaged, run this in a terminal and open the app normally:

  ```sh
  xattr -dr com.apple.quarantine /Applications/Backroom.app
  ```

- **Linux:** no warning. The AppImage must be made executable first (`chmod +x`). The `.deb` and `.rpm` are not GPG-signed, so compare them with `SHA256SUMS`.

### Build from source

You need Node 26 and npm (`npm ci` at the repository root), Rust (stable) and, on Linux, the WebKitGTK 4.1 and libsoup 3 development packages plus the usual Tauri libraries. On Debian or Ubuntu:

```sh
sudo apt-get install build-essential pkg-config libssl-dev libgtk-3-dev \
  libwebkit2gtk-4.1-dev libsoup-3.0-dev libayatana-appindicator3-dev librsvg2-dev file
```

```sh
npm run build -w apps/desktop    # runs `tauri build`
```

The packages land in `apps/desktop/src-tauri/target/release/bundle/`. A build for your own platform makes that platform's formats only. `npm run dev -w apps/desktop` runs `tauri dev`.

The result asks for a server address on first launch, like a released build. Packagers can set an optional default at build time with `BACKROOM_APP_URL=https://chat.example.com npm run build -w apps/desktop`: it is used only until the user saves an address. It is not required.

`apps/desktop/scripts/smoke.sh` builds a debug app for `http://localhost:8788`, starts the Node server there with a scratch data folder and the console mailer, and checks that the app loads (under `xvfb-run`, or `--direct` on your display; `--server-only` checks just the server part).

Maintainers: how a release is cut, what the workflow builds and what to check before publishing is in [docs/RELEASING.md](docs/RELEASING.md).

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
| `packaging` | Package-manager manifests for the desktop app (AUR, Homebrew, Scoop, winget). See [packaging/README.md](packaging/README.md). |
| `scripts` | `run-forever.sh` (a supervisor for hosts without systemd), the release and packaging scripts with their tests (`*.test.mjs`), and the old Cloudflare preflight script. |
| `docs` | The self-hosting guide, the release guide, the design spec and the implementation plans. |

## Testing

```sh
npm test                         # test:scripts, then every workspace (the desktop part needs Rust and the GTK libraries)
npm run test:scripts             # only the Node tests for scripts/ (release and packaging scripts)
npm test -w apps/server          # or one workspace: apps/server, apps/worker, apps/web, packages/protocol, packages/emoji, apps/desktop
npx tsc -p apps/server           # type checks: apps/server, apps/worker, apps/web
npm run e2e                      # Playwright end-to-end suite
```

The end-to-end suite builds the web app into `e2e/.tmp/dist` and the server into `e2e/.tmp/server`. It then starts the server on `127.0.0.1:8788` with a fresh data folder and the console mailer, and signs people in with the links the server prints. Locally it uses your installed Chrome. In CI (`CI=1`) it uses Playwright's Chromium (`npx playwright install chromium`).

CI (`.github/workflows/ci.yml`) runs the unit tests, type checks, `cargo clippy` for the desktop app, a check of the packaging manifests and the end-to-end suite. It needs no secrets. The release workflow is described in [docs/RELEASING.md](docs/RELEASING.md).

## Troubleshooting and FAQ

The full list is in [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md#troubleshooting). The common ones:

- **The sign-in email does not arrive.** Check the spam folder. In development (`npm run dev`) no email is sent: the link is printed in the terminal. On a real server, look for `"code":"email_failed"` in the log and check your Resend domain and API key. Only `OWNER_EMAIL` and invited people get a link, and sign-in requests are limited to 5 per hour per address.
- **The desktop app shows the setup screen.** That is expected on first launch and after **Change server…**. Enter your server's address once and it is remembered.
- **"That address does not look like a Backroom server."** The desktop app requests `<address>/health` and expects `{"ok":true}`. Enter the address of Backroom itself (no path), check it with `curl <address>/health`, and use `https://` unless the server is on localhost or a private network.
- **"Reconnecting..." or dropped WebSockets behind a proxy.** The proxy must pass WebSocket upgrades on `/ws`. Proxies in front of the server may close a connection that carries no traffic at all after about 2 minutes. The Backroom apps send a ping every 30 seconds, which keeps a connected app alive; if a connection does drop, the app reconnects automatically.
- **Can the desktop app run without a server?** No. It is a client for a Backroom server that you or someone else runs.

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

- [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md): running Backroom on your server (including troubleshooting)
- [docs/RELEASING.md](docs/RELEASING.md): cutting a desktop release (maintainers)
- [packaging/README.md](packaging/README.md): the package-manager manifests and how to publish them (maintainers)
- [docs/superpowers/specs/2026-11-11-backroom-design.md](docs/superpowers/specs/2026-11-11-backroom-design.md): the design spec (data model, protocol, limits)
- [docs/DEPLOY.md](docs/DEPLOY.md): the unmaintained Cloudflare Workers notes
