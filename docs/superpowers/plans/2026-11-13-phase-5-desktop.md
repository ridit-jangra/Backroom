# Phase 5: Desktop (Tauri 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Linux desktop app for Backroom (Tauri 2) that loads the hosted web app in a locked-down window. It adds native notifications, a tray with unread count, `backroom://` deep links, and a secure magic-link login hand-off from the system browser.

**Architecture:** The Rust shell creates one window that loads the remote `APP_URL`. A capability is granted at runtime to the app origin only; it exposes four app commands and event listening. The web app talks to the shell through `apps/web/src/desktop/bridge.ts`, which does nothing in a normal browser. Desktop login uses a PKCE-style verifier held in Rust and a one-time code exchanged inside the webview, so the session stays an HttpOnly cookie.

**Tech Stack:** Tauri 2 (latest stable 2.x crates and `@tauri-apps/cli`/`@tauri-apps/api` 2.x, versions pinned exactly), Rust 1.99 (system toolchain), WebKitGTK 4.1, the plugins `tauri-plugin-single-instance` (feature `deep-link`), `tauri-plugin-deep-link`, `tauri-plugin-notification` and `tauri-plugin-opener`, the `sha2`/`rand`/`base64` crates, plus the existing Hono worker and React web app.

**Spec:** docs/superpowers/specs/2026-11-11-backroom-design.md (§7 Desktop and §11 revised 2026-11-13 for Tauri; §14 Desktop testing)

## Global Constraints

- npm only, no global installs; Tauri CLI via `@tauri-apps/cli` devDependency in `apps/desktop`.
- Wire compatibility: only optional request/response fields or new endpoints; tabs stay open across deploys.
- Never log message bodies, emails, tokens, desktop codes or verifiers.
- Uniform error shape `{error:{code,message}}`; unknown/forbidden → identical responses.
- The user's dev server occupies port 8787 and serves `apps/web/dist` live: never stop it, never run `vite build` into `apps/web/dist` (build to a scratch `--outDir` if needed). Smoke servers use 8788.
- `BACKROOM_APP_URL` build-time env, default `http://localhost:8787`; app origin = its origin.
- Desktop code: 32 random bytes base64url, TTL 120 000 ms, single use, stored as SHA-256 hex. Verifier: 32 random bytes base64url; challenge = base64url(SHA-256(verifier)) without padding (RFC 7636 S256).
- Notify args: title ≤ 200 chars, body ≤ 1 000 chars (truncate), channelId must match `^[0-9A-Z]{26}$`; badge count clamp 0..=9999.
- No Slack code, branding or assets; app name "Backroom", identifier `app.backroom.desktop`.

## Review Focus

1. Another local app opens `backroom://auth?code=X` with a stolen or attacker code → exchange must fail without the in-memory verifier; no session created.
2. Remote page navigates or `window.open`s to a third-party origin → never loads in the app window; http(s) goes to the system browser, other schemes dropped.
3. A page on another origin (e.g. after a redirect) calls `invoke('notify')` → denied, because the capability's remote URL is exactly the app origin.
4. Second app launch with a deep link → focuses the existing instance and routes the link; no second window.
5. Desktop token used in a plain browser `/verify` → sets no browser cookie (it would otherwise log the browser in with a desktop-only link); verifier reused or code replayed → `400 code_invalid`.

---

### Task 1: Desktop login on the worker (PKCE hand-off)

**Files:**
- Create: `apps/worker/migrations/0006_desktop_auth.sql`
- Modify: `packages/protocol/src/rest.ts`, `apps/worker/src/auth/routes.ts`, `apps/worker/src/middleware/session.ts`
- Test: `apps/worker/test/desktop-auth.test.ts`, `packages/protocol` tests as needed

**Interfaces:**
- Produces: `AuthStartBody` gains optional `desktopChallenge: string` (43 chars, `^[A-Za-z0-9_-]{43}$`); `/auth/verify` response gains optional `desktopCode: string` (present only for desktop tokens; then no cookie is set); new `DesktopExchangeBody = { code: string(10..100), verifier: string(43, base64url) }`; `POST /auth/desktop/exchange` → `{ok:true, workspace}` + session cookie, or `400 code_invalid` "This sign-in code is invalid or expired."

- [ ] **Step 1: Migration.** `ALTER TABLE login_tokens ADD COLUMN desktop_challenge TEXT;` and `CREATE TABLE desktop_codes (code_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, challenge TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);`. No foreign keys (R1).
- [ ] **Step 2: Failing tests** in `desktop-auth.test.ts`:
  - `start with desktopChallenge then verify returns desktopCode and sets no Set-Cookie`
  - `exchange with correct verifier sets backroom_session cookie and returns workspace 'clubhack'`
  - `exchange with wrong verifier → 400 code_invalid, and code is burned (correct verifier afterwards also 400)`
  - `exchange after 120 000 ms → 400 code_invalid` (inject `now`)
  - `replayed code → 400 code_invalid`
  - `non-desktop verify unchanged: cookie set, no desktopCode`
  - `malformed desktopChallenge → 400 invalid_request`
  - `exchange requires same Origin (requireSameOrigin applies)`
  - `cookie has Secure only when APP_ORIGIN starts with https:` (test both)
- [ ] **Step 3: Implement.** Store `desktop_challenge` with the login token (inside the existing off-response-path insert). In verify: if the row has a challenge, run eligibility + `acceptLogin` as today, then insert a `desktop_codes` row and return `{ok:true, workspace, desktopCode}` without creating a session. Exchange: atomically mark the code used (`UPDATE … SET used_at=? WHERE code_hash=? AND used_at IS NULL AND expires_at>? RETURNING user_id, challenge`), then compare `base64url(sha256(verifier))` to the challenge in constant time. On a match create a session and set the cookie; otherwise `400 code_invalid`. Re-check the user is still active in the workspace before creating the session (deactivated → same `400 code_invalid`). `setSessionCookie`/`clearSessionCookie`: `secure: c.env.APP_ORIGIN.startsWith('https:')`.
- [ ] **Step 4: Run** `npm test -w apps/worker` and `npm test -w packages/protocol` → all pass; `npx tsc -p apps/worker` clean.
- [ ] **Step 5: Commit** `feat(worker): desktop login hand-off with PKCE code exchange`.

### Task 2: Web desktop bridge and desktop login pages

**Files:**
- Create: `apps/web/src/desktop/bridge.ts`, `apps/web/src/pages/DesktopAuth.tsx`
- Modify: `apps/web/package.json` (add exact-pinned `@tauri-apps/api` 2.x), `apps/web/src/App.tsx` (route `/desktop-auth`), `pages/Login.tsx`, `pages/Verify.tsx`, `notifications.ts`, `realtime/useChat.ts` or `pages/Workspace.tsx` (badge + navigate wiring)
- Test: `apps/web/test/desktop.test.tsx`

**Interfaces:**
- Consumes: Task 1 endpoints/fields.
- Produces (`bridge.ts`):
  - `isDesktop(): boolean`, true iff `'__TAURI_INTERNALS__' in window`
  - `desktopNotify(n: {title: string; body: string; channelId: string}): Promise<void>`, invoking `notify`
  - `desktopSetBadge(count: number): Promise<void>`, invoking `set_badge`
  - `desktopLoginChallenge(): Promise<string>`, invoking `login_challenge`
  - `onDesktopNavigate(cb: (channelId: string) => void): () => void`, listening to the event `backroom://navigate` with payload `{channelId}`
  - every function is a resolved no-op outside desktop, and errors are swallowed with a `console.warn` of the command name only
- Command names are exactly `notify`, `set_badge`, `platform`, `login_challenge` (Task 4 implements them).

- [ ] **Step 1: Failing tests:**
  - `isDesktop false in jsdom; all bridge calls are no-ops`
  - With `__TAURI_INTERNALS__` mocked (mock `@tauri-apps/api/core` invoke and `@tauri-apps/api/event` listen via `vi.mock`):
    - `Login submits desktopChallenge from login_challenge`
    - `Verify with desktopCode shows "Opening Backroom…" and sets location to backroom://auth?code=<code>` (stub `location.assign`)
    - `Verify without desktopCode navigates to /client/clubhack as before`
    - `/desktop-auth reads code and verifier from the hash, POSTs /auth/desktop/exchange, clears the hash, navigates to /client/clubhack; on 400 shows "This sign-in code is invalid or expired." with a link to /login`
    - `notify frame in desktop calls desktopNotify instead of new Notification`
    - `total unread change calls desktopSetBadge(total)`, where total is the sum of unread over channels the user is a member of, capped by the bridge's clamp
    - `backroom://navigate event navigates to /client/clubhack/<channelId>`
- [ ] **Step 2: Implement.** In `useChat`, the desktop path skips the `viewing` and permission checks except "viewing": desktop notifies whenever the window is not focused on that channel (`document.hasFocus()` and the open channel). `Verify` uses `location.assign` for the custom scheme. `DesktopAuth` reads the fragment only, never the query, and calls `history.replaceState` to drop it before the POST. The notifications permission button is hidden in desktop, because the shell handles permission.
- [ ] **Step 3: Run** `npm test -w apps/web` → all pass; `npx tsc -p apps/web` clean.
- [ ] **Step 4: Commit** `feat(web): desktop bridge, desktop login hand-off pages`.

### Task 3: Tauri shell scaffold with navigation lockdown

**Files:**
- Create: `apps/desktop/package.json` (name `@backroom/desktop`, scripts `dev`, `build`, `test` = `cargo test --manifest-path src-tauri/Cargo.toml`), `apps/desktop/src-tauri/{Cargo.toml,build.rs,tauri.conf.json,src/main.rs,src/lib.rs,src/policy.rs,icons/*}`, `apps/desktop/src-tauri/capabilities/` (empty local default only if Tauri requires one), `apps/desktop/.gitignore` (`src-tauri/target`, `src-tauri/gen`)
- Modify: root `package.json` only if the workspace `test` script would break (Rust build must not run on plain `npm test` unless cargo is present; prefer `test` in desktop to be `cargo test` and keep it, ruling recorded)

**Interfaces:**
- Produces (`policy.rs`, pure, unit-tested):
  - `app_origin(url: &str) -> Result<Url, PolicyError>`: http/https only, no path beyond `/`
  - `nav_decision(target: &Url, origin: &Url) -> Nav`, where `Nav` is `Allow`, `OpenExternal` or `Drop`. Same origin (scheme, host, port) → `Allow`; other http/https → `OpenExternal`; anything else → `Drop`.
  - `parse_deep_link(s: &str) -> Option<DeepLink>`, where `DeepLink` is `Auth { code: String }` or `Channel { id: String }`. Only `backroom://auth?code=<10..100 base64url chars>` and `backroom://channel/<26-char ULID>` are accepted; everything else is `None`.
  - `validate_notify(title, body, channel_id) -> Result<(String, String, String), PolicyError>`: truncates title to 200 and body to 1 000 chars on char boundaries, and enforces the ULID channel id
  - `clamp_badge(i64) -> i64`, clamping to 0..=9999

- [ ] **Step 1:** Scaffold the Tauri 2 app manually; there is no frontend dist, so `frontendDist` points at a minimal `apps/desktop/dist/index.html` placeholder that is never shown in prod. Pin crate versions exactly in Cargo.toml. Window "main" is created in `setup` with `WebviewUrl::External(app_url)`, which comes from `option_env!("BACKROOM_APP_URL")` or the default.
- [ ] **Step 2: Failing `cargo test`s** in `policy.rs` covering each function. Cases include:
  - origin port mismatch → `OpenExternal`
  - `javascript:`, `file:` and `data:` → `Drop`
  - `backroom://auth?code=../x` → `None`
  - an oversized code → `None`
  - a lowercase ULID → `None`
  - a 1 001-char body is truncated to 1 000
  - a multibyte title is truncated without panicking
  - `-5` clamps to 0
  - `10_000_000` clamps to 9999
- [ ] **Step 3: Implement** `policy.rs`. In `lib.rs` wire:
  - `on_navigation`, using `nav_decision`; `OpenExternal` calls the opener plugin `open_url`
  - the new-window handler, which always denies and opens http(s) externally through the same decision
  - window title "Backroom" at 1200×800, minimum 800×560
- [ ] **Step 4: Run** `npm test -w apps/desktop` (cargo test) → pass; `cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml` → success (first build may take minutes; run in background with a long timeout).
- [ ] **Step 5: Commit** `feat(desktop): Tauri 2 shell with origin-locked navigation`.

### Task 4: Commands, capability, notifications, tray, deep links, single instance

**Files:**
- Create: `apps/desktop/src-tauri/src/commands.rs`, `src/auth.rs` (verifier store + challenge), `src/tray.rs`
- Modify: `lib.rs`, `Cargo.toml`, `tauri.conf.json` (deep-link scheme `backroom` under plugins config; bundle identifier)

**Interfaces:**
- Consumes: the Task 2 command names and event name; the Task 3 policy functions.
- Produces:
  - Commands: `notify(title, body, channel_id)`, `set_badge(count)`, `platform() -> String`, `login_challenge() -> String`
  - Event: `backroom://navigate` with payload `{ channelId }`
  - The runtime capability, identifier `remote-app`: `windows: ["main"]`, `remote.urls: [<origin>/*]`, permissions = `core:event:allow-listen`, `core:event:allow-unlisten`, plus `allow-notify`, `allow-set-badge`, `allow-platform` and `allow-login-challenge` (app command permissions generated via `build.rs` `tauri_build::Attributes` / app manifest)
  - `auth.rs`: `login_challenge()` makes a new 32-byte verifier, stores it in managed state (`Mutex<Option<(String, Instant)>>`, valid 20 min, one verifier at a time, replaced on each call) and returns its S256 challenge. `take_verifier() -> Option<String>` returns it at most once and only within 20 min.

- [ ] **Step 1: Failing `cargo test`s:**
  - challenge = base64url(sha256(verifier)), 43 chars
  - `take_verifier` returns `Some` once, then `None`
  - an expired verifier returns `None` (inject the clock via a fn param)
  - a new challenge replaces the old verifier
- [ ] **Step 2: Implement.**
  - Add the capability in `setup` via `app.add_capability(...)`, built from the app origin.
  - Commands validate through `policy.rs`.
  - `notify` shows a native notification titled `title`. On Linux, use notify-rust actions where available (`default` action → show and focus "main", emit `backroom://navigate` to the main window). Fall back to plain notification if actions are unsupported.
  - `set_badge` sets `window.set_badge_count(Some(n))`, or `None` for 0, ignoring unsupported errors, and updates the tray tooltip to "Backroom — N unread" or "Backroom".
  - Tray menu: Show, Quit. Closing the window hides it to the tray; Quit exits.
  - The single-instance plugin is registered first. Its callback shows and focuses "main" and routes any `backroom://` argv entries through the deep-link handler.
  - Deep-link handler (plugin `on_open_url`, plus startup URLs):
    - `Auth{code}` with `take_verifier()` = `Some(v)` → navigate main to `<origin>/desktop-auth#code=<code>&verifier=<v>`
    - `Auth{code}` with no verifier → ignore, logging only `deep_link_no_verifier`
    - `Channel{id}` → emit navigate
    - `None` → ignore
  - In debug builds call `register_all()` for the scheme so dev works.
  - Never log codes or verifiers.
- [ ] **Step 3: Run** `npm test -w apps/desktop` → pass; `cargo build` → success; `cargo clippy -- -D warnings` if clippy is installed (else note it).
- [ ] **Step 4: Commit** `feat(desktop): bridge commands, notifications, tray, deep links, single instance`.

### Task 5: Smoke mode, packaging, README

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs` (smoke), `apps/desktop/package.json`, `README.md` (Desktop section)
- Create: `apps/desktop/scripts/smoke.sh`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Smoke mode.** When `BACKROOM_SMOKE=1`, after the main webview's page-load `Finished` event on a URL whose origin equals the app origin, print `smoke ok <origin>` to stdout and exit 0. If no load finishes within 30 s, exit 1 with `smoke timeout`.
- [ ] **Step 2: `smoke.sh`.** It:
  - starts the worker with `wrangler dev --port 8788 --var APP_ORIGIN:http://localhost:8788 --persist-to <scratch>`
  - waits for `/health`
  - runs the debug desktop binary (built with `BACKROOM_APP_URL=http://localhost:8788`) under `xvfb-run -a` with `BACKROOM_SMOKE=1`
  - asserts `smoke ok http://localhost:8788`
  - kills only its own processes

  If `xvfb-run` is missing, it prints an install hint and exits 2 (ruling recorded; not a failure of the code). Run it.
- [ ] **Step 3: Packaging.** Run `npm run build -w apps/desktop` (= `tauri build --bundles deb,appimage`) with `BACKROOM_APP_URL` unset (localhost default). Record artifact paths and sizes in the report. If AppImage bundling fails for an environment reason (e.g. missing `linuxdeploy` download or FUSE), keep `.deb`, record the error, and add a README note. That is acceptable.
- [ ] **Step 4: README Desktop section:**
  - prerequisites (Rust, WebKitGTK 4.1, libsoup 3, `xvfb` for smoke)
  - `BACKROOM_APP_URL=https://… npm run build -w apps/desktop`
  - installing the `.deb`
  - how desktop sign-in works (browser link → app)
  - security notes: origin lock, capability scope, PKCE
  - troubleshooting: deep links need the installed `.desktop` file; dev uses `register_all`
- [ ] **Step 5: Run** the full suites: `npm test -w apps/worker`, `npm test -w apps/web`, `npm test -w apps/desktop`, protocol and emoji. All pass.
- [ ] **Step 6: Commit** `feat(desktop): smoke mode, Linux packaging, docs`.
