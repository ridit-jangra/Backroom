#!/usr/bin/env bash
# Desktop smoke test: starts the Node server (apps/server) on :8788 with a scratch data folder and the console
# mailer, launches the debug desktop binary against it and expects `smoke ok http://localhost:8788`.
#
# Exit codes: 0 pass, 1 fail, 2 xvfb-run missing (environment, not a code failure).
# --direct (or SMOKE_DIRECT=1) skips xvfb and uses the current display instead.
# --server-only (or SMOKE_SERVER_ONLY=1) only builds and starts the server, checks /health and the console mailer,
#   stops it and exits (no cargo build, no display): a quick check of the server part.
# SMOKE_WEB_DIST: the web build to serve (default apps/web/dist if it has index.html, else a scratch build).
set -u

PORT=8788
ORIGIN="http://localhost:${PORT}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRATCH="${SMOKE_SCRATCH:-$(mktemp -d "${TMPDIR:-/tmp}/backroom-smoke.XXXXXX")}"
SERVER_LOG="$SCRATCH/server.log"
SERVER_DIST="$SCRATCH/server"
BIN="$ROOT/apps/desktop/src-tauri/target/debug/backroom-desktop"

DIRECT="${SMOKE_DIRECT:-0}"
SERVER_ONLY="${SMOKE_SERVER_ONLY:-0}"
for arg in "$@"; do
  case "$arg" in
    --direct) DIRECT=1 ;;
    --server-only) SERVER_ONLY=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 1 ;;
  esac
done

if [ "$SERVER_ONLY" != "1" ] && [ "$DIRECT" != "1" ] && ! command -v xvfb-run >/dev/null 2>&1; then
  echo "xvfb-run not found; the desktop smoke test needs a virtual display." >&2
  echo "Install it (Arch: sudo pacman -S xorg-server-xvfb; Debian/Ubuntu: sudo apt install xvfb)," >&2
  echo "or run with --direct to use your current display." >&2
  exit 2
fi

SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ]; then
    # setsid made the server its own process group leader: stop only that group. Graceful shutdown takes up to ~11 s.
    kill -TERM -- "-$SERVER_PID" 2>/dev/null
    for _ in $(seq 1 30); do
      kill -0 -- "-$SERVER_PID" 2>/dev/null || break
      sleep 0.5
    done
    kill -KILL -- "-$SERVER_PID" 2>/dev/null
    SERVER_PID=""
  fi
}
trap cleanup EXIT
trap 'exit 1' INT TERM

mkdir -p "$SCRATCH"

if curl -fsS --max-time 2 "$ORIGIN/health" >/dev/null 2>&1; then
  echo "port $PORT is already serving; stop that server first" >&2
  exit 1
fi

if [ "$SERVER_ONLY" != "1" ]; then
  # Own XDG dirs: the smoke app never shares the user's WebKit profile, cookies
  # or config, and restrict_data_dir only ever touches scratch directories.
  export XDG_DATA_HOME="$SCRATCH/xdg-data" XDG_CACHE_HOME="$SCRATCH/xdg-cache" XDG_CONFIG_HOME="$SCRATCH/xdg-config"
  mkdir -p "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME"

  echo "building debug desktop binary for $ORIGIN"
  BACKROOM_APP_URL="$ORIGIN" cargo build --manifest-path "$ROOT/apps/desktop/src-tauri/Cargo.toml" >"$SCRATCH/build.log" 2>&1 \
    || { echo "cargo build failed (see $SCRATCH/build.log)" >&2; exit 1; }
fi

WEB_DIST="${SMOKE_WEB_DIST:-$ROOT/apps/web/dist}"
if [ ! -f "$WEB_DIST/index.html" ]; then
  WEB_DIST="$SCRATCH/web"
  echo "building the web app into $WEB_DIST"
  (cd "$ROOT/apps/web" && npm run build -- --outDir "$WEB_DIST" --emptyOutDir) >"$SCRATCH/web-build.log" 2>&1 \
    || { echo "web build failed (see $SCRATCH/web-build.log)" >&2; exit 1; }
fi

echo "building the server into $SERVER_DIST"
(cd "$ROOT/apps/server" && npm run build -- --outdir "$SERVER_DIST") >"$SCRATCH/server-build.log" 2>&1 \
  || { echo "server build failed (see $SCRATCH/server-build.log)" >&2; exit 1; }

# RESEND_API_KEY=dev selects the console mailer: no email ever leaves the machine. env -i keeps anything from the
# caller's environment (a real key, another DATA_DIR) away from the server.
MAILER_KEY=dev
if [ "$MAILER_KEY" != "dev" ]; then
  echo "refusing to start the server without RESEND_API_KEY=dev (real emails would be sent)" >&2
  exit 1
fi
echo "starting the server on :$PORT (data in $SCRATCH/data)"
setsid env -i PATH="$PATH" HOME="${HOME:-/tmp}" \
  APP_ORIGIN="$ORIGIN" OWNER_EMAIL=owner@smoke.test RESEND_API_KEY="$MAILER_KEY" \
  DATA_DIR="$SCRATCH/data" PORT="$PORT" HOST=127.0.0.1 WEB_DIST="$WEB_DIST" \
  node "$SERVER_DIST/server.mjs" >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

ready=0
for _ in $(seq 1 60); do
  if curl -fsS --max-time 2 "$ORIGIN/health" >/dev/null 2>&1; then ready=1; break; fi
  kill -0 "$SERVER_PID" 2>/dev/null || break
  sleep 1
done
if [ "$ready" != "1" ]; then
  echo "the server did not become healthy (see $SERVER_LOG)" >&2
  exit 1
fi
if ! grep -q '"code":"server_started".*"mailer":"console"' "$SERVER_LOG"; then
  echo "the server did not report the console mailer; stopping it (see $SERVER_LOG)" >&2
  exit 1
fi

if [ "$SERVER_ONLY" = "1" ]; then
  echo "server ok $ORIGIN"
  exit 0
fi

echo "launching desktop binary"
if [ "$DIRECT" = "1" ]; then
  OUT="$(BACKROOM_SMOKE=1 timeout -k 5 45 "$BIN" 2>"$SCRATCH/app.err")"
else
  OUT="$(BACKROOM_SMOKE=1 timeout -k 5 45 xvfb-run -a "$BIN" 2>"$SCRATCH/app.err")"
fi
STATUS=$?
echo "$OUT"

if [ "$STATUS" -eq 0 ] && printf '%s\n' "$OUT" | grep -qx "smoke ok $ORIGIN"; then
  exit 0
fi
if [ "$STATUS" -eq 0 ]; then
  echo "launch exited 0 without loading (handed off to a running Backroom instance?)" >&2
fi
echo "smoke failed (exit $STATUS; stderr in $SCRATCH/app.err)" >&2
exit 1
