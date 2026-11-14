# Deploying Backroom

> **Cloudflare Workers deployment is unmaintained.** Backroom is now a self-hosted Node.js server: see **[SELF_HOSTING.md](SELF_HOSTING.md)** for how to run it. The notes below describe how the project was deployed to Cloudflare Workers before that. They were correct when written and are kept for anyone who wants to adapt that path, but nothing here is tested or supported any more, and newer features (backups, configurable limits, the trusted proxy settings) exist only in the Node server.

# Unmaintained: Cloudflare Workers

Backroom used to deploy to Cloudflare Workers (free tier). Steps 1 to 6 are one-time setup. Only steps 7 to 10 repeat on every later deploy. `chat.example.com` and `example.com` below stand for your own hostname and zone.

> **The committed `apps/worker/wrangler.jsonc` and the `deploy` scripts in `apps/worker/package.json` hold the original maintainer's values** (domain, D1 database id, KV namespace id, `EMAIL_FROM`). Replace them with your own before deploying.

> **Always deploy with `npm run deploy -w apps/worker`.** The committed `wrangler.jsonc` has `APP_ORIGIN=http://localhost:8787` so local dev works (origin guard, non-Secure cookie). A bare `wrangler deploy` would ship that value to production and break login. The npm script passes `--var APP_ORIGIN:https://<your hostname> --domain <your hostname>`.

## 1. Prerequisites (one-time)

- A free Cloudflare account that owns your DNS zone (`example.com`).
- A free Resend account with a verified sending domain. `EMAIL_FROM` is a committed var in `wrangler.jsonc` (for example `Backroom <backroom@example.com>`).
- Node and npm, then `npm ci` at the repo root.

## 2. Log in (one-time)

```
npx wrangler login
npx wrangler whoami
```

## 3. Database (one-time)

Create the D1 database:

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

`RESEND_API_KEY` and `OWNER_EMAIL` (the address that signs in as workspace owner) are Worker secrets. To set or rotate one, run in `apps/worker`:

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

Read-only. It checks: no `<set at deploy>` left in `wrangler.jsonc`, `EMAIL_FROM` set, the deploy script flags, the web build exists (and warns, without failing, when `apps/web/dist/index.html` is older than the newest file under `apps/web/src`; rebuild with step 7), `npm run deploy:dry-run -w apps/worker` (bundles without uploading), `wrangler whoami`, secret names present, and `npm test`. It prints a checklist and exits non-zero on any failure.

## 9. Deploy (every deploy)

```
npm run deploy -w apps/worker
```

The first deploy creates the `WorkspaceHub` Durable Object class from migration tag `v1` (do not rename the class or change the tag) and attaches the custom domain. Wrangler creates the DNS record itself.

## 10. Verify (every deploy)

1. Open https://chat.example.com/health.
2. Sign in as the owner (the address in `OWNER_EMAIL`); the magic link arrives by email.
3. In Admin, create an invite for the next member.

If the first owner email does not arrive, the admin "emails failed" banner cannot help (nobody can sign in yet). Run `npx wrangler tail` in `apps/worker` in a second terminal, request the link again, and look for an `email_failed` line; then check the Resend dashboard logs (the send, your domain still verified, the API key valid) and the spam folder. No `email_failed` line and no Resend log entry usually means `OWNER_EMAIL` does not match the address typed, or the request was rate limited (5 per hour per address).

## 11. Desktop app (when the address changes or for a new build)

```
BACKROOM_APP_URL=https://chat.example.com npm run build -w apps/desktop
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

## Free-tier limits (historical; spec section 13)

| Resource (Free) | Limit | Note |
|---|---|---|
| Worker requests | 100k/day | Cloudflare error 1027 past this |
| Worker CPU | 10 ms/request | no heavy server work |
| Request body | 100 MB | uploads capped at 25 MB |
| Durable Object requests | 100k/day | incoming WS messages billed 20:1 |
| D1 rows written | 100k/day | about 5 to 10 rows per message including FTS |
| D1 rows read | 5M/day | ample |
| D1 / DO storage | 5 GB total | text is small |
| Workers KV | 1 GB storage, 25 MiB per value, 100k reads/day, 1k writes/day, 1k deletes/day | files, thumbnails and custom emoji together capped at 900 MB per workspace; an image message is 2 writes and 1 read, plus 2 reads per viewer, so about 500 image messages a day; each 304 is a read; custom emoji uploads are capped at 200 a day per workspace (`429 emoji_daily_limit`), so a big emoji import takes several days but leaves about 800 writes for files; cron cleanup at most 200 deletes/day, so a big orphan backlog drains slowly |
| Static assets | 20,000 files, 25 MiB/file | about 3,700 emoji SVGs plus the app |
| Resend | about 100 emails/day | magic links only |

Past these, the Workers Paid plan ($5/month) needs no code changes.

## Troubleshooting

- **Sign-in email not arriving.** Check the Resend dashboard (logs, domain still verified, API key valid) and the admin "emails failed" banner. Requests are rate limited to 5 per hour per email address and 100 per hour per IP address (a group on one network shares an IP), so repeated attempts are silently held back. If the key was stored empty (see the step 5 warning), re-set it with the stdin form.
- **Cloudflare error 1027.** The daily Worker request limit was hit; it resets at 00:00 UTC.
- **`503 storage_busy` on upload** ("Storage has reached a free-tier limit. Try again later."). A KV daily limit (1k writes, 1k deletes or 100k reads) is used up; it resets at 00:00 UTC. `blob_leaked` log lines mean a cleanup delete hit the limit and left a blob behind.
- **`413 quota_exceeded`.** The workspace's files, thumbnails and custom emoji together reached 900 MB. Delete messages with large files (their files are removed by the next daily cron) or unused custom emoji.
- **Custom-domain deploy errors.** The zone must be on the same Cloudflare account, and the hostname must not already have an explicit DNS record (a wildcard record is fine). Remove a conflicting record, then deploy again.
- **Login redirects or cookies fail after deploy.** The deploy was probably a bare `wrangler deploy`, which ships `APP_ORIGIN=http://localhost:8787`. Redeploy with `npm run deploy -w apps/worker`.
