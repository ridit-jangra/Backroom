#!/bin/sh
# run-forever.sh: a small supervisor for hosts without systemd (containers, shared hosts).
#
#   scripts/run-forever.sh <command> [args...]
#   e.g. LOG_FILE=/srv/backroom/logs/server.log scripts/run-forever.sh node /srv/backroom/server/server.mjs
#
# - Runs the command with its stdout and stderr appended to LOG_FILE.
# - Restarts it when it exits with a non-zero status (a crash, or a kill by the OOM killer), waiting 1 s, 2 s,
#   4 s ... up to RESTART_DELAY_MAX between attempts. The delay resets after the child ran for RESTART_RESET_SECONDS.
# - A child that exits with status 0 is a deliberate stop: the supervisor exits too.
# - SIGTERM, SIGINT or SIGHUP to the supervisor are forwarded to the child as SIGTERM; the supervisor waits for it
#   and exits with the child's status (Backroom shuts down gracefully on SIGTERM and exits 0).
# - Rotates LOG_FILE when it grows past LOG_MAX_BYTES (checked every LOG_CHECK_SECONDS): the file is copied to
#   LOG_FILE.1 (older copies shift to .2 ... LOG_KEEP) and truncated in place. The child appends, so it keeps writing
#   to the same file; lines written during the copy itself can be lost.
#
# Settings (environment):
#   LOG_FILE               default ./backroom.log
#   LOG_MAX_BYTES          default 10485760 (10 MiB)
#   LOG_KEEP               default 5
#   LOG_CHECK_SECONDS      default 60
#   RESTART_DELAY_MAX      default 60
#   RESTART_RESET_SECONDS  default 300
#
# Start it at boot however the host allows (cron's @reboot, the container's entrypoint, a login script), e.g.
#   @reboot cd /srv/backroom && set -a && . ./backroom.env && set +a && nohup scripts/run-forever.sh node server/server.mjs >/dev/null 2>&1 &

set -u

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <command> [args...]" >&2
  exit 2
fi

LOG_FILE=${LOG_FILE:-./backroom.log}
LOG_MAX_BYTES=${LOG_MAX_BYTES:-10485760}
LOG_KEEP=${LOG_KEEP:-5}
LOG_CHECK_SECONDS=${LOG_CHECK_SECONDS:-60}
RESTART_DELAY_MAX=${RESTART_DELAY_MAX:-60}
RESTART_RESET_SECONDS=${RESTART_RESET_SECONDS:-300}

child=""
stopping=0

# An unwritable log would make every start fail at the redirect and loop forever without a trace.
if ! ( : >>"$LOG_FILE" ) 2>/dev/null; then
  echo "run-forever: cannot write to LOG_FILE ($LOG_FILE)" >&2
  exit 2
fi

say() {
  printf '%s run-forever: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >>"$LOG_FILE"
}

on_signal() {
  stopping=1
  if [ -n "$child" ]; then
    kill -TERM "$child" 2>/dev/null
  fi
}
trap on_signal TERM INT HUP

rotate_if_needed() {
  [ -f "$LOG_FILE" ] || return 0
  size=$(wc -c <"$LOG_FILE" 2>/dev/null || echo 0)
  [ "$size" -gt "$LOG_MAX_BYTES" ] || return 0
  i=$LOG_KEEP
  rm -f "$LOG_FILE.$i"
  while [ "$i" -gt 1 ]; do
    prev=$((i - 1))
    if [ -f "$LOG_FILE.$prev" ]; then
      mv -f "$LOG_FILE.$prev" "$LOG_FILE.$i"
    fi
    i=$prev
  done
  cp -p "$LOG_FILE" "$LOG_FILE.1" && : >"$LOG_FILE"
}

# Sleeps in the background so a signal interrupts the wait at once.
pause() {
  sleep "$1" &
  wait "$!" 2>/dev/null
}

delay=1
while :; do
  if [ "$stopping" -eq 1 ]; then
    say "stopped before starting the child"
    exit 0
  fi
  rotate_if_needed
  started=$(date +%s)
  "$@" >>"$LOG_FILE" 2>&1 &
  child=$!
  # A signal that arrived before `child` was set found nothing to forward: forward it now.
  if [ "$stopping" -eq 1 ]; then
    kill -TERM "$child" 2>/dev/null
  fi
  say "started pid $child"

  # Wait for the child, checking the log size every LOG_CHECK_SECONDS. `wait` returns early when a trapped signal
  # arrives; the loop then keeps waiting until the child has really exited.
  waited=0
  while kill -0 "$child" 2>/dev/null; do
    pause 1
    waited=$((waited + 1))
    if [ "$waited" -ge "$LOG_CHECK_SECONDS" ]; then
      rotate_if_needed
      waited=0
    fi
  done
  wait "$child"
  status=$?
  child=""

  if [ "$stopping" -eq 1 ]; then
    say "stopped (child exited with status $status)"
    exit "$status"
  fi
  if [ "$status" -eq 0 ]; then
    say "child exited with status 0; not restarting"
    exit 0
  fi

  ran=$(($(date +%s) - started))
  if [ "$ran" -ge "$RESTART_RESET_SECONDS" ]; then
    delay=1
  fi
  say "child exited with status $status; restarting in ${delay}s"
  pause "$delay"
  if [ "$stopping" -eq 1 ]; then
    say "stopped while waiting to restart"
    exit 0
  fi
  delay=$((delay * 2))
  if [ "$delay" -gt "$RESTART_DELAY_MAX" ]; then
    delay=$RESTART_DELAY_MAX
  fi
done
