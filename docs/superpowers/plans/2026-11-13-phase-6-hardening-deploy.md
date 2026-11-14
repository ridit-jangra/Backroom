# Phase 6: Hardening & Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the backlog deferred from Phases 1–5 and UI polish, add the end-to-end suite and CI that spec §14 asks for, and make the first Cloudflare deploy a short, documented, operator-run procedure.

**Architecture:** The changes are small and isolated:
- worker hardening: cron cleanup, rate limits, frame budgets, logout headers, an email-failure signal
- one web feature: code spans and blocks
- one desktop command plus tray detection
- a Playwright E2E suite run against `wrangler dev` with the console mailer
- a GitHub Actions workflow
- a deploy guide plus a preflight script

**Tech Stack:** existing stack; `@playwright/test` (exact pin, using the system Chrome channel locally and Playwright Chromium in CI).

**Spec:** docs/superpowers/specs/2026-11-11-backroom-design.md (§12 error handling, §13 budget, §14 testing, §15 deployment, §11 desktop).

## Global Constraints

- Wire compatibility: only optional fields and new frame/error codes.
- Never log message bodies, emails, tokens, codes or verifiers.
- The user's dev server occupies port 8787 and serves `apps/web/dist`. Never stop it, and never build into `apps/web/dist`.
- `apps/worker/.dev.vars` holds the user's REAL Resend key. Every `wrangler dev` an agent starts must pass `--var RESEND_API_KEY:dev`. Smoke and E2E use port 8788.
- No remote Cloudflare commands (`--remote`, `deploy`, `d1 create`, `r2 bucket create`, `secret put`). Task 6 only writes the procedure; the operator runs it with the controller afterwards.
- Production values: `EMAIL_FROM` = `Backroom <backroom@ridit.space>` (already set). `APP_ORIGIN` comes from the deploy guide.

## Review Focus

1. A burst of frames from one socket (reactions, sends) is throttled with a nack, without delaying other users' sends in the same channel.
2. Cleanup cron deletes only expired or used auth rows and rate-limit windows, never live ones; it also leaves R2 `emoji/` objects alone (Phase 2 R2 note).
3. Code spans don't break mentions, links or emoji outside the code, and nothing inside code is turned into a mention, link or emoji.
4. E2E runs green from a clean state twice in a row (no leftover state between runs).
5. The deploy guide works from a fresh Cloudflare account in order, and nothing in it needs secrets committed.

---

### Task 1: Worker hardening

**Files:**
- `apps/worker/src/files/cleanup.ts`, or a new `src/maintenance.ts` called from the existing cron
- `auth/routes.ts`
- `hub/*` (frame budget)
- `search/search.ts`
- a new migration `0007_ops.sql`
- `pages/Admin.tsx` (banner)
- tests

- [ ] **Cron cleanup.** Run it daily inside the existing `0 4 * * *` handler. Delete:
  - `login_tokens` where `expires_at < now − 86 400 000` or `used_at IS NOT NULL AND used_at < now − 86 400 000`
  - the same rule for `desktop_codes`
  - `rate_limits` windows older than 2 h

  Test with seeded live and expired rows.
- [ ] **Rate limit on `/auth/desktop/exchange`.** 30 per hour per IP via `hitRateLimit`. Over the limit returns `429 rate_limited` "Too many attempts. Try again later." Test it.
- [ ] **Logout headers.** `/auth/logout` and `/auth/logout-all` add `Clear-Site-Data: "cache", "storage"`. Test it.
- [ ] **Per-socket frame budget in WorkspaceHub.** Use a token bucket per socket of 10 frames/s with a burst of 20, counting `send`, `edit`, `delete`, `react` and `typing` (typing counts as 0.2). Over budget:
  - the hub replies `nack {code: 'rate_limited'}` for frames that carry a clientId
  - frames without a clientId are silently dropped
  - nothing else is processed

  Store the budget in the socket attachment so it survives hibernation. Web: `rate_limited` nack shows "You're sending too fast. Wait a moment." on the pending message, using the existing nack UI path. Test both sides, including that a second socket in the same channel is unaffected.
- [ ] **Search cost (P4-R24).** Cap a query at 8 terms and 200 characters. Extra terms are ignored and listed in the response as optional `ignoredTerms`. Test it.
- [ ] **Email-failure signal (R11).** Migration `0007_ops.sql` adds `CREATE TABLE ops_events (kind TEXT PRIMARY KEY, at INTEGER NOT NULL)`. On a mailer failure, upsert `('email_failed', now)`. The admin bootstrap/admin endpoint returns optional `emailFailedAt`. If that is within 24 h, the Admin page shows a `role="alert"` banner: "Sign-in emails failed recently. Check the Resend API key and sending domain." Test it.
- [ ] Run `npm test -w apps/worker`, `npm test -w apps/web` and tsc. Commit `feat(worker): phase 6 hardening (cleanup, budgets, logout headers, email-failure signal)`.

### Task 2: Code spans and blocks in messages (UP-R4)

**Files:** `apps/web/src/text/tokenize.ts`, `components/MessageText.tsx`, `notifications.ts` (plain text), tests.

- [ ] Add tokens `{kind:'code', text}` for single-backtick spans on one line and `{kind:'codeblock', text}` for a triple-backtick fence, with an optional language word after the opening fence that is ignored. Code wins over every other token: nothing inside code becomes a link, mention, broadcast or emoji. An unclosed fence is plain text.
- [ ] Render `code` as `<code>` and `codeblock` as `<pre><code>`, using the existing UI-polish CSS (`--wash`, mono stack, horizontal scroll inside the block). Notifications show the code text without backticks.
- [ ] Mention extraction on the server: if mentions are parsed server-side (check `apps/worker` for the mention extractor), apply the same rule so `@` inside code doesn't notify. Share the logic through packages/protocol if both sides parse. Add tests on both sides.
- [ ] Tests:
  - `` `@x` `` is not a mention
  - `` `http://a` `` is not a link
  - `:smile:` inside code is not an emoji
  - an unclosed fence stays plain text
  - multiple spans on one line
  - a fence with a language word
- [ ] Run the tests and tsc. Commit `feat(web): code spans and blocks in messages`.

### Task 3: Desktop: pending navigation and tray detection

**Files:** `apps/desktop/src-tauri/src/{commands.rs,lib.rs,tray.rs}`, `apps/web/src/desktop/bridge.ts`, tests, spec §11 (add the command line).

- [ ] **P5-R9.**
  - Rust keeps the last `backroom://channel/<id>` from a cold start or a deep link in managed state (one slot, TTL 60 s).
  - New command `take_pending_navigation() -> Option<String>`, granted in the runtime capability (`allow-take-pending-navigation`). It goes through `require_main` and returns the id at most once.
  - `onDesktopNavigate` calls it once right after subscribing and invokes the callback if it returns an id.
  - Add cargo tests: the slot is taken once, it expires, and a newer link replaces an older one. Add a web test.
- [ ] **M5.** At startup, check D-Bus for `org.kde.StatusNotifierWatcher` (zbus is already in the dependency tree via the plugins; pin it if added directly). If there is no tray host:
  - closing the main window quits the app instead of hiding it
  - log `tray_unavailable`
  - the README notes it

  Factor the decision into a pure function and test it.
- [ ] Update spec §11's command list with `take_pending_navigation()`.
- [ ] Run cargo test, clippy `-D warnings`, the web tests and `cargo build`. Commit `feat(desktop): pending navigation pull and tray-host detection`.

### Task 4: End-to-end suite (spec §14)

**Files:** `e2e/` at the repo root (`playwright.config.ts`, `global-setup.ts`, `specs/*.spec.ts`), root `package.json` script `"e2e": "playwright test -c e2e"`, `@playwright/test` exact-pinned devDependency.

- [ ] **Global setup:**
  - build the web app to `e2e/.tmp/dist`
  - start `wrangler dev --port 8788 --assets e2e/.tmp/dist --var APP_ORIGIN:http://localhost:8788 --var RESEND_API_KEY:dev --var OWNER_EMAIL:owner@e2e.test --persist-to e2e/.tmp/state` after `rm -rf e2e/.tmp/state` and applying migrations locally to that persist dir
  - wait for `/health`
  - provide a helper `magicLink(email)` that reads the newest `/verify?t=` link for that email from the wrangler stdout buffer (the console mailer prints it)

  Teardown kills the server. Locally use `channel: 'chrome'`, and Playwright's chromium when `process.env.CI` is set.
- [ ] **Specs:**
  - The owner signs in and creates an invite.
  - User B signs in through the invite.
  - In #general: the two send messages in both directions in real time, open a thread and reply, add a reaction, upload a small PNG (the thumbnail appears) and a text file, and search finds a message and jumps to it.
  - The owner creates a private channel.
  - A third user C, invited, can't see it in the browser and gets a 404 on direct navigation to its URL.
  - A signed-out visit to `/` lands on `/login`. This is the regression for the root-redirect bug.
- [ ] Run `npm run e2e` twice from a clean checkout state. Both runs must be green. Commit `test(e2e): playwright suite against wrangler dev`.

### Task 5: CI workflow

**Files:** `.github/workflows/ci.yml`, README CI line.

- [ ] Triggered by `push` and `pull_request`. Job `test` on `ubuntu-24.04`:
  - `actions/setup-node` with Node 26 and npm cache
  - `npm ci`
  - install the Tauri Linux deps (`libwebkit2gtk-4.1-dev libsoup-3.0-dev libayatana-appindicator3-dev librsvg2-dev`)
  - `dtolnay/rust-toolchain@stable`
  - `Swatinem/rust-cache` for `apps/desktop/src-tauri`
  - `npm test`
  - `npx tsc -p apps/web`
  - `npx tsc -p apps/worker`
  - `cargo clippy -- -D warnings` in apps/desktop/src-tauri

  Job `e2e`, needing `test`: `npx playwright install --with-deps chromium`, then `npm run e2e`.
- [ ] Pin every action to a full commit SHA, with a version comment. Look them up with `gh api` or `git ls-remote` if network is available; otherwise use the version tag and record a ruling. Validate with `actionlint` if available (via `npx` or the binary), else with a YAML parse.
- [ ] Commit `ci: github actions for unit, desktop and e2e suites`.

### Task 6: Deploy guide and preflight

**Files:** `docs/DEPLOY.md`, `scripts/deploy-preflight.sh`, README link.

- [ ] **`docs/DEPLOY.md`.** Write it as an operator procedure, numbered because it is a sequence:
  1. `npx wrangler login` and `whoami`
  2. `npx wrangler d1 create backroom`, then paste the `database_id` into `apps/worker/wrangler.jsonc`
  3. `npx wrangler r2 bucket create backroom`
  4. Choose the URL: `https://backroom.<subdomain>.workers.dev`, or a custom domain such as `chat.ridit.space`. Set `APP_ORIGIN` in `wrangler.jsonc` vars to that exact final origin.
  5. Secrets: `npx wrangler secret put RESEND_API_KEY` and `npx wrangler secret put OWNER_EMAIL`
  6. Confirm `EMAIL_FROM` is on the verified Resend domain
  7. `npx wrangler d1 migrations apply DB --remote`
  8. `npm run build` (web), then `npx wrangler deploy` from apps/worker
  9. First sign-in as `OWNER_EMAIL`, then create invites
  10. Desktop: `BACKROOM_APP_URL=<origin> npm run build -w apps/desktop`

  Add rollback (`wrangler rollback`), free-tier limits (§13), and troubleshooting:
  - email not arriving → Resend dashboard and the admin banner
  - 1027 → daily limit
- [ ] **`scripts/deploy-preflight.sh`.** Read-only checks:
  - `database_id` is not the placeholder
  - `APP_ORIGIN` is https and not localhost
  - `EMAIL_FROM` is set
  - `wrangler whoami` succeeds
  - the web build exists
  - all suites pass

  It prints a checklist and exits non-zero on any failure. It never runs remote mutations.
- [ ] Commit `docs: deploy guide and preflight script`.

### Task 7: Card-free blob storage (Workers KV backend) — added 2026-11-14

Why: enabling R2 requires a payment card on file, and the user declined ("i don't wanna put my card"). Spec constraint is free tier only. Workers KV is free without a card (1 GB storage, 25 MiB per value, 100k reads/day, 1k writes/day, 1k deletes/day).

**Files:** `apps/worker/src/lib/blobs.ts` (new), `src/files/{store,routes,cleanup}.ts`, `src/emoji/{custom,routes}.ts`, `src/env.ts`, `wrangler.jsonc`, `vitest.config.ts`, tests, spec §8/§9/§13/§15, README, `docs/DEPLOY.md` (Task 6 consumes this).

- [ ] Add `BlobStore` in `lib/blobs.ts` and `getBlobStore(env)` returning the KV adapter when `env.BLOBS` is bound, else the R2 adapter over `env.BUCKET`:
  - `put(key, body, {contentType, size})`
  - `get(key, {range?, ifNoneMatch?})` → `{body, size, etag, contentType, range?, notModified}` or `null`
  - `delete(keys)` (the KV adapter loops, since KV has no batch delete)
  - `peek(key, length)` for the sniff bytes
- [ ] KV adapter details:
  - Store the value with metadata `{contentType, size, etag}`. Generate the etag as a random id at put time (never hash the bytes: a 25 MB hash would break the 10 ms CPU limit).
  - `put` needs a known length: use the request's Content-Length, and keep the existing 25 MB limit and early 413 behaviour.
  - Emulate `range` by slicing the stream (offset/length) and emulate `If-None-Match` by comparing against the stored etag.
  - Map a KV daily-limit error (HTTP 429 / "limit exceeded") to the existing error shape with `503 storage_busy` "Storage is at its daily write limit. Try again tomorrow." and a test with a fake namespace.
- [ ] Replace every direct `env.BUCKET` use (13 references, listed via `grep -rn BUCKET apps/worker/src`) with the BlobStore. Behaviour, headers, nosniff and CSP sandbox, Range/206 and 304 handling must be unchanged for existing tests.
- [ ] Config: add a `kv_namespaces` binding `BLOBS` to `wrangler.jsonc` (id placeholder `<set at deploy>`) and REMOVE the `r2_buckets` entry, because an R2 binding makes deploy fail while R2 is disabled. Keep the `BUCKET` binding only in the vitest miniflare bindings so the R2 adapter keeps its tests, and run the whole suite once with each backend (parametrised).
- [ ] Workspace quota: lower the per-workspace file quota from 2 GB to 900 MB (KV total is 1 GB and emoji share it). Update the quota constant, its tests, spec §8 and §13 (R2 row replaced by a KV row with the limits above), §15 (KV namespace instead of an R2 bucket) and the README.
- [ ] Cron cleanup deletes orphan keys one by one and stops after 200 deletes per run (KV has 1k deletes/day), leaving the rest for the next run. Test the cap.
- [ ] Re-run the E2E suite (Task 4) green twice. Commit `feat(worker): Workers KV blob store backend (no card required)`.
