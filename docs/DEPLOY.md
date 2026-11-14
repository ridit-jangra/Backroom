# Deploying Backroom

Backroom deploys to Cloudflare Workers (free tier) at **https://chat.ridit.space**. Steps 1 to 6 are one-time setup. Only steps 7 to 10 repeat on every later deploy.

> **Always deploy with `npm run deploy -w apps/worker`.** The committed `wrangler.jsonc` has `APP_ORIGIN=http://localhost:8787` so local dev works (origin guard, non-Secure cookie). A bare `wrangler deploy` would ship that value to production and break login. The npm script passes `--var APP_ORIGIN:https://chat.ridit.space --domain chat.ridit.space`.

## 1. Prerequisites (one-time)

- A free Cloudflare account that owns the DNS zone `ridit.space`.
- A free Resend account with a verified sending domain (`ridit.space`). `EMAIL_FROM` is the committed var `Backroom <backroom@ridit.space>`.
- Node and npm, then `npm ci` at the repo root.

## 2. Log in (one-time)

```
npx wrangler login
npx wrangler whoami
```

## 3. Database (one-time, already done for this account)

The D1 database `backroom` exists (id `9af7495f-721b-4482-8ead-8768dbf2d33d`) and its id is already in `apps/worker/wrangler.jsonc`. On a fresh account:

```
npx wrangler d1 create backroom
```

Paste the printed `database_id` into `d1_databases[0].database_id` in `apps/worker/wrangler.jsonc`.

## 4. KV namespace for files and emoji (one-time)

File, thumbnail and custom emoji storage is Workers KV, bound as `BLOBS`. It is free and needs no payment card.

```
npx wrangler kv namespace create BLOBS
```

Paste the printed namespace id into `kv_namespaces[0].id` in `apps/worker/wrangler.jsonc`, replacing `<set at deploy>`. (R2 is optional and needs a payment card; Backroom does not use it.)

## 5. Secrets (one-time; also how to rotate)

`RESEND_API_KEY` and `OWNER_EMAIL` (the Gmail that signs in as workspace owner) are Worker secrets. They are already set for this account. To set or rotate one, run in `apps/worker`:

```
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put OWNER_EMAIL
```

A real terminal prompts for the value.

> **Warning: empty-value trap.** Running `wrangler secret put` in a non-interactive shell (including the `!` prefix inside Claude Code) stores an **empty value** and overwrites the old one. In any non-interactive context use the safe form:
>
> ```
> printf '%s' 'VALUE' | npx wrangler secret put NAME
> ```
>
> Never set `RESEND_API_KEY` to `dev` in production: that value switches to the console mailer.

## 6. Apply remote migrations (one-time, and after any new migration)

```
cd apps/worker && npx wrangler d1 migrations apply DB --remote
```

## 7. Build the web app (every deploy)

```
npm run build -w apps/web
```

This writes `apps/web/dist`, which a running local dev server also serves. Stop it, or build from another checkout, if that matters.

## 8. Preflight (every deploy)

```
scripts/deploy-preflight.sh          # add --quick to skip the test suites
```

Read-only. It checks: no `<set at deploy>` left in `wrangler.jsonc`, `EMAIL_FROM` set, the deploy script flags, the web build exists, `npm run deploy:dry-run -w apps/worker` (bundles without uploading), `wrangler whoami`, secret names present, and `npm test`. It prints a checklist and exits non-zero on any failure.

## 9. Deploy (every deploy)

```
npm run deploy -w apps/worker
```

The first deploy creates the `WorkspaceHub` Durable Object class from migration tag `v1` (do not rename the class or change the tag) and attaches the custom domain. Wrangler creates the DNS record itself.

## 10. Verify (every deploy)

1. Open https://chat.ridit.space/health.
2. Sign in as the owner (the Gmail in `OWNER_EMAIL`); the magic link arrives by email.
3. In Admin, create an invite for the next member.

## 11. Desktop app (when the address changes or for a new build)

```
BACKROOM_APP_URL=https://chat.ridit.space npm run build -w apps/desktop
```

Install the produced `.deb` or AppImage. The `backroom://` deep-link handler is registered by the installed app (the `.deb` installs the desktop entry; an AppImage must be launched once, or integrated with a tool such as AppImageLauncher, before the OS routes `backroom://` links).

## 12. Rollback

Code:

```
cd apps/worker && npx wrangler rollback
```

Database: D1 Time Travel restores to a point within the last 30 days.

```
npx wrangler d1 time-travel info backroom
npx wrangler d1 time-travel restore backroom --timestamp=<unix-or-ISO-time>
```

Restoring overwrites the database in place; check the timestamp first.

## Free-tier limits (spec section 13)

| Resource (Free) | Limit | Note |
|---|---|---|
| Worker requests | 100k/day | Cloudflare error 1027 past this |
| Worker CPU | 10 ms/request | no heavy server work |
| Request body | 100 MB | uploads capped at 25 MB |
| Durable Object requests | 100k/day | incoming WS messages billed 20:1 |
| D1 rows written | 100k/day | about 5 to 10 rows per message including FTS |
| D1 rows read | 5M/day | ample |
| D1 / DO storage | 5 GB total | text is small |
| Workers KV | 1 GB storage, 25 MiB per value, 100k reads/day, 1k writes/day, 1k deletes/day | files capped at 900 MB per workspace; each upload, thumbnail or emoji is 1 write; cron cleanup at most 200 deletes/day |
| Static assets | 20,000 files, 25 MiB/file | about 3,700 emoji SVGs plus the app |
| Resend | about 100 emails/day | magic links only |

Past these, the Workers Paid plan ($5/month) needs no code changes.

## Troubleshooting

- **Sign-in email not arriving.** Check the Resend dashboard (logs, domain still verified, API key valid) and the admin "emails failed" banner. Requests are rate limited to 5 per hour per email address, so repeated attempts are silently held back. If the key was stored empty (see the step 5 warning), re-set it with the stdin form.
- **Cloudflare error 1027.** The daily Worker request limit was hit; it resets at 00:00 UTC.
- **`503 storage_busy` on upload.** The KV daily write limit (1k/day) is used up; uploads resume after 00:00 UTC.
- **Custom-domain deploy errors.** The zone `ridit.space` must be on the same Cloudflare account, and `chat.ridit.space` must not already have an explicit DNS record (a wildcard record is fine). Remove a conflicting record, then deploy again.
- **Login redirects or cookies fail after deploy.** The deploy was probably a bare `wrangler deploy`, which ships `APP_ORIGIN=http://localhost:8787`. Redeploy with `npm run deploy -w apps/worker`.
