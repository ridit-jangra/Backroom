# Phase 7: Self-hosted Node server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Backroom on an ordinary Linux server (Node, SQLite on disk, files on disk) instead of Cloudflare, reusing the existing application code, then move the live instance to the user's own server.

**Architecture:** A new `apps/server` package starts a Node HTTP server around the existing Hono app and `WorkspaceHub` class from `apps/worker/src`. Platform pieces that Cloudflare used to provide are replaced by small adapters:
- a D1-compatible database over `node:sqlite`
- a filesystem blob store
- a Durable Object runtime shim (hibernation-free) over the `ws` library
- an in-process cron

The worker package stays as the tested application core (its workerd test suite keeps validating the business logic). Cloudflare deployment becomes an unmaintained path, documented as such.

**Tech Stack:** Node 26 (`node:sqlite`, SQLite 3.54 with FTS5), `@hono/node-server`, `ws`, `esbuild` (bundling, with `cloudflare:workers` aliased to the shim), existing Hono 4 / zod 4. Exact-pinned versions.

**Spec:** docs/superpowers/specs/2026-11-11-backroom-design.md (§3 architecture, §8 files, §13 budget, §15 deployment are rewritten in Task 4).

## Global Constraints

- npm only. Exact-pinned dependencies. Add as few as possible: `@hono/node-server`, `ws`, `esbuild`.
- Application behaviour, wire protocol, REST API, headers and security rules do not change (Phases 1–6 rulings still bind). Only the platform layer is new.
- No SQL migration changes: the server applies the same `apps/worker/migrations/*.sql` files, tracked in a `d1_migrations` table compatible with wrangler's.
- Never log message bodies, emails, tokens, codes, verifiers or blob keys.
- Real email must never be sent during tests or development: tests and the dev server use `RESEND_API_KEY=dev` (console mailer). apps/worker/.dev.vars holds the user's real Resend key: never read or print it.
- The client IP used by rate limits comes ONLY from a trusted source: the server strips any incoming `CF-Connecting-IP`, then sets it from the socket address, or from the configured trusted proxy header (`TRUSTED_PROXY_HEADER`, default none).
- No remote or production actions from any task except Task 5 and only with the user's go-ahead. The user's dev server on port 8787 and the Cloudflare deployment must not be touched by Tasks 1–4. Ports for any test servers: 8790+.
- The user's server (reached over ssh) is shared with other users: only touch the Backroom account's home folder; never read shell histories; Node 26 already lives in `~/node`.

## Review Focus

1. The D1 adapter matches D1 semantics where the app depends on them: `batch` is atomic (all or nothing), `run().meta.changes` counts only the statement's own rows (not FTS trigger rows), `first()` returns null on no rows, `RETURNING` works, bound `null`/`undefined`/number/string/ArrayBuffer values, 100-variable limits are unchanged.
2. WebSocket lifecycle on Node: a message/close/error on one socket never kills the process; a socket closing during a send does not throw; `getWebSockets()` returns only open sockets; alarms fire once and re-arm correctly; per-socket attachments survive for the connection's life.
3. Trusted client IP: a client cannot spoof `CF-Connecting-IP` or `X-Forwarded-For` into the rate limiter.
4. Graceful shutdown and crash safety: SIGTERM finishes in-flight writes, closes sockets with 1001, checkpoints the WAL; killing the process mid-write loses nothing committed.
5. Static serving: SPA fallback only for GET navigations to non-API paths, correct content types and `Cache-Control`, the `_headers` rules applied, no path traversal, and API 404s stay JSON.

---

### Task 1: Node platform adapters (database, migrations, blob store)

**Files:**
- Create: `apps/server/package.json`, `tsconfig.json`, `src/platform/d1.ts`, `src/platform/migrate.ts`, `src/platform/fs-blobs.ts`, `test/*.test.ts`
- Modify: `apps/worker/src/lib/blobs.ts` (add the filesystem adapter option and its selection), `apps/worker/src/env.ts`, root `package.json` workspaces if needed

**Interfaces:**
- Produces: `createD1(path: string): D1Database` (the subset the app uses: `prepare().bind().first()/all()/run()/raw()`, `batch()`, `exec()`, returning D1-shaped results `{results, success, meta:{changes,last_row_id,duration,rows_read,rows_written}}`); `applyMigrations(db, dir): Promise<string[]>`; `createFsBlobStore(dir: string): BlobStore` implementing the existing `BlobStore` interface from `apps/worker/src/lib/blobs.ts` (put/get/delete/peek, native range, etag from a stored sidecar, atomic writes via temp file + rename, keys validated and sharded, no path traversal); `getBlobStore(env)` also accepts an injected `env.BLOB_STORE`.

- [ ] Write the failing tests first (Node vitest project in apps/server, no Workers runtime). The adapter tests replay real app SQL: apply all migrations to a fresh database, run representative statements from the worker (FTS search with `bm25`/`snippet`, `json_each` lookups, conditional inserts with `RETURNING`, the quota expression), and prove `batch` rolls back on failure, `changes` ignores trigger rows, and the 100-variable chunking limit still behaves.
- [ ] Implement the D1 adapter over one `DatabaseSync` connection (WAL, `busy_timeout`, `foreign_keys` left off as in migrations). Convert bound values the way D1 does. Wrap sync calls in promises. Serialize `batch` inside a transaction.
- [ ] Implement `applyMigrations` reading the `.sql` files in name order, recording them in `d1_migrations(id, name, applied_at)`, idempotent, each file in a transaction, and refusing to continue on failure.
- [ ] Implement the filesystem blob store with the exact `BlobStore` semantics already covered by `apps/worker/test` blob tests: reuse those test cases by parametrising them for a third backend where practical (range shapes, 416, 304, short body errors, delete missing key is fine). Keys are validated by the existing key regexes.
- [ ] Run `npm test -w apps/server` and the worker, web and protocol suites; tsc clean. Commit `feat(server): node platform adapters (sqlite D1, migrations, filesystem blobs)`.

### Task 2: Durable Object runtime shim and hub integration

**Files:**
- Create: `apps/server/src/platform/do-runtime.ts`, `apps/server/src/platform/cloudflare-workers-shim.ts`, tests
- Modify: `apps/worker/src/hub/WorkspaceHub.ts` and `hub/ws-route.ts` only as needed (isolate the single WebSocketPair/101-Response spot behind a small platform function so both runtimes work)

**Interfaces:**
- Produces:
  - `DurableObject` base class with `ctx`/`env`
  - a `DurableObjectState` stand-in providing the dozen calls the hub uses: `acceptWebSocket`, `getWebSockets`, `storage.setAlarm/getAlarm`, `waitUntil`, `blockConcurrencyWhile`
  - `serializeAttachment`/`deserializeAttachment`, `setWebSocketAutoResponse`
  - the `webSocketMessage/Close/Error` and `alarm` dispatch
  - a `HUB` namespace stand-in (`idFromName`, `get(id).fetch(request)`) with one in-memory instance per name, created lazily
- A `WebSocketPair` bridge: the Node upgrade handler hands the accepted `ws` connection to the shim for the request being served.

- [ ] Tests first: unit tests of the shim (attachments per socket, auto-response ping/pong, alarm fire-once and re-arm, getWebSockets excludes closed, errors inside handlers are caught and logged without crashing), plus an integration test that boots the real `WorkspaceHub` class on the shim with fake sockets and replays frame scenarios from the existing hub tests (send/ack, dedupe, per-socket budget nack, presence alarm).
- [ ] Implement the shim and the minimal hub seam. The Workers build must still pass its existing suite unchanged (`npm test -w apps/worker`).
- [ ] Commit `feat(server): durable object runtime shim for the workspace hub`.

### Task 3: Server entry, static assets, cron, packaging

**Files:** `apps/server/src/{index.ts,config.ts,static.ts,cron.ts,shutdown.ts}`, `apps/server/build.mjs`, `apps/server/.env.example`, tests.

- [ ] Config from environment with validation and clear errors: `APP_ORIGIN` (required, http(s)), `OWNER_EMAIL`, `RESEND_API_KEY`, `EMAIL_FROM`, `DATA_DIR` (default `./data`), `PORT` (default 8080), `HOST` (default 127.0.0.1), `TRUSTED_PROXY_HEADER` (default none), `WEB_DIST` (default the built web app), `FILES_QUOTA_BYTES` and `FILE_MAX_BYTES` overrides if the protocol constants are read by the worker through env (add an optional env override with the current constants as defaults; keep the Workers build working).
- [ ] HTTP server around `app.fetch` with the shim env (`DB`, blob store, `HUB`, `ASSETS` equivalent): API prefixes from the existing `run_worker_first` list go to the app, everything else to static serving with SPA fallback for navigation GETs, `Cache-Control` matching the Workers behaviour (`must-revalidate` for HTML, long cache for hashed assets), the `_headers` file rules applied, directory traversal impossible. WebSocket upgrades on `/ws` go through the app route, which authenticates and reaches the hub.
- [ ] Trusted client IP per Global Constraints; `waitUntil` tracked so shutdown drains it; request body size limits equal to the current upload limit.
- [ ] Daily maintenance at 04:00 server local time via the worker's existing `scheduled` handler (also runnable once with `--maintenance`), with a lock so two instances can't overlap.
- [ ] Graceful shutdown on SIGTERM/SIGINT; structured JSON logs without secrets; a `/health` check that touches the database.
- [ ] Build: `npm run build -w apps/server` bundles to `apps/server/dist/server.mjs` with esbuild (alias `cloudflare:workers` to the shim); `npm start -w apps/server` runs it. A first-run message prints the data dir and applied migrations.
- [ ] Tests: start the built server on a free port (8790+) against a temp data dir with the console mailer; drive a short HTTP and WebSocket scenario (health, sign-in link, bootstrap, WS hello/send/ack, file upload and ranged download, search). Assert the spoofed `CF-Connecting-IP`/`X-Forwarded-For` headers do not change the rate-limit bucket.
- [ ] Commit `feat(server): node http server, static assets, cron and graceful shutdown`.

### Task 4: End-to-end on the Node server, CI, docs

**Files:** `e2e/*` (global setup targets the Node server), `.github/workflows/ci.yml`, `README.md`, `docs/SELF_HOSTING.md`, spec §3/§8/§13/§15, `apps/server/.env.example`.

- [ ] Point the Playwright suite at the Node server (start `apps/server` with a temp `DATA_DIR`, port 8788, `RESEND_API_KEY=dev`, `APP_ORIGIN=http://localhost:8788`), keep the guard that refuses to start without the console mailer, and keep all 10 specs green twice in a row. Keep the wrangler-based run available only as a non-default script if cheap; otherwise remove it.
- [ ] CI: add `apps/server` build and tests to the existing `test` job; `e2e` uses the Node server. Keep action pins.
- [ ] README: new "Self-hosting" section that says plainly that Backroom needs a server you control (Linux, Node 26+, a reverse proxy for HTTPS) and that it is an open source project that runs on its own server; Cloudflare Workers is not a supported target (the Workers entry in `apps/worker` exists to run the test suite and may be adapted by others). Write `docs/SELF_HOSTING.md`: requirements, install, environment variables table, reverse proxy examples (Caddy, nginx, Cloudflare Tunnel), process supervision examples (systemd unit, and a plain script for systemd-less containers), backups (SQLite online backup command plus the blobs folder), upgrades, and the security notes (trusted proxy header).
- [ ] Update the spec sections to describe the Node deployment.
- [ ] Commit `docs: self-hosting guide and e2e on the node server`.

### Task 5: Production move to the user's server (needs the user's go-ahead)

Pre-requisites to confirm with the user before starting: the public route to the container (forwarded port or Cloudflare Tunnel or another way), the hostname, and what to do with the existing Cloudflare deployment and data.

- [ ] Server setup in the Backroom account's home folder only: the Node 26 install already in `~/node`; upload the built `apps/server/dist` plus the web build and migrations by `scp` (no git on the server unless the user approves installing it); create `~/backroom/data` with mode 700 and an env file with mode 600 holding `RESEND_API_KEY`, `OWNER_EMAIL`, `EMAIL_FROM`, `APP_ORIGIN`; never print the env file.
- [ ] Process supervision suited to a systemd-less container: a small supervisor script (restart on crash, log rotation) started at login/boot as far as the container allows; report honestly what survives a container restart.
- [ ] TLS and routing per the user's choice. Verify `/health`, a sign-in as the owner (real email), a message, a file upload and a ranged download, and a WebSocket reconnect across a server restart.
- [ ] Backups: nightly SQLite online backup of the database and a copy of the blobs folder into `~/backups` with 7-day retention, and a restore test.
- [ ] Data move: if the user wants the Cloudflare data kept, export D1 (`wrangler d1 export`) and download KV blobs, import into the new server, verify counts; otherwise start fresh.
- [ ] Cutover and cleanup only with the user's OK: change DNS, detach the custom domain from the Worker, then optionally delete the Cloudflare Worker, KV namespace and D1 database. Never delete without the user's explicit yes.
- [ ] Update `docs/DEPLOY.md` into a short pointer to SELF_HOSTING.md, keeping the Cloudflare notes in an "Unmaintained: Cloudflare Workers" appendix.
