# Self-hosting Backroom

This guide covers running Backroom on a Linux server you control. Backroom is one Node.js process with a SQLite database and a folder of uploaded files on local disk. There is no external database, cache or object store to set up.

Contents: [Requirements](#requirements) · [Install](#install-from-source) · [Configuration](#configuration) · [Email](#email) · [Reverse proxy](#reverse-proxy) · [Running it](#running-it-as-a-service) · [First sign-in](#first-sign-in-and-invites) · [Maintenance](#daily-maintenance) · [Backups](#backups) · [Upgrades](#upgrades) · [Security](#security) · [Troubleshooting](#troubleshooting)

## Requirements

- Linux on x86-64 or ARM64 (a small VPS is enough for a group of a few dozen people).
- **Node.js 26 or newer** (Backroom uses the built-in `node:sqlite` module). Check with `node --version`.
- npm (ships with Node) and git, to build from source.
- Disk space for the database and uploads. By default each workspace may store up to 900 MB of files (`FILES_QUOTA_BYTES`).
- A domain name (for example `chat.example.com`) pointing at the server.
- A reverse proxy that terminates HTTPS: Caddy, nginx, or Cloudflare in front of one of those. See [Reverse proxy](#reverse-proxy).
- A [Resend](https://resend.com) account with a verified sending domain, for the sign-in emails.

Building the web app needs more memory than running the server (plan on about 1 GB free during `npm run build`). If your server is very small, build on another machine and copy the two build folders over (see [Directory layout](#directory-layout)).

## Install from source

The examples use `/opt/backroom` for the code, `/var/lib/backroom` for data and `/etc/backroom/backroom.env` for settings. The server runs as a dedicated `backroom` user that can write only to the data folder. You build as your normal (sudo-capable) user, so the code stays read-only for the service. Change the paths as you like.

```sh
sudo useradd --system --home-dir /var/lib/backroom --shell /usr/sbin/nologin backroom
sudo install -d -o backroom -g backroom -m 700 /var/lib/backroom
sudo install -d -o "$USER" -m 755 /opt/backroom
git clone <this repository's URL> /opt/backroom

cd /opt/backroom
npm ci                         # installs dependencies and generates the emoji table
npm run build -w apps/web      # -> apps/web/dist
npm run build -w apps/server   # -> apps/server/dist/server.mjs and dist/migrations/
```

### Directory layout

```
/opt/backroom/
  apps/server/dist/server.mjs      the whole server in one file (needs no node_modules at runtime)
  apps/server/dist/migrations/     SQL migrations, applied automatically at startup
  apps/web/dist/                   the web app the server serves (found automatically next to the server)
/var/lib/backroom/                 DATA_DIR (mode 700)
  backroom.sqlite                  the database (plus -wal and -shm files while the server runs)
  blobs/                           uploaded files, thumbnails and custom emoji
  blobs/.tmp/                      uploads in progress (cleaned at startup; never back this up)
  server.lock                      present while a server uses this folder
  maintenance.lock                 present while a maintenance run is going
/etc/backroom/backroom.env         settings (mode 600)
```

At runtime the server needs only `apps/server/dist/` and a web build. You can copy those two folders to another machine and run `node server.mjs --web-dist <path to the web build>` there.

## Configuration

The server reads its settings from environment variables. It does not load `.env` files by itself: use systemd's `EnvironmentFile=`, `node --env-file=<file>`, or export them in a shell. `apps/server/.env.example` lists every setting with comments. A typical production file:

```sh
# /etc/backroom/backroom.env  (chmod 600)
APP_ORIGIN=https://chat.example.com
OWNER_EMAIL=you@example.com
RESEND_API_KEY=re_xxxxxxxxxxxxxxxx
EMAIL_FROM="Backroom <backroom@example.com>"
DATA_DIR=/var/lib/backroom
PORT=8080
HOST=127.0.0.1
# TRUSTED_PROXY_HEADER=x-forwarded-for   # see "Client IP addresses" below
```

```sh
sudo install -d -m 755 /etc/backroom
sudo install -m 600 /dev/null /etc/backroom/backroom.env
sudoedit /etc/backroom/backroom.env
```

| Variable | Default | Meaning |
|---|---|---|
| `APP_ORIGIN` | required | The public URL people open, for example `https://chat.example.com`. http or https, no path, no trailing slash needed. Sign-in links point here, the API refuses requests whose `Origin` differs, and cookies are `Secure` when it is https. |
| `OWNER_EMAIL` | required | The workspace owner's email address. This person can sign in without an invite and creates the first invites. |
| `RESEND_API_KEY` | unset | Your Resend API key. When it is unset, empty or `dev`, the **console mailer** prints sign-in links to stdout instead of emailing them (development only; see [Email](#email)). |
| `EMAIL_FROM` | `Backroom <noreply@localhost>` | The sender of sign-in emails. It must be on a domain verified in Resend. Keep the double quotes in the env file (`EMAIL_FROM="Backroom <backroom@example.com>"`): unquoted, `<` is a redirect when a shell sources the file. |
| `DATA_DIR` | `./data` | Folder for `backroom.sqlite` and `blobs/`. Relative to the working directory. Created with mode 700. |
| `PORT` | `8080` | TCP port. |
| `HOST` | `127.0.0.1` | Listen address. The default accepts connections from the same machine only, which is right behind a local reverse proxy. Use `0.0.0.0` in a container whose port is published to a proxy outside it. |
| `TRUSTED_PROXY_HEADER` | unset | A header that holds the real client IP, set by your proxy: `x-forwarded-for` (the last address in it is used), `x-real-ip`, `cf-connecting-ip`, or another single-address header. Unset means the TCP peer address. Read [Client IP addresses](#client-ip-addresses) before setting it. |
| `TRUSTED_PROXY_SECRET` | unset | Optional, needs `TRUSTED_PROXY_HEADER`. At least 24 visible characters (`openssl rand -hex 32`). The trusted header is then believed only on requests carrying `X-Backroom-Origin-Secret: <secret>`. See [Cloudflare](#cloudflare-in-front). |
| `WEB_DIST` | `apps/web/dist` next to the bundle | The built web app. The `--web-dist <path>` flag overrides it. |
| `FILES_QUOTA_BYTES` | `943718400` (900 MB) | Storage per workspace for files, thumbnails and custom emoji together. |
| `FILE_MAX_BYTES` | `26214400` (25 MB) | Largest upload, and the largest request body the server accepts. The web app refuses files over 25 MB by itself, so raising this needs a client change; lowering it works as is. |
| `KEEP_ALIVE_TIMEOUT_MS` | `190000` | How long an idle keep-alive connection stays open. Keep it above your proxy's idle timeout for pooled upstream connections (so the proxy never reuses a connection the server is closing). |
| `MAX_CONNECTIONS` | `2048` | Open connections (WebSockets included) beyond which new ones are dropped. |

Fixed limits: a whole request must arrive within 15 minutes and its headers within 60 seconds.

Command-line flags:

| Flag | Meaning |
|---|---|
| `--web-dist <path>` | The built web app (instead of `WEB_DIST`). |
| `--maintenance` | Run the [daily maintenance](#daily-maintenance) once and exit. Uses the same environment as the server. |
| `--backup <dir>` | Take a [backup](#backups) into `<dir>` and exit. Needs only `DATA_DIR`. |
| `--keep <n>` | With `--backup`: how many database snapshots to keep (default 7). |

Configuration errors are all reported at once at startup, with what to fix. The server never prints the Resend key or the owner's address. At startup it prints one JSON line (`"code":"server_started"`) summarising the port, data folder, mailer, migrations applied and the next maintenance time.

## Email

Backroom sends exactly one kind of email: the sign-in link.

1. Create a Resend account and add your domain under Domains. Add the DNS records Resend shows (SPF and DKIM) and wait until the domain is verified. Resend will not send from an unverified domain.
2. Create an API key with "Sending access".
3. Set `RESEND_API_KEY` to the key and `EMAIL_FROM` to an address on the verified domain, for example `Backroom <backroom@example.com>`.

When a send fails, the server logs `{"level":"error","code":"email_failed"}` and admins see an "emails failed" notice in the web app.

**Console mailer (development).** Without `RESEND_API_KEY` (or with `RESEND_API_KEY=dev`) the server prints every sign-in link to stdout as `Sign-in link for <email>: <url>`. Anyone who can read the server's output can then sign in as anyone. Never run a public server like that. The server prints a warning at startup if the console mailer is active and `APP_ORIGIN` is https.

## Reverse proxy

Backroom speaks plain HTTP. Put a reverse proxy in front for HTTPS. Whichever you use, it must:

- pass WebSocket upgrades on `/ws` (the web app pings every 30 seconds, so any idle timeout above that works; 180 s is a comfortable value),
- accept request bodies of at least 25 MB (`FILE_MAX_BYTES`) plus a little room,
- not cache API responses (Backroom sets its own `Cache-Control` headers; proxies that respect them are fine).

The server ignores the incoming `Host` header and builds all URLs from `APP_ORIGIN`, so no `Host` or `X-Forwarded-Proto` setup is needed for correctness.

### Caddy

Caddy gets a certificate automatically and proxies WebSockets without extra settings. Caddy has no body size limit by default; the `request_body` block below caps it just above Backroom's 25 MB limit.

```caddy
chat.example.com {
	request_body {
		max_size 26MiB
	}
	reverse_proxy 127.0.0.1:8080
}
```

Caddy sends the client address in `X-Forwarded-For` and, unless you configure `trusted_proxies`, ignores any `X-Forwarded-For` the client sent. Set `TRUSTED_PROXY_HEADER=x-forwarded-for`. Caddy's pooled upstream connections idle out after 2 minutes, below the server's default 190 s keep-alive.

### nginx

```nginx
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;                     # nginx 1.25.1+; older versions: listen 443 ssl http2;
    server_name chat.example.com;

    ssl_certificate     /etc/letsencrypt/live/chat.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/chat.example.com/privkey.pem;

    # Uploads are up to 25 MB (26214400 bytes); nginx's default is 1 MB.
    client_max_body_size 26m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 180s;
        proxy_send_timeout 180s;
    }

    # Real-time connection. Without the Upgrade/Connection headers the web app
    # stays on "Reconnecting...".
    location = /ws {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 180s;
        proxy_send_timeout 180s;
    }
}

server {
    listen 80;
    listen [::]:80;
    server_name chat.example.com;
    return 301 https://$host$request_uri;
}
```

Notes:

- With `TRUSTED_PROXY_HEADER=x-forwarded-for`, Backroom uses the **last** address in the header. `$proxy_add_x_forwarded_for` appends the address nginx saw, so the last entry is always nginx's view of the client, whatever the client sent. If you prefer, send `proxy_set_header X-Real-IP $remote_addr;` and use `TRUSTED_PROXY_HEADER=x-real-ip`.
- If nginx itself sits behind another proxy (a load balancer, Cloudflare), the last hop is that proxy, not the visitor. Use the header the outermost proxy sets (for Cloudflare, `cf-connecting-ip`), or nginx's `real_ip` module.
- `proxy_request_buffering` is on by default. nginx then receives a whole upload (to memory or a temp file) before passing it on. That protects the Node process from slow clients, but the upload progress bar reaches 100% before Backroom has seen the file, and nginx needs temp space. `proxy_request_buffering off;` in `location /` streams uploads straight through instead. Both work.
- A plain `GET /ws` without an upgrade gets `426 Upgrade Required` from Backroom. That is expected.
- If you enable upstream keep-alive (`upstream { keepalive ...; }` with `proxy_set_header Connection "";`), keep `keepalive_timeout` in the upstream block below `KEEP_ALIVE_TIMEOUT_MS` (190 s by default).

### Cloudflare in front

You can put Cloudflare's proxy (the orange cloud) in front of your server, usually in front of Caddy or nginx, or use a Cloudflare Tunnel. Backroom still runs on your server; Cloudflare only forwards traffic.

- **SSL/TLS mode.** Use **Full (strict)**. Cloudflare then talks HTTPS to your server and checks its certificate (a Let's Encrypt certificate from Caddy or certbot, or a free Cloudflare Origin CA certificate). **Flexible** sends traffic from Cloudflare to your server unencrypted over the internet. Only use it if your server cannot terminate TLS, and know that anyone between Cloudflare and you can read it. `APP_ORIGIN` is the https URL either way.
- **WebSockets** are on by default for all plans (Network → WebSockets). Proxied connections idle out after about 100 seconds without traffic; the web app's 30-second ping keeps them open.
- **Uploads.** The Free plan accepts request bodies up to 100 MB, above Backroom's 25 MB.
- **Client IP.** Cloudflare sends the visitor's address in `CF-Connecting-IP`. Set `TRUSTED_PROXY_HEADER=cf-connecting-ip` (nginx and Caddy pass that header through unchanged).

**Warning: forged client IPs.** `CF-Connecting-IP` is just a request header. If your server (or the proxy in front of it) can also be reached directly, not only through Cloudflare, anyone can send their own `CF-Connecting-IP` and get a fresh rate-limit bucket for every request, which defeats the sign-in limits. Close that hole in one of these ways:

1. Allow inbound 80/443 only from [Cloudflare's IP ranges](https://www.cloudflare.com/ips/) in your firewall, or use a Cloudflare Tunnel, so nothing else can reach the proxy.
2. Or set `TRUSTED_PROXY_SECRET` and let Cloudflare add a secret header that outsiders cannot know:
   1. On the server, generate a secret with `openssl rand -hex 32`. Add `TRUSTED_PROXY_SECRET=<it>` to the env file, next to `TRUSTED_PROXY_HEADER=cf-connecting-ip`.
   2. In the Cloudflare dashboard, open your zone, then Rules → Transform Rules → Modify Request Header → Create rule. Name: "Backroom origin secret". Choose "Custom filter expression": Hostname equals `chat.example.com`. Then "Set static", header name `X-Backroom-Origin-Secret`, value: the secret. Deploy.
   3. Restart Backroom.

   Backroom then believes `CF-Connecting-IP` only on requests that carry the right secret. It strips the secret header before the application sees it and never logs it. Requests without the secret are rate limited by their TCP peer address, as if no trusted header were set. Deploy the Transform Rule before or together with the env change; in between, all visitors share the proxy's rate-limit bucket. To rotate the secret, change both places.

**Cloudflare Tunnel.** `cloudflared` connects out from your server, so you need no open inbound port and no certificate on the server. Point the tunnel's public hostname at `http://127.0.0.1:8080` (WebSockets work through tunnels). Keep `HOST=127.0.0.1`. `cf-connecting-ip` is then safe to trust, as long as no untrusted local user or process on the same machine can connect to the port. On a shared machine, use `TRUSTED_PROXY_SECRET` as well.

## Running it as a service

Backroom shuts down gracefully on `SIGTERM` or `SIGINT`. It stops accepting connections, closes WebSockets with code 1001 (the web app reconnects by itself), finishes in-flight requests (up to about 10 seconds), checkpoints the database and exits 0. A second signal forces an immediate exit.

Only one server may use a data folder at a time: a second one refuses to start (`server.lock`).

### systemd

```ini
# /etc/systemd/system/backroom.service
[Unit]
Description=Backroom chat server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=backroom
Group=backroom
WorkingDirectory=/opt/backroom
EnvironmentFile=/etc/backroom/backroom.env
# Use the full path of your Node 26 binary (`command -v node`).
ExecStart=/usr/bin/node /opt/backroom/apps/server/dist/server.mjs
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30
# Daily maintenance runs at 04:00 in this time zone (the server's local time if unset).
# Environment=TZ=Europe/Berlin

# Hardening
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/backroom
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
SystemCallArchitectures=native
CapabilityBoundingSet=
UMask=0077
# Do not add MemoryDenyWriteExecute=yes: Node's JIT compiler needs writable and executable memory.

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now backroom
systemctl status backroom
journalctl -u backroom -f          # the server logs JSON lines to stdout
```

If the data folder is not under `/var/lib/backroom`, change `ReadWritePaths`. Port 8080 needs no capabilities; to bind to a port below 1024 you would need `AmbientCapabilities=CAP_NET_BIND_SERVICE` (better: keep the proxy on 80/443).

### Without systemd (containers, shared hosts)

`scripts/run-forever.sh` is a small POSIX shell supervisor. It:

- restarts the server when it exits with an error, waiting 1, 2, 4 … up to 60 seconds between attempts (the delay resets after 5 minutes of uptime),
- appends the server's output to a log file and rotates it by size (copy and truncate, 10 MiB, 5 old files by default),
- forwards `SIGTERM`, `SIGINT` and `SIGHUP` to the server and exits with its status.

A server that exits with status 0 (a deliberate shutdown) is not restarted.

In a container you usually run everything as one user. This example keeps the code in `~/backroom`, the data in `~/backroom-data` and the settings in `~/backroom.env` (mode 600, owned by that user):

```sh
cd ~/backroom
set -a; . ~/backroom.env; set +a
LOG_FILE=~/backroom-data/server.log nohup scripts/run-forever.sh node apps/server/dist/server.mjs >/dev/null 2>&1 &
```

To start it at boot without systemd, use the container's entrypoint (run it in the foreground there, without `nohup … &`), or a crontab line such as:

```cron
@reboot cd ~/backroom && set -a && . ~/backroom.env && set +a && LOG_FILE=~/backroom-data/server.log nohup scripts/run-forever.sh node apps/server/dist/server.mjs >/dev/null 2>&1 &
```

Whether `@reboot` runs depends on the container: many containers start no cron daemon. Check what survives a restart of your container.
Stop it with `kill <pid of run-forever.sh>`; the server shuts down gracefully and the supervisor exits. Settings: `LOG_FILE`, `LOG_MAX_BYTES`, `LOG_KEEP`, `LOG_CHECK_SECONDS`, `RESTART_DELAY_MAX`, `RESTART_RESET_SECONDS` (see the top of the script).

## First sign-in and invites

1. Open `APP_ORIGIN` in a browser and enter the `OWNER_EMAIL` address. Only the owner can sign in without an invite.
2. Click the link in the email, then "Sign in". You land in the workspace's `#general` channel.
3. Open **Admin** (in the sidebar) and create an invite. Send its link to the person. They open it, enter their email, and sign in with the emailed link. The same page lists and revokes invites and manages members (roles, deactivation).

Sign-in links expire after 15 minutes and work once.

## Daily maintenance

The server runs maintenance every day at **04:00 server local time** (set `TZ` to choose the zone; the startup line shows `nextMaintenance`). It removes uploads that were never attached to a message after 24 hours (at most 200 files per run; the rest wait for the next day), and expired sessions, used or expired sign-in tokens and desktop codes, and old rate-limit rows.

To run it by hand (it needs the same environment as the server, and is safe while the server runs). The env file is readable by root only, so read it as root and run Node as the `backroom` user, so that files in the data folder keep their owner:

```sh
sudo sh -c 'set -a; . /etc/backroom/backroom.env; set +a; exec setpriv --reuid=backroom --regid=backroom --init-groups node /opt/backroom/apps/server/dist/server.mjs --maintenance'
```

`--maintenance` never migrates the database or touches uploads in progress. It refuses to run if the server has never started on that data folder, or if migrations are pending (start the server once, which applies them).

## Backups

```sh
DATA_DIR=/var/lib/backroom node /opt/backroom/apps/server/dist/server.mjs --backup /var/backups/backroom --keep 7
```

What it does:

1. Copies the database with SQLite's online backup API into `/var/backups/backroom/backroom-<UTC time>.sqlite`, for example `backroom-20261114T031500Z.sqlite` (mode 600). The copy is a consistent snapshot even while the server is writing.
2. Checks the copy with `PRAGMA integrity_check`. Only a copy that passes is kept. Otherwise it is deleted and the command exits with status 1 (and older snapshots are left alone).
3. Mirrors `DATA_DIR/blobs` into `/var/backups/backroom/blobs`, incrementally. Uploaded files never change once written, so files already in the mirror are skipped. On the same filesystem it uses hardlinks (no extra space). Elsewhere it copies. Uploads in progress (`blobs/.tmp`) are skipped. Files deleted on the server stay in the mirror, so older snapshots keep their files.
4. Deletes all but the newest `--keep` snapshots (default 7).

It needs only `DATA_DIR` (not the rest of the settings). It is safe to run while the server runs: it never takes `server.lock`, never migrates and never writes into the data folder. It prints JSON lines with sizes and counts, never file names or contents.

A daily cron entry for the `backroom` user (`sudo crontab -u backroom -e`):

```cron
15 3 * * * DATA_DIR=/var/lib/backroom /usr/bin/node /opt/backroom/apps/server/dist/server.mjs --backup /var/backups/backroom --keep 7 >>/var/backups/backroom/backup.log 2>&1
```

Create the folder first: `sudo install -d -o backroom -g backroom -m 700 /var/backups/backroom`.

**Keep a copy off the machine.** A backup on the same disk does not survive the disk, and hardlinked files are the same bytes as the live ones. Copy the backup folder elsewhere regularly, for example with `rsync -aH --delete /var/backups/backroom/ backup-host:backroom/` (`-H` keeps hardlinks as hardlinks).

### Restore

1. Stop the server: `sudo systemctl stop backroom` (or stop `run-forever.sh`).
2. Move the current database aside, together with its WAL and SHM files:

   ```sh
   cd /var/lib/backroom
   sudo -u backroom mkdir -p broken
   sudo -u backroom mv backroom.sqlite backroom.sqlite-wal backroom.sqlite-shm broken/ 2>/dev/null
   ```

   Never put a snapshot next to an old `backroom.sqlite-wal`: SQLite would try to apply that WAL to the wrong database.
3. Copy the snapshot in:

   ```sh
   sudo install -o backroom -g backroom -m 600 /var/backups/backroom/backroom-20261114T031500Z.sqlite /var/lib/backroom/backroom.sqlite
   ```

4. If files were lost too, copy the mirror back: `sudo -u backroom cp -an /var/backups/backroom/blobs/. /var/lib/backroom/blobs/` (`-n` never overwrites).
5. Start the server. It applies any newer migrations and switches the database back to WAL mode. Mirror files for uploads that were deleted after the snapshot was taken are harmless: they take disk space but are not counted against the quota.

## Upgrades

1. Take a backup (see above).
2. Stop the server.
3. Update and rebuild:

   ```sh
   cd /opt/backroom
   git pull
   npm ci
   npm run build -w apps/web
   npm run build -w apps/server
   ```

4. Start the server. New database migrations run automatically at startup, and the startup line shows how many were applied (`migrationsApplied`). If a migration fails, the server exits with the file name and SQLite's error, and the database is left as it was before that migration.

Read the release notes for changed settings. Migrations only move forward. To go back to an older version, restore the backup taken in step 1.

## Security

- **Client IP addresses.** Rate limits (sign-in requests: 5 per hour per email address and 100 per hour per IP; desktop code exchanges: 30 per hour per IP) key on the client address. Without `TRUSTED_PROXY_HEADER` that is the TCP peer, which is your proxy's address when you run behind one: all visitors then share one bucket. That is safe, but the per-IP limit becomes a site-wide one. With `TRUSTED_PROXY_HEADER`, any client-sent copy of that header is replaced, so clients cannot inject their own value through your proxy. **But anyone who can reach the server's port (or the proxy) directly can.** Only set it when the server is reachable through your proxy alone (`HOST=127.0.0.1` behind a local proxy, a firewall, a tunnel), or add `TRUSTED_PROXY_SECRET`.
- **Data folder.** `DATA_DIR` and `blobs/` are created with mode 700 and owned by the user running the server. The database holds email addresses and every message, so keep the folder and your backups private.
- **Settings file.** Keep it at mode 600 (it holds the Resend API key). The server never prints the key.
- **Console mailer.** Never run a reachable server without `RESEND_API_KEY`: sign-in links would go to the log.
- **Listen address.** Keep `HOST=127.0.0.1` unless something outside the machine must connect directly.
- **Logs.** Backroom logs JSON lines without message bodies, email addresses, tokens or file names. It writes no access log, because sign-in URLs carry tokens. If your reverse proxy writes access logs, they contain `/verify?t=...` URLs: those tokens are single-use and expire after 15 minutes, but treat the logs as sensitive.
- **Updates.** Keep Node.js and your proxy updated, and upgrade Backroom when security fixes are released.

## Troubleshooting

**The sign-in email does not arrive.**
- Check the startup line: `"mailer":"console"` means `RESEND_API_KEY` is not set, and the links are in the server log instead.
- Look for `"code":"email_failed"` in the log. Then check the Resend dashboard: the send, the domain still verified, the key valid, and `EMAIL_FROM` on that domain.
- Only `OWNER_EMAIL` (compared case-insensitively) and people with a valid invite get a link. The page says "check your email" either way, so it reveals nothing.
- Requests over the rate limit (5 per hour per address, 100 per hour per IP) are silently dropped. Behind a proxy without `TRUSTED_PROXY_HEADER`, the per-IP limit is shared by everyone.
- Check the spam folder.

**The web app keeps showing "Reconnecting..." or WebSockets drop.**
- nginx: the `/ws` location needs `proxy_http_version 1.1` and the `Upgrade`/`Connection` headers shown above. To test the path, send an upgrade request without a cookie: `curl -si -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' https://chat.example.com/ws | head -1`. A `401` (sign-in required) means the upgrade headers reached Backroom. A `426` (upgrade required) means the proxy dropped them.
- An idle timeout under 30 seconds somewhere on the path (proxy, load balancer) cuts connections between pings. Use 180 s.
- Behind Cloudflare, check that WebSockets are enabled for the zone.

**Uploads fail with 413.**
- An HTML 413 page comes from your proxy: raise `client_max_body_size` (nginx) or `request_body max_size` (Caddy) to at least 26 MB.
- A JSON 413 with "Files must be 25 MB or smaller." comes from Backroom (`FILE_MAX_BYTES`). "quota_exceeded" means the workspace reached `FILES_QUOTA_BYTES`: delete messages with large files (their files go at the next maintenance) or unused custom emoji, or raise the quota.

**`cannot listen on 127.0.0.1:8080 (EADDRINUSE)`.**
Something else uses the port. Find it with `ss -ltnp 'sport = :8080'`. It may be an older Backroom still running (systemd and a manual start at the same time?). Stop it or choose another `PORT`, and update the proxy.

**`another Backroom server (see …/server.lock) is using this DATA_DIR`.**
A server is already running on that data folder. Stop it first. A lock left behind by a crashed server is detected (dead process, or a reused process id) and taken over automatically, so you should not need to delete the file by hand. Only remove `server.lock` if you are sure no Backroom process uses the folder (`pgrep -af server.mjs`).

**The server exits at startup with a configuration error.**
The message lists every problem, for example `APP_ORIGIN must be an http or https URL with no path, query or fragment`. Fix the env file and start again. `the web build at … has no index.html` means the web app was not built: run `npm run build -w apps/web` or point `WEB_DIST`/`--web-dist` at a build.

**Sign-in works but you are logged out at once, or the API answers 403.**
`APP_ORIGIN` must match the address in the browser exactly (scheme, host and port, no `www.` difference). Requests from another origin are refused by design.
