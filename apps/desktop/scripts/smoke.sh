#!/usr/bin/env bash
# Desktop smoke test: boots the worker on :8788, launches the debug desktop
# binary against it and expects `smoke ok http://localhost:8788`.
#
# Exit codes: 0 pass, 1 fail, 2 xvfb-run missing (environment, not a code failure).
# --direct (or SMOKE_DIRECT=1) skips xvfb and uses the current display instead.
set -u

PORT=8788
ORIGIN="http://localhost:${PORT}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRATCH="${SMOKE_SCRATCH:-$(mktemp -d "${TMPDIR:-/tmp}/backroom-smoke.XXXXXX")}"
WORKER_LOG="$SCRATCH/wrangler.log"
BIN="$ROOT/apps/desktop/src-tauri/target/debug/backroom-desktop"

DIRECT="${SMOKE_DIRECT:-0}"
[ "${1:-}" = "--direct" ] && DIRECT=1

if [ "$DIRECT" != "1" ] && ! command -v xvfb-run >/dev/null 2>&1; then
  echo "xvfb-run not found; the desktop smoke test needs a virtual display." >&2
  echo "Install it (Arch: sudo pacman -S xorg-server-xvfb; Debian/Ubuntu: sudo apt install xvfb)," >&2
  echo "or run with --direct to use your current display." >&2
  exit 2
fi

WORKER_PID=""
cleanup() {
  if [ -n "$WORKER_PID" ]; then
    # setsid made the worker its own process group leader: stop only that group.
    kill -TERM -- "-$WORKER_PID" 2>/dev/null
    sleep 1
    kill -KILL -- "-$WORKER_PID" 2>/dev/null
  fi
}
trap cleanup EXIT

mkdir -p "$SCRATCH"

# Own XDG dirs: the smoke app never shares the user's WebKit profile, cookies
# or config, and restrict_data_dir only ever touches scratch directories.
export XDG_DATA_HOME="$SCRATCH/xdg-data" XDG_CACHE_HOME="$SCRATCH/xdg-cache" XDG_CONFIG_HOME="$SCRATCH/xdg-config"
mkdir -p "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME"

echo "building debug desktop binary for $ORIGIN"
BACKROOM_APP_URL="$ORIGIN" cargo build --manifest-path "$ROOT/apps/desktop/src-tauri/Cargo.toml" >"$SCRATCH/build.log" 2>&1 \
  || { echo "cargo build failed (see $SCRATCH/build.log)" >&2; exit 1; }

echo "starting worker on :$PORT (state in $SCRATCH)"
(cd "$ROOT/apps/worker" && exec setsid npx wrangler dev --port "$PORT" --inspector-port 9230 \
  --var "APP_ORIGIN:$ORIGIN" --var RESEND_API_KEY:dev --persist-to "$SCRATCH/state") >"$WORKER_LOG" 2>&1 &
WORKER_PID=$!

ready=0
for _ in $(seq 1 60); do
  if curl -fsS "$ORIGIN/health" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [ "$ready" != "1" ]; then
  echo "worker did not become healthy (see $WORKER_LOG)" >&2
  exit 1
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
