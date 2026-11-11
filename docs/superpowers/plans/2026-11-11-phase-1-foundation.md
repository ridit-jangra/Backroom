# Backroom Phase 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Cloudflare Worker + React SPA where people eligible for the `clubhack`
workspace sign in by email magic link, and the web app loads their workspace
(channels with unread/mention counts, members); admins manage invites.

**Architecture:** npm-workspaces monorepo. `packages/protocol` holds shared zod
schemas/types. `apps/worker` is a Hono app on Cloudflare Workers with D1 (schema
+ `clubhack` seed via migrations) that also serves the built SPA as static
assets. `apps/web` is a Vite + React SPA. Email goes through a `Mailer`
interface (Resend in production, a capturing fake in tests, a console logger in
local dev).

**Tech Stack:** Node 26, npm workspaces, TypeScript, Hono 4, zod 4, Wrangler 4,
Vitest 4 + `@cloudflare/vitest-pool-workers` 0.23, Vite 8, React 19,
`@testing-library/react` + jsdom.

**Spec:** `docs/superpowers/specs/2026-11-11-backroom-design.md` (§3, §4, §6, §7,
§12, §15; phases §16.1). Out of scope here: WebSocket hub, messaging, emoji,
files, search, desktop (incl. `/auth/desktop/exchange` — Phase 5).

## Global Constraints

- IDs: 26-char ULID strings (TEXT). Timestamps: INTEGER epoch milliseconds.
- Stored tokens are SHA-256 hex hashes only; raw tokens = 32 random bytes, base64url.
- Login token TTL 15 min, single use. Session: 30-day expiry, renewed to 30 days when < 15 days remain.
- Session cookie: `backroom_session`, `HttpOnly; Secure; SameSite=Lax; Path=/`; desktop/API clients may send `Authorization: Bearer <token>`.
- `/auth/start` rate limits: 5 per hour per email, 20 per hour per IP; response is always `200 {"ok":true}` regardless of eligibility or limit.
- Every API error body: `{"error":{"code":string,"message":string}}`.
- Every non-GET API request must carry `Origin` equal to `APP_ORIGIN`, else `403 bad_origin`.
- Emails are normalized with `trim().toLowerCase()` before every lookup and insert.
- Secrets/vars: `RESEND_API_KEY`, `OWNER_EMAIL`, `APP_ORIGIN`, `EMAIL_FROM`.
- Seed: workspace slug `clubhack`, name `clubhack`, public channels `general` and `random`; every new member auto-joins `general`.
- Never log message bodies, full emails, or tokens (the dev-only console mailer in Task 10 is the single exception: it prints the local sign-in link).
- Pin exact dependency versions in `package.json` (no `^`); commit `package-lock.json`.

## Review Focus

1. **Email scanners prefetching the magic link** — opening `/verify?t=…` must not consume the token; only `POST /auth/verify` does (Task 6 test `verify page link is not consumed by GET`).
2. **Same link submitted twice concurrently (two tabs/double-click)** — exactly one session is created; the other gets `400 link_invalid` (Task 6 test `concurrent verify creates one session`).
3. **Email case/whitespace variants** — `" Alice@Example.COM "` signs in as the same user as `alice@example.com` (Task 1 `normalizes email`, Task 6 `start normalizes`, Task 5 `normalizes email`).
4. **Deactivated member** — gets no link from `/auth/start`, and their existing sessions stop working immediately (Task 5 `deactivated member is ineligible`, Task 4 `deactivated member session is rejected`, Task 8 `deactivating a member kills their sessions`).
5. **`OWNER_EMAIL` after an owner already exists** — treated like any other address (no second owner, no link unless member/invited) (Task 5 test `owner email only bootstraps once`).

---

### Task 1: Monorepo scaffold and protocol package

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `.gitignore`, `.nvmrc`
- Create: `packages/protocol/package.json`, `packages/protocol/tsconfig.json`, `packages/protocol/src/index.ts`, `packages/protocol/src/rest.ts`
- Test: `packages/protocol/test/rest.test.ts`

**Interfaces:**
- Produces (exported from `@backroom/protocol`):
  - `AuthStartBody = z.object({ email: z.string().trim().toLowerCase().email().max(254), inviteToken: z.string().max(100).optional() })`
  - `AuthVerifyBody = z.object({ token: z.string().min(10).max(100) })`
  - `InviteCreateBody = z.object({ maxUses: z.number().int().min(1).max(500).default(50), expiresInDays: z.number().int().min(1).max(90).default(14) })`
  - `MemberPatchBody = z.object({ role: z.enum(['admin','member']).optional(), deactivated: z.boolean().optional() })`
  - `MePatchBody = z.object({ displayName: z.string().trim().min(1).max(80) })`
  - Types: `ApiErrorBody = { error: { code: string; message: string } }`;
    `Role = 'owner'|'admin'|'member'`;
    `ChannelSummary = { id: string; name: string|null; kind: 'public'|'private'|'dm'; topic: string|null; lastSeq: number; lastReadSeq: number; unreadCount: number; mentionCount: number }`;
    `MemberSummary = { id: string; displayName: string; role: Role; avatarKey: string|null }`;
    `Me = { id: string; email: string; displayName: string }`;
    `Bootstrap = { workspace: { id: string; slug: string; name: string }; me: Me & { role: Role }; channels: ChannelSummary[]; members: MemberSummary[] }`;
    `InviteSummary = { id: string; maxUses: number; uses: number; expiresAt: number; createdBy: string }`

- [ ] **Step 1: Root scaffold.** Root `package.json`: `"private": true`, `"workspaces": ["packages/*","apps/*"]`, scripts `test` (`npm test --workspaces --if-present`), `build` (`npm run build -w apps/web`), `dev` (`npm run dev -w apps/worker`). `tsconfig.base.json`: `strict`, `target ES2023`, `module ESNext`, `moduleResolution Bundler`, `noUncheckedIndexedAccess`. `.gitignore`: `node_modules`, `dist`, `.wrangler`, `.dev.vars`. `.nvmrc`: `26`.
- [ ] **Step 2: Write failing test** `packages/protocol/test/rest.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { AuthStartBody, InviteCreateBody } from '../src';

describe('AuthStartBody', () => {
  it('normalizes email', () => {
    expect(AuthStartBody.parse({ email: '  Alice@Example.COM ' }).email).toBe('alice@example.com');
  });
  it('rejects non-email', () => {
    expect(AuthStartBody.safeParse({ email: 'nope' }).success).toBe(false);
  });
});
describe('InviteCreateBody', () => {
  it('applies defaults', () => {
    expect(InviteCreateBody.parse({})).toEqual({ maxUses: 50, expiresInDays: 14 });
  });
});
```

- [ ] **Step 3: Run** `npm install && npm test -w packages/protocol` → FAIL (module not found).
- [ ] **Step 4: Implement** `packages/protocol/src/rest.ts` with the schemas/types above; re-export from `src/index.ts`. Package name `@backroom/protocol`, `"type":"module"`, `"main"`/`"types"` → `src/index.ts` (consumed as source by Vite and Wrangler; no build step). Dev deps: `vitest@4.1.x` (exact patch at install), `typescript`; dep `zod@4.6.7`.
- [ ] **Step 5: Run** `npm test -w packages/protocol` → PASS (3 tests).
- [ ] **Step 6: Commit** `git add -A && git commit -m "chore: monorepo scaffold and protocol schemas"`

### Task 2: Worker skeleton, D1 schema and seed

**Files:**
- Create: `apps/worker/package.json`, `apps/worker/tsconfig.json`, `apps/worker/wrangler.jsonc`, `apps/worker/vitest.config.ts`, `apps/worker/test/setup.ts`, `apps/worker/test/env.d.ts`
- Create: `apps/worker/migrations/0001_init.sql`, `apps/worker/migrations/0002_seed_clubhack.sql`
- Create: `apps/worker/src/env.ts`, `apps/worker/src/index.ts`, `apps/worker/src/app.ts`
- Test: `apps/worker/test/schema.test.ts`

**Interfaces:**
- Produces:
  - `interface Env { DB: D1Database; ASSETS: Fetcher; RESEND_API_KEY: string; OWNER_EMAIL: string; APP_ORIGIN: string; EMAIL_FROM: string }` (`src/env.ts`)
  - `interface Deps { mailer: Mailer; now: () => number }` and `type AppEnv = { Bindings: Env; Variables: { deps: Deps; session?: SessionInfo } }` (`src/app.ts`; `Mailer` lands in Task 6 and `SessionInfo` in Task 4 — until then declare minimal placeholder interfaces in `src/app.ts` and replace them with imports when those tasks land)
  - `createApp(deps: Deps): Hono<AppEnv>` (`src/app.ts`) — later tasks register middleware and mount routers here.
  - `export default { fetch }` in `src/index.ts` built from `createApp({ mailer, now: Date.now })` (mailer selection finalized in Task 10).
  - Tests call `createApp(deps).request(path, init, env)` with `env` from `cloudflare:test`.

- [ ] **Step 1: Config.** `wrangler.jsonc`: `name: "backroom"`, `main: "src/index.ts"`, `compatibility_date: "2026-11-01"`, `compatibility_flags: ["nodejs_compat"]`, `d1_databases: [{ binding: "DB", database_name: "backroom", database_id: "<set at deploy>", migrations_dir: "migrations" }]`, `assets: { directory: "../web/dist", binding: "ASSETS", not_found_handling: "single-page-application", run_worker_first: ["/auth/*", "/me", "/w/*", "/invites/*", "/health"] }`, `vars: { APP_ORIGIN: "http://localhost:8787", EMAIL_FROM: "Backroom <login@example.com>" }`. Dev deps pinned: `wrangler@4.160.1`, `vitest@4.1.x`, `@cloudflare/vitest-pool-workers@0.23.0`, `@cloudflare/workers-types`, `typescript`; deps `hono@4.13.18`, `@backroom/protocol` (workspace `*`). Configure Vitest per the installed `@cloudflare/vitest-pool-workers` README so tests run inside workerd with `wrangler.jsonc` bindings and test-only bindings `OWNER_EMAIL=owner@test.dev`, `APP_ORIGIN=https://app.test`, `RESEND_API_KEY=test`; expose migrations with `readD1Migrations("migrations")` and apply them in `test/setup.ts` via `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)`. Create an empty `apps/web/dist/.gitkeep`-free placeholder only if Wrangler refuses to start without the assets directory (the web build in Task 9 creates it).
- [ ] **Step 2: Write failing test** `test/schema.test.ts`:

```ts
import { env } from 'cloudflare:test';
import { it, expect } from 'vitest';

it('seeds clubhack with general and random', async () => {
  const ws = await env.DB.prepare("SELECT id FROM workspaces WHERE slug='clubhack'").first<{ id: string }>();
  expect(ws).not.toBeNull();
  const { results } = await env.DB.prepare(
    'SELECT name, kind FROM channels WHERE workspace_id=? ORDER BY name').bind(ws!.id).all();
  expect(results).toEqual([{ name: 'general', kind: 'public' }, { name: 'random', kind: 'public' }]);
});

it('keeps messages_fts in sync on insert and soft delete', async () => {
  const ch = await env.DB.prepare("SELECT id FROM channels WHERE name='general'").first<{ id: string }>();
  await env.DB.prepare("INSERT INTO messages(id,channel_id,seq,user_id,body,created_at) VALUES ('m1',?,1,'u1','hello banana',0)").bind(ch!.id).run();
  const hit = () => env.DB.prepare("SELECT count(*) n FROM messages_fts WHERE messages_fts MATCH 'banana'").first<{ n: number }>();
  expect((await hit())!.n).toBe(1);
  await env.DB.prepare("UPDATE messages SET body='', deleted_at=1 WHERE id='m1'").run();
  expect((await hit())!.n).toBe(0);
});

it('rejects an invalid role', async () => {
  await expect(env.DB.prepare(
    "INSERT INTO workspace_members(workspace_id,user_id,role,joined_at) VALUES ('w','u','god',0)").run()).rejects.toThrow();
});
```

- [ ] **Step 3: Run** `npm test -w apps/worker` → FAIL (no tables).
- [ ] **Step 4: Write `0001_init.sql`** — every table and column exactly as spec §4 (including `login_codes(code_hash, user_id, expires_at, used_at)` and `rate_limits`), with `CHECK` constraints and `UNIQUE`s as listed; plus indexes `messages(channel_id, seq)`, `messages(parent_id)`, `mentions(user_id)`, `mentions(message_id)`, `channel_members(user_id)`, `sessions(user_id)`. FTS: `CREATE VIRTUAL TABLE messages_fts USING fts5(body, content='messages', content_rowid='rowid')` and `files_fts USING fts5(name, content='files', content_rowid='rowid')`, with external-content triggers (`AFTER INSERT`, `AFTER DELETE`, `AFTER UPDATE OF body`) using the FTS5 `'delete'` command for old rows. `messages` and `files` must be ordinary rowid tables (TEXT `id` PRIMARY KEY, not `WITHOUT ROWID`).
- [ ] **Step 5: Write `0002_seed_clubhack.sql`** — insert workspace (`id` `01JCLUBHACK0000000000000WS`, slug/name `clubhack`, `settings_json` `'{"customEmojiPolicy":"admins"}'`, `created_at` 0) and channels `general` (`01JCLUBHACK0000000000000GN`) and `random` (`01JCLUBHACK0000000000000RD`), kind `public`, `created_by` NULL, `created_at` 0.
- [ ] **Step 6: Implement** `src/env.ts`, `src/app.ts` (`createApp` with `GET /health` → `{ok:true}`; middleware storing `deps` in `c.var.deps`), `src/index.ts`.
- [ ] **Step 7: Run** `npm test -w apps/worker` → PASS (3 tests).
- [ ] **Step 8: Commit** `git add -A && git commit -m "feat(worker): D1 schema, clubhack seed, app skeleton"`

### Task 3: Core helpers — ids, crypto, errors, rate limiting, origin guard

**Files:**
- Create: `apps/worker/src/lib/ids.ts`, `src/lib/crypto.ts`, `src/lib/errors.ts`, `src/lib/rateLimit.ts`, `src/middleware/origin.ts`, `apps/worker/test/helpers.ts`
- Modify: `apps/worker/src/app.ts` (register `onError`, origin middleware)
- Test: `apps/worker/test/lib.test.ts`, `apps/worker/test/origin.test.ts`

**Interfaces:**
- Produces:
  - `newId(now?: number): string` — ULID: 10 chars Crockford base32 time + 16 chars from `crypto.getRandomValues`.
  - `randomToken(): string` — 32 bytes base64url, no padding.
  - `sha256Hex(input: string): Promise<string>`
  - `class ApiError extends Error { constructor(public status: 400|401|403|404|409|413|429|500, public code: string, message: string) }`
  - `errorHandler(err, c)` → `ApiError` ⇒ its status + `ApiErrorBody`; `ZodError` ⇒ `400 invalid_request`; anything else ⇒ `500 internal` with a generic message (logs `err.name` + route only).
  - `hitRateLimit(db: D1Database, key: string, limit: number, windowMs: number, now: number): Promise<boolean>` — fixed window; `true` = allowed. Single `INSERT … ON CONFLICT(key) DO UPDATE` that resets `window_start`/`count` when the window has expired, else increments; `RETURNING count`.
  - `requireSameOrigin` middleware: for methods other than GET/HEAD/OPTIONS, `Origin` header must equal `c.env.APP_ORIGIN`, else `ApiError(403,'bad_origin',…)`.
  - `test/helpers.ts`: `testDeps(overrides?: Partial<Deps>): Deps` (fixed `now` = `1_800_000_000_000`, no-op mailer until Task 6).

- [ ] **Step 1: Write failing tests** `test/lib.test.ts`:

```ts
it('newId is 26 chars and sorts by time', () => {
  const a = newId(1_000), b = newId(2_000);
  expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(a < b).toBe(true);
});
it('randomToken is 43 base64url chars and unique', () => {
  const t = randomToken();
  expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(randomToken()).not.toBe(t);
});
it('sha256Hex matches known vector', async () => {
  expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
it('rate limit allows `limit` hits per window then blocks, and resets', async () => {
  const r = [];
  for (let i = 0; i < 6; i++) r.push(await hitRateLimit(env.DB, 'k', 5, 3_600_000, 1_000));
  expect(r).toEqual([true, true, true, true, true, false]);
  expect(await hitRateLimit(env.DB, 'k', 5, 3_600_000, 1_000 + 3_600_000)).toBe(true);
});
```

`test/origin.test.ts`: build `createApp(testDeps())`, add a throwaway `app.post('/w/x/probe', c => c.json({ok:true}))` and `app.get('/w/x/fail', () => { throw new ApiError(404,'not_found','nope') })`; assert POST without `Origin` → 403 `{"error":{"code":"bad_origin",…}}`; POST with `Origin: https://app.test` → 200; GET `/w/x/fail` → 404 body `{"error":{"code":"not_found","message":"nope"}}`.
- [ ] **Step 2: Run** `npm test -w apps/worker` → FAIL (imports missing).
- [ ] **Step 3: Implement** the modules with the signatures above; register `app.onError(errorHandler)` and `app.use('*', requireSameOrigin)` in `createApp`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(worker): ids, crypto, errors, rate limit, origin guard"`

### Task 4: Sessions and session middleware

**Files:**
- Create: `apps/worker/src/auth/sessions.ts`, `apps/worker/src/middleware/session.ts`
- Modify: `apps/worker/src/app.ts` (run `loadSession` on every request; replace the `SessionInfo` placeholder)
- Test: `apps/worker/test/sessions.test.ts`

**Interfaces:**
- Consumes: `randomToken`, `sha256Hex`, `ApiError` (Task 3).
- Produces:
  - `SESSION_COOKIE = 'backroom_session'`; `SESSION_TTL_MS = 30*86_400_000`; `SESSION_RENEW_BELOW_MS = 15*86_400_000`
  - `createSession(db: D1Database, userId: string, userAgent: string|null, now: number): Promise<string>` (returns the raw token)
  - `resolveSession(db: D1Database, token: string, now: number): Promise<{ userId: string; renewed: boolean } | null>` — null if missing/expired, or if the user has no non-deactivated workspace membership; extends `expires_at` to `now + SESSION_TTL_MS` when remaining < `SESSION_RENEW_BELOW_MS`.
  - `deleteSession(db, token): Promise<void>`; `deleteAllSessions(db, userId): Promise<void>`
  - `type SessionInfo = { userId: string; token: string }`
  - `loadSession` middleware: token from cookie `backroom_session` or `Authorization: Bearer`; on success sets `c.var.session` and, if `renewed` and the token came from the cookie, re-sets the cookie.
  - `requireSession` middleware: `401 unauthenticated` when `c.var.session` is absent.
  - `setSessionCookie(c, token)` / `clearSessionCookie(c)` with the attributes from Global Constraints, `Max-Age` 30 days (clear = `Max-Age=0`).

- [ ] **Step 1: Write failing tests** `test/sessions.test.ts` (insert a user + `clubhack` membership directly in a `beforeEach`):
  - `creates and resolves a session` — `resolveSession(db, t, now)` → `{ userId, renewed: false }`; the raw token is not stored (`SELECT count(*) FROM sessions WHERE token_hash = ?` bound to the raw token → 0).
  - `expired session resolves to null` — at `now + SESSION_TTL_MS + 1` → null.
  - `renews when under 15 days remain` — at `now + 16*86_400_000` → `renewed: true` and `expires_at` = that time + 30 days.
  - `deactivated member session is rejected` — set `deactivated_at`, resolve → null.
  - `requireSession returns 401 without credentials, 200 with Bearer` — via a throwaway route `app.get('/w/x/me-probe', requireSession, c => c.json({ ok: true }))`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(worker): sessions and session middleware"`

### Task 5: Login eligibility and membership acceptance

**Files:**
- Create: `apps/worker/src/auth/eligibility.ts`, `apps/worker/src/workspace/membership.ts`
- Test: `apps/worker/test/eligibility.test.ts`

**Interfaces:**
- Consumes: `newId`, `sha256Hex` (Task 3).
- Produces:
  - `type Eligibility = { ok: false } | { ok: true; inviteId: string | null }`
  - `checkEligibility(db: D1Database, email: string, inviteToken: string | undefined, ownerEmail: string, now: number): Promise<Eligibility>` — eligible iff (a) the email belongs to a non-deactivated member of `clubhack`, or (b) `inviteToken` hashes to an invite with `expires_at > now` and `uses < max_uses` (returns its id), or (c) `email === ownerEmail.trim().toLowerCase()` and `clubhack` has no `owner` row. A deactivated member is ineligible even with an invite or as owner email.
  - `checkEligibilityByInviteId(db, email, inviteId: string | null, ownerEmail, now): Promise<Eligibility>` — same rules, given an invite id instead of a raw token (used at verify time).
  - `acceptLogin(db: D1Database, email: string, inviteId: string | null, ownerEmail: string, now: number): Promise<{ userId: string }>` — in one `db.batch`: upsert user (`display_name` defaults to the part of the email before `@`); if not yet a member, insert `workspace_members` with role `owner` when rule (c) applies, else `member`; when an invite is used and the user was not already a member, `UPDATE invites SET uses = uses + 1 WHERE id=? AND uses < max_uses`; `INSERT OR IGNORE` a `channel_members` row for `general` with `last_read_seq` = that channel's current `last_seq`.

- [ ] **Step 1: Write failing tests** `test/eligibility.test.ts`:
  - `unknown email without invite is ineligible`.
  - `owner email bootstraps owner` — `checkEligibility(db,'owner@test.dev',undefined,'owner@test.dev',now)` → ok; `acceptLogin` → member row role `owner`, plus a `channel_members` row for `general`.
  - `owner email only bootstraps once` — with a different user already `owner`, owner email (not a member, no invite) → `{ ok: false }`; and the workspace never has two `owner` rows.
  - `valid invite is eligible and consumed once` — invite `max_uses: 1`; accept → `uses = 1`; same invite for another email → ineligible.
  - `expired invite is ineligible`.
  - `existing member re-login does not consume invite uses`.
  - `deactivated member is ineligible` (also with a valid invite).
  - `normalizes email` — with an existing user `alice@example.com`, `acceptLogin` for `alice@example.com` reuses that user (no duplicate `users` row).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(worker): login eligibility and membership acceptance"`

### Task 6: Auth routes and mailer

**Files:**
- Create: `apps/worker/src/auth/mailer.ts`, `apps/worker/src/auth/routes.ts`
- Modify: `apps/worker/src/app.ts` (mount `/auth`; replace the `Mailer` placeholder), `apps/worker/test/helpers.ts`
- Test: `apps/worker/test/auth.test.ts`

**Interfaces:**
- Consumes: Tasks 3–5; `AuthStartBody`, `AuthVerifyBody` from `@backroom/protocol`.
- Produces:
  - `interface Mailer { sendMagicLink(env: Env, to: string, url: string): Promise<void> }`
  - `resendMailer: Mailer` — `POST https://api.resend.com/emails` with `Authorization: Bearer ${RESEND_API_KEY}`, JSON `{ from: EMAIL_FROM, to: [to], subject: 'Your Backroom sign-in link', text, html }`; non-2xx ⇒ throw `ApiError(500,'email_failed',…)`. The body states the link expires in 15 minutes and works once.
  - `test/helpers.ts` additions: `captureMailer()` returning `{ mailer, sent: { to: string; url: string }[] }`; `post(app, path, body, headers?)` that adds `Origin: https://app.test` and a JSON content type; `signIn(app, email, inviteToken?)` that runs start → captured link → verify and returns the `Cookie` header value.
  - Routes:
    - `POST /auth/start` — parse `AuthStartBody`; rate-limit keys `start:email:<email>` (5/h) and `start:ip:<CF-Connecting-IP or 'unknown'>` (20/h); if both allowed and eligible: insert `login_tokens` (hash, email, invite_id, `expires_at = now + 900_000`) and send `${APP_ORIGIN}/verify?t=<raw>`. Always `200 {"ok":true}`. Mailer failure is logged (error code only) and still returns 200.
    - `POST /auth/verify` — parse `AuthVerifyBody`; `UPDATE login_tokens SET used_at=? WHERE token_hash=? AND used_at IS NULL AND expires_at>? RETURNING email, invite_id`; no row ⇒ `400 link_invalid` with message `This sign-in link is invalid, expired or already used.` Re-check with `checkEligibilityByInviteId`; ineligible ⇒ `403 not_allowed`. Then `acceptLogin`, `createSession`, set cookie, return `200 { ok: true, workspace: 'clubhack' }`.
    - `POST /auth/logout` — `requireSession`; delete current session; clear cookie; `200 {ok:true}`.
    - `POST /auth/logout-all` — `requireSession`; delete all of the user's sessions; clear cookie; `200 {ok:true}`.

- [ ] **Step 1: Write failing tests** `test/auth.test.ts`:
  - `start for eligible email sends one link; ineligible sends none; both return 200 {ok:true}`.
  - `start normalizes " Owner@Test.DEV "` — link sent to `owner@test.dev`.
  - `start is rate limited per email` — 6 calls ⇒ exactly 5 emails, all responses 200.
  - `verify page link is not consumed by GET` — `GET /verify?t=<raw>` through the app (any status), then `POST /auth/verify` with the token ⇒ 200.
  - `verify sets session cookie and creates owner` — `Set-Cookie` contains `backroom_session=`, `HttpOnly`, `Secure`, `SameSite=Lax`; `sessions` count = 1; member role `owner`.
  - `verify rejects reuse` — second POST with the same token ⇒ 400 `link_invalid`.
  - `concurrent verify creates one session` — `Promise.all` of two POSTs ⇒ statuses sorted `[200, 400]`; `sessions` count 1.
  - `verify rejects expired token` — deps `now` advanced by 900_001 ms ⇒ 400.
  - `logout clears cookie and session` — `Set-Cookie` has `Max-Age=0`; session row gone.
  - `logout-all ends every session` — sign in the same email twice (two cookies); `POST /auth/logout-all` with one ⇒ both sessions deleted.
  - `start without Origin is 403`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(worker): magic-link auth routes"`

### Task 7: Bootstrap and profile endpoints

**Files:**
- Create: `apps/worker/src/workspace/access.ts`, `apps/worker/src/workspace/bootstrap.ts`, `apps/worker/src/workspace/routes.ts`
- Modify: `apps/worker/src/app.ts` (mount)
- Test: `apps/worker/test/bootstrap.test.ts`

**Interfaces:**
- Consumes: `requireSession`, `SessionInfo` (Task 4); `signIn` helper (Task 6); `Bootstrap`, `ChannelSummary`, `MemberSummary`, `Me`, `MePatchBody`, `Role` (Task 1).
- Produces:
  - `requireMember(db: D1Database, slug: string, userId: string): Promise<{ workspaceId: string; role: Role }>` — `404 not_found` if the workspace is missing or the user is not an active member (identical error either way, so slugs can't be probed).
  - `requireAdmin(db, slug, userId)` — as `requireMember`, plus `403 forbidden` unless role is `owner` or `admin`.
  - `getBootstrap(db: D1Database, slug: string, userId: string): Promise<Bootstrap>` — channels the user belongs to (non-archived), public/private ordered by name, then DMs; `unreadCount` = messages with `seq > last_read_seq`, `deleted_at IS NULL`, and (`parent_id IS NULL` OR `also_in_channel = 1`); `mentionCount` = distinct such messages having a `mentions` row with `user_id = me` or `kind IN ('channel','here')`; `members` = active members ordered by display name.
  - Routes: `GET /w/:slug/bootstrap` → `Bootstrap`; `GET /me` → `Me`; `PATCH /me` (`MePatchBody`) → `Me`.

- [ ] **Step 1: Write failing tests** `test/bootstrap.test.ts`:
  - `bootstrap lists general only after first login, with zero counts`.
  - `unread excludes thread replies unless also_in_channel` — insert messages seq 1 (top-level), 2 (reply), 3 (reply with `also_in_channel=1`), 4 (top-level, deleted) ⇒ `unreadCount` 2.
  - `mentionCount counts direct and @channel mentions` — 1 direct + 1 `channel` on separate unread messages + 1 direct mention on an already-read message ⇒ 2.
  - `non-member gets identical 404 for clubhack and for an unknown slug`.
  - `PATCH /me trims and updates display name; empty name is 400 invalid_request`.
  - `bootstrap without session is 401`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per Interfaces (channel counts via correlated subqueries in a single statement).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(worker): workspace bootstrap and profile endpoints"`

### Task 8: Admin invites and member management

**Files:**
- Create: `apps/worker/src/workspace/invites.ts`
- Modify: `apps/worker/src/workspace/routes.ts`
- Test: `apps/worker/test/invites.test.ts`

**Interfaces:**
- Consumes: `requireAdmin` (Task 7), `deleteAllSessions` (Task 4), `signIn` (Task 6), `InviteCreateBody`, `InviteSummary`, `MemberPatchBody` (Task 1).
- Produces routes:
  - `POST /w/:slug/invites` (admin) → `201 { invite: InviteSummary; url: string }` where `url = ${APP_ORIGIN}/invite/<raw token>`; the raw token appears only in this response.
  - `GET /w/:slug/invites` (admin) → `{ invites: InviteSummary[] }` (unexpired and not exhausted).
  - `DELETE /invites/:id` (admin of the invite's workspace) → sets `expires_at = now`; `200 {ok:true}`.
  - `PATCH /w/:slug/members/:userId` (admin, `MemberPatchBody`) → only the `owner` may change roles; nobody can change or deactivate the owner; deactivating sets `deactivated_at = now` and calls `deleteAllSessions`; returns the updated `MemberSummary`.

- [ ] **Step 1: Write failing tests** `test/invites.test.ts`:
  - `admin creates invite; invitee signs in via inviteToken and becomes a member in general`.
  - `member cannot create invites (403 forbidden)`.
  - `revoked invite no longer grants a link`.
  - `deactivating a member kills their sessions` — that member's cookie then gets 401 on `/me`.
  - `owner cannot be deactivated or demoted (403)`.
  - `admin (non-owner) cannot change roles (403)`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(worker): invites and member management"`

### Task 9: Web app — sign-in flow and workspace shell

**Files:**
- Create: `apps/web/package.json`, `apps/web/vite.config.ts`, `apps/web/index.html`, `apps/web/src/main.tsx`, `src/App.tsx`, `src/api.ts`, `src/pages/Login.tsx`, `src/pages/Verify.tsx`, `src/pages/Invite.tsx`, `src/pages/Workspace.tsx`, `src/styles.css`
- Test: `apps/web/test/login.test.tsx`, `apps/web/test/verify.test.tsx`

**Interfaces:**
- Consumes: REST routes from Tasks 6–8; types from `@backroom/protocol`.
- Produces:
  - `api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T>` — `credentials: 'include'`, JSON in/out; non-2xx throws `ApiClientError { status: number; code: string; message: string }` built from `ApiErrorBody`.
  - Routes (small pathname switch in `App.tsx`, `history.pushState` for navigation): `/login` (optional `?invite=`), `/verify?t=`, `/invite/:token` (redirects to `/login?invite=<token>`), `/w/:slug` (workspace shell), `/` → `/w/clubhack`.
  - Workspace shell: `401` from bootstrap ⇒ redirect to `/login`. Sidebar: workspace name, channels (`#name`, bold when `unreadCount > 0`, badge with `mentionCount` when > 0), members list. Main pane: selected channel name and the placeholder "Messages arrive in Phase 2." Header: "Sign out" (POST `/auth/logout`, then `/login`).
  - Copy (exact): Login heading "Sign in to Backroom"; button "Email me a sign-in link"; after submit "Check your email — if this address can join, a sign-in link is on its way. It expires in 15 minutes." Verify page: heading "Finish signing in", button "Sign in"; on error show the API's `message`.
  - Vite dev server proxies `/auth`, `/me`, `/w`, `/invites` to `http://localhost:8787`.

- [ ] **Step 1: Write failing tests** (Vitest + jsdom + `@testing-library/react`, `fetch` stubbed with `vi.fn`):
  - `login.test.tsx`: `submits email and shows confirmation` — typing `a@b.co` and clicking "Email me a sign-in link" calls `fetch('/auth/start', …)` with body `{"email":"a@b.co"}`, then shows the "Check your email" text; with URL `?invite=XYZ` the body is `{"email":"a@b.co","inviteToken":"XYZ"}`.
  - `verify.test.tsx`: `does not call the API until Sign in is clicked` — rendering at `/verify?t=tok123` makes zero `fetch` calls; clicking "Sign in" POSTs `{"token":"tok123"}` and navigates to `/w/clubhack`; a 400 `link_invalid` response shows its message.
- [ ] **Step 2: Run** `npm test -w apps/web` → FAIL.
- [ ] **Step 3: Implement** pages, `api.ts`, router, and minimal CSS (system font stack, two-column layout with a 260px sidebar, light and dark via `prefers-color-scheme`). Deps pinned: `react@19.3.1`, `react-dom@19.3.1`, `vite@8.3.8`, `@vitejs/plugin-react`, `vitest@4.1.x`, `jsdom`, `@testing-library/react`, `@testing-library/user-event`.
- [ ] **Step 4: Run** `npm test -w apps/web` → PASS; `npm run build -w apps/web` → `apps/web/dist/index.html` exists.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(web): sign-in flow and workspace shell"`

### Task 10: Dev mailer, local end-to-end run, and setup docs

**Files:**
- Create: `README.md`, `apps/worker/.dev.vars.example`
- Modify: root `package.json` (script `dev:all`: build web, then `wrangler dev` in `apps/worker`), `apps/worker/src/auth/mailer.ts`, `apps/worker/src/index.ts`
- Test: `apps/worker/test/auth.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `consoleMailer: Mailer` (prints `Sign-in link for <to>: <url>` to the local console; dev only); `pickMailer(env: Env): Mailer` → `consoleMailer` when `RESEND_API_KEY === 'dev'`, else `resendMailer`; `src/index.ts` uses `pickMailer(env)` per request.

- [ ] **Step 1: Write failing test** in `test/auth.test.ts`: `pickMailer selects console mailer only for "dev"` — `pickMailer({ ...env, RESEND_API_KEY: 'dev' })` is `consoleMailer`; `pickMailer({ ...env, RESEND_API_KEY: 're_x' })` is `resendMailer`.
- [ ] **Step 2: Run** → FAIL. **Step 3:** implement `consoleMailer`, `pickMailer`, wire into `src/index.ts`. **Step 4:** run → PASS.
- [ ] **Step 5: Manual smoke.** `cp apps/worker/.dev.vars.example apps/worker/.dev.vars` (contents: `RESEND_API_KEY=dev`, `OWNER_EMAIL=you@example.com`); in `apps/worker`: `npx wrangler d1 migrations apply backroom --local`; then `npm run dev:all`. At `http://localhost:8787`: request a link for the owner email → link printed in the terminal → open it → click "Sign in" → the shell shows `clubhack` with `#general` (the channel new members auto-join); create an invite with the `curl` command documented in the README (cookie copied from the browser) → open `/invite/<token>` in a private window, sign in a second email → both people appear in the members list. Expected: every step works; record any failure as a bug and fix it before continuing.
- [ ] **Step 6: README** — what Backroom is; prerequisites (Node 26, free Cloudflare account, free Resend account with a verified domain); local dev steps above; deploy steps: `npx wrangler login`, `npx wrangler d1 create backroom` (paste the id into `wrangler.jsonc`), `npx wrangler d1 migrations apply backroom --remote`, `npx wrangler secret put RESEND_API_KEY`, `… OWNER_EMAIL`, set `APP_ORIGIN` and `EMAIL_FROM` vars to the deployed URL and verified sender, `npm run build && npx wrangler deploy -c apps/worker/wrangler.jsonc`. Link the spec and this plan.
- [ ] **Step 7: Full suite** `npm test` → all workspaces PASS.
- [ ] **Step 8: Commit** `git add -A && git commit -m "docs: local dev and deploy guide; dev mailer"`
