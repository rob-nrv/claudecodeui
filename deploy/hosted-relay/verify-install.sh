#!/usr/bin/env bash
# Linux install + build + run verification of the Hosted Relay, from a clean checkout.
# Safe to run on the VPS BEFORE enabling the service: it uses a temporary database, loopback
# ports 39001/39443 and touches nothing else. Run as the user that will own /opt/cloudcli-relay:
#   cd /opt/cloudcli-relay && bash deploy/hosted-relay/verify-install.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
fail=0
ok() { echo "PASS  $1"; }
ko() { echo "FAIL  $1"; fail=1; }
check() { if eval "$2" >/dev/null 2>&1; then ok "$1"; else ko "$1"; fi; }

[ "$(uname -s)" = "Linux" ] && ok "running on Linux ($(uname -sr))" || ko "not Linux: this proves nothing about the VPS"
node -e "process.exit(Number(process.versions.node.split('.')[0]) === Number(require('fs').readFileSync('.nvmrc','utf8').trim().replace(/^v/,'').split('.')[0]) ? 0 : 1)" \
  && ok "node $(node -v) matches .nvmrc" || ko "node $(node -v) does not match .nvmrc ($(cat .nvmrc))"

HUSKY=0 ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund --replace-registry-host=always >/tmp/relay-npm-ci.log 2>&1 \
  && ok "npm ci (log: /tmp/relay-npm-ci.log)" || { ko "npm ci failed, see /tmp/relay-npm-ci.log"; exit 1; }
node -e "const D=require('better-sqlite3');new D(':memory:').exec('select 1');require('bcrypt').hashSync('x',4)" \
  && ok "native modules load (better-sqlite3, bcrypt)" || ko "native module load failed (build-essential/python3 installed?)"
npm run build >/tmp/relay-build.log 2>&1 && ok "npm run build (log: /tmp/relay-build.log)" || { ko "build failed, see /tmp/relay-build.log"; exit 1; }
[ -f dist/index.html ] && [ -f dist-server/server/relay.js ] && ok "dist and dist-server present" || ko "build output missing"

T="$(mktemp -d)"
trap 'kill "${PID:-0}" 2>/dev/null; rm -rf "$T"' EXIT
HOME="$T" DATABASE_PATH="$T/relay.db" SERVER_PORT=39001 CLOUDCLI_REMOTE_GATEWAY=external-tls \
  CLOUDCLI_REMOTE_ORIGIN=https://relay.verify.invalid CLOUDCLI_REMOTE_PORT=39443 NODE_ENV=production \
  node dist-server/server/relay.js >"$T/relay.log" 2>&1 &
PID=$!
for _ in $(seq 1 40); do curl -fs http://127.0.0.1:39001/health >/dev/null 2>&1 && break; sleep 0.5; done

health="$(curl -s http://127.0.0.1:39001/health)"
echo "$health" | grep -q '"role":"hosted-relay"' && echo "$health" | grep -q '"ready":true' && ok "service started: /health = hosted-relay, ready" || { ko "service did not become ready"; cat "$T/relay.log"; }
grep -q "Remote gateway (external-tls)" "$T/relay.log" && ok "external-tls gateway is listening" || ko "gateway not listening"
grep -q "CLOUDCLI_SOURCE_URL" "$T/relay.log" && ok "startup warns that CLOUDCLI_SOURCE_URL is unset (expected in this check)" || ko "no source-URL warning"

# What is actually loaded, through the gateway, as a proxy would call it.
gw() { curl -s -o /dev/null -w '%{http_code}' -H 'X-Forwarded-For: 203.0.113.9' "$@"; }
[ "$(gw http://127.0.0.1:39443/api/projects)" = "401" ] && ok "gateway: unauthenticated /api/projects -> 401" || ko "gateway: /api/projects not 401"
[ "$(gw -X POST -H 'Origin: https://relay.verify.invalid' -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:39443/api/auth/login)" = "403" ] && ok "gateway: password login refused remotely" || ko "gateway: login not refused"
[ "$(gw http://127.0.0.1:39443/source)" = "404" ] && ok "/source is an explicit 404 while unset (no invented URL)" || ko "/source not 404"
csp="$(curl -s -D - -o /dev/null http://127.0.0.1:39443/ | tr -d '\r' | grep -i '^content-security-policy')"
echo "$csp" | grep -q "default-src 'self'" && echo "$csp" | grep -q "sha256-" && ok "client page served with CSP incl. hashed inline script" || ko "CSP missing"
ss -ltn 2>/dev/null | grep -E ':(39001|39443)\b' | grep -vq '127.0.0.1' && ko "a relay port listens on a non-loopback address" || ok "relay ports listen on loopback only"
[ -z "$(pgrep -P "$PID")" ] && ok "relay started no child process" || ko "relay has child processes: $(pgrep -P "$PID" | tr '\n' ' ')"
[ -z "$(find "$T" -maxdepth 1 -mindepth 1 ! -name relay.db\* ! -name relay.log ! -name .cloudcli | head -1)" ] && ok "relay wrote only its database/log under HOME" || ko "unexpected files under HOME: $(ls -A "$T")"

[ "$fail" = 0 ] && echo "ALL CHECKS PASSED (Linux install/build/run). Public exposure and TLS are NOT covered by this script." || echo "SOME CHECKS FAILED"
exit "$fail"
