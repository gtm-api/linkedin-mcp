#!/usr/bin/env bash
# One command to bring up the gtm.mcp server locally.
# Mints a fresh dev bearer (jwt:fake) and starts `wrangler dev` on :8788 with
# that token injected, so the MCP connector can be a bare URL (no header).
#
#   pnpm dev                          # from the gtm.mcp repo root
#   TEAM_SID=... ACTOR_SID=... pnpm dev   # override (defaults = the DevSeeder identity)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LKDIR="$(cd "$ROOT/../../backend/gtm.service.linkedin" && pwd)"

# The seeded dev identity - gtm.service.id DevSeeder (USER_SID / TEAM_SID consts).
# Must match the seed, else the token operates on an empty/nonexistent team
# (credits/accounts live under the seeded team → mismatched token = 402/403).
TEAM="${TEAM_SID:-ts_tm_seeddev00001}"
ACTOR="${ACTOR_SID:-us_mb_seeddev00001}"
TTL="${TTL:-2592000}"   # 30 days - the bare-URL dev connector reuses this one token for the life of the process, so a short TTL 401s mid-session; override with TTL=… for a shorter-lived token
PORT="${PORT:-8788}"

echo "→ Checking linkedin backend is up (…:8020/live) …"
if ! curl -sf -m 3 http://localhost:8020/live >/dev/null; then
  echo "✗ linkedin backend not reachable on :8020. Start it first:  (cd $LKDIR && ./dev up)" >&2
  exit 1
fi

echo "→ Minting dev bearer (actor $ACTOR, team $TEAM, ttl ${TTL}s) …"
TOKEN="$(cd "$LKDIR" && ./dev artisan jwt:fake --team-sid="$TEAM" --actor-sid="$ACTOR" --ttl="$TTL" 2>/dev/null \
  | grep -oE 'eyJ[A-Za-z0-9_.-]{40,}' | tail -1)"
if [ -z "$TOKEN" ]; then
  echo "✗ failed to mint jwt:fake token" >&2
  exit 1
fi

# Wide-event dispatch log. wrangler prints one structured JSON line per request
# to stdout; the worker (workerd) can't write host files itself, so we tee
# wrangler's output to a stable, gitignored path (MCP_LOG_FILE to override).
# Anyone (you in another shell, an assistant, a script) can `tail -f`/`grep`
# it regardless of who owns this terminal. Truncated on each start. stdin stays
# on the TTY so wrangler hotkeys still work; stdout is piped, so the lines are
# plain JSON with no ANSI colour - grep/jq-friendly.
LOG_FILE="${MCP_LOG_FILE:-$ROOT/worker.log}"

echo "→ Starting MCP worker on http://localhost:${PORT}"
echo "  mount:  http://localhost:${PORT}/mcp/linkedin/accounts"
echo "  health: http://localhost:${PORT}/health"
echo "  log:    $LOG_FILE  (dispatch log - tail -f it, or: grep <trace_id> | jq)"
cd "$ROOT/apps/worker"
pnpm exec wrangler dev --port "$PORT" --ip 127.0.0.1 --var "DEV_BEARER:$TOKEN" 2>&1 | tee "$LOG_FILE"
