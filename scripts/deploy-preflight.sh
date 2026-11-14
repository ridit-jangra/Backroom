#!/usr/bin/env bash
# Read-only deploy preflight for Backroom. Makes no remote mutation:
# only `wrangler whoami`, `wrangler secret list` and `wrangler deploy --dry-run` run remotely/at all.
# Usage: scripts/deploy-preflight.sh [--quick]   (--quick skips `npm test`)
set -u
cd "$(dirname "$0")/.."

QUICK=0
[ "${1:-}" = "--quick" ] && QUICK=1

WRANGLER_CFG=apps/worker/wrangler.jsonc
WORKER_PKG=apps/worker/package.json
fail=0
ok()  { printf '  \xe2\x9c\x93 %s\n' "$1"; }
bad() { printf '  \xe2\x9c\x97 %s\n' "$1"; [ -n "${2:-}" ] && printf '      fix: %s\n' "$2"; fail=1; }

echo "Backroom deploy preflight (read-only)"

# 1. no placeholders left in wrangler.jsonc
if grep -v '^\s*//' "$WRANGLER_CFG" | grep -q '<set at deploy>'; then
  bad "wrangler.jsonc still has a '<set at deploy>' placeholder" \
      "npx wrangler kv namespace create BLOBS, then paste the id into kv_namespaces[0].id in $WRANGLER_CFG (D1: see docs/DEPLOY.md step 3)"
  KV_READY=0
else
  ok "wrangler.jsonc has no '<set at deploy>' placeholders (database_id and KV id set)"
  KV_READY=1
fi

# 2. EMAIL_FROM
from=$(grep -E '"EMAIL_FROM"' "$WRANGLER_CFG" | sed -E 's/.*"EMAIL_FROM"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')
if [ -z "$from" ]; then
  bad "EMAIL_FROM is not set in $WRANGLER_CFG vars" "set it to an address on your verified Resend domain"
elif printf '%s' "$from" | grep -qi 'example\.com'; then
  bad "EMAIL_FROM is the example.com placeholder ($from)" "use an address on your verified Resend domain"
else
  ok "EMAIL_FROM is set ($from)"
fi

# 3. deploy script flags
dep=$(grep -E '"deploy"[[:space:]]*:' "$WORKER_PKG" || true)
if printf '%s' "$dep" | grep -q -- '--var APP_ORIGIN:https://' && printf '%s' "$dep" | grep -q -- '--domain'; then
  ok "apps/worker deploy script passes --var APP_ORIGIN:https://... and --domain"
else
  bad "apps/worker deploy script lacks --var APP_ORIGIN:https://... or --domain" \
      "a bare deploy would ship APP_ORIGIN=http://localhost:8787 and break login"
fi

# 4. web build present (needed by the dry run)
if [ -f apps/web/dist/index.html ]; then
  WEB_READY=1; ok "web build exists (apps/web/dist/index.html)"
else
  WEB_READY=0; bad "web build is missing (apps/web/dist/index.html)" "npm run build -w apps/web"
fi

# 5. dry run
if [ "$KV_READY" = 1 ] && [ "$WEB_READY" = 1 ]; then
  if out=$(npm run deploy:dry-run -w apps/worker 2>&1); then
    ok "npm run deploy:dry-run succeeds (bundle builds, nothing uploaded)"
  else
    bad "npm run deploy:dry-run failed" "run it by hand to see the error"
    printf '%s\n' "$out" | tail -n 15 | sed 's/^/      | /'
  fi
else
  bad "deploy dry run skipped (needs the KV id set and the web build present)" "fix the items above, then re-run"
fi

# 6. wrangler login
if npx --no-install wrangler whoami >/dev/null 2>&1 || (cd apps/worker && npx --no-install wrangler whoami >/dev/null 2>&1); then
  ok "wrangler is logged in (whoami)"
else
  bad "wrangler whoami failed" "npx wrangler login"
fi

# 7. secrets (names only)
names=$(cd apps/worker && npx --no-install wrangler secret list 2>/dev/null | grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' | sed -E 's/.*"([^"]*)"$/\1/')
for s in RESEND_API_KEY OWNER_EMAIL; do
  if printf '%s\n' "$names" | grep -qx "$s"; then
    ok "secret $s is set on the Worker"
  else
    bad "secret $s is not set on the Worker" "printf '%s' 'VALUE' | npx wrangler secret put $s   (run in apps/worker)"
  fi
done

# 8. tests
if [ "$QUICK" = 1 ]; then
  echo "  - local test suites skipped (--quick)"
elif npm test >/dev/null 2>&1; then
  ok "local test suites pass (npm test)"
else
  bad "local test suites failed" "run npm test and fix the failures"
fi

echo
if [ "$fail" = 0 ]; then echo "PREFLIGHT OK"; else echo "PREFLIGHT FAILED"; fi
exit "$fail"
