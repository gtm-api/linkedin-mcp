#!/usr/bin/env bash
# Run the LIVE end-to-end arm, start to finish, from one command.
#
#   pnpm e2e                  # the whole dance
#   pnpm e2e --keep-worker    # leave the worker up afterwards (debugging a failure)
#   MCP_URL=… pnpm e2e        # point at a worker somewhere else (nothing is started)
#
# WHY THIS EXISTS. `pnpm test:e2e` is one `vitest run` with RUN_E2E=1, and on its
# own it is a trap: it needs four Laravel backends on Docker AND a worker on
# :8788 AND a mintable dev token for the seeded team, and when any of those is
# missing it does not say so. It fails as a wall of envelope assertions, or, if
# the suites are collected without RUN_E2E, silently skips and reports green.
# That is why the one arm that validates an outputSchema against a REAL backend
# response was also the arm nobody ran.
#
# So this script owns the preconditions and says which one is missing, in the
# order they can be fixed:
#   1. the backends answer /live (and which do not),
#   2. a dev bearer can actually be minted for the seeded team,
#   3. a worker is up, started here if it was not already,
#   4. `pnpm test:e2e`,
#   5. the coverage report, then teardown of whatever step 3 started.
#
# IDEMPOTENT, in both directions. A worker already listening on :8788 is REUSED
# and left running (someone is developing against it; killing it would be rude
# and would also lose their dispatch log). A worker this script starts is always
# stopped, on success, on failure, and on Ctrl-C, via the EXIT trap. Two runs
# back to back therefore leave the machine exactly as they found it.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND="$(cd "$ROOT/../../backend" && pwd)"

PORT="${PORT:-8788}"
MCP_URL="${MCP_URL:-http://localhost:$PORT}"
TEAM="${E2E_TEAM_SID:-ts_tm_seeddev00001}"
BOOT_TIMEOUT="${E2E_BOOT_TIMEOUT:-90}"
COVERAGE_JSON="$ROOT/tests/.e2e-coverage.json"
WORKER_LOG="${E2E_WORKER_LOG:-$ROOT/e2e-worker.log}"

KEEP_WORKER=0
for arg in "$@"; do
  case "$arg" in
    --keep-worker) KEEP_WORKER=1 ;;
    *) echo "usage: $(basename "$0") [--keep-worker]" >&2; exit 2 ;;
  esac
done

# The services the mounts dispatch to. `email` is listed because the repo's other
# live gate (pnpm oracle:check) needs all four and an operator who just ran this
# wants to know it is down too, but NO mount serves an email tool today, so it
# cannot fail this run. Keep that distinction honest: the day an email mount
# lands, move it into the required column rather than leaving a service the
# suites depend on reported as advisory.
REQUIRED_SERVICES=("linkedin:8020" "id:8021" "orchestration:8025")
ADVISORY_SERVICES=("email:8024")

STARTED_WORKER_PGID=""
cleanup() {
  local rc=$?
  if [ -n "$STARTED_WORKER_PGID" ]; then
    if [ "$KEEP_WORKER" = "1" ]; then
      echo
      echo "→ --keep-worker: leaving the worker up on $MCP_URL (log: $WORKER_LOG)"
      echo "  stop it with:  kill -TERM -$STARTED_WORKER_PGID"
    else
      echo
      echo "→ stopping the worker this run started (pgid $STARTED_WORKER_PGID)"
      # The whole process group: bin/mcp-dev.sh, the tee, and wrangler under it.
      # Killing the script alone orphans wrangler, which then holds :8788 and
      # makes the NEXT run "reuse" a worker built from the previous checkout.
      kill -TERM -- "-$STARTED_WORKER_PGID" 2>/dev/null
      for _ in $(seq 1 20); do
        kill -0 -- "-$STARTED_WORKER_PGID" 2>/dev/null || break
        sleep 0.25
      done
      kill -KILL -- "-$STARTED_WORKER_PGID" 2>/dev/null
    fi
  fi
  exit "$rc"
}
trap cleanup EXIT INT TERM

live() { curl -sf -m 3 "http://localhost:$1/live" >/dev/null 2>&1; }

# ── 1. backends ──────────────────────────────────────────────────────────────
echo "→ checking backends"
# A space-separated string, not an array: bash 3.2 (what /bin/bash still is on
# macOS) treats `${#arr[@]}` on an EMPTY array as an unbound variable under
# `set -u`, so the happy path would be the one that crashed.
down=""
for entry in "${REQUIRED_SERVICES[@]}"; do
  svc="${entry%%:*}"; port="${entry##*:}"
  if live "$port"; then
    echo "  ✓ $svc  :$port"
  else
    echo "  ✗ $svc  :$port  NOT REACHABLE"
    down="$down $svc"
  fi
done
for entry in "${ADVISORY_SERVICES[@]}"; do
  svc="${entry%%:*}"; port="${entry##*:}"
  if live "$port"; then
    echo "  ✓ $svc  :$port  (no mount dispatches here; checked for completeness)"
  else
    echo "  ~ $svc  :$port  not reachable, but no mount dispatches there, so this run can proceed"
  fi
done

if [ -n "$down" ]; then
  echo >&2
  echo "✗ backend(s) the mounts dispatch to are down:$down" >&2
  for svc in $down; do
    echo "    (cd $BACKEND/gtm.service.$svc && ./dev up)" >&2
  done
  exit 1
fi

# ── 2. the dev bearer ────────────────────────────────────────────────────────
# Minted HERE, before anything is started, for two reasons. It is the
# precondition most likely to be broken (a database that was never seeded looks
# exactly like a healthy stack until the first call comes back 402), and doing it
# once and exporting E2E_TOKEN saves the six suites six `docker exec` round
# trips. tests/e2e/token.ts picks the variable up; without it each suite mints
# its own.
echo "→ minting a dev bearer for team $TEAM"
LK="$BACKEND/gtm.service.linkedin"
TOKEN="$( (cd "$LK" && ./dev artisan jwt:fake --team-sid="$TEAM" --ttl=3600) 2>/dev/null \
  | grep -oE 'eyJ[A-Za-z0-9_.-]{40,}' | tail -1 )"
if [ -z "$TOKEN" ]; then
  echo "✗ could not mint a token: (cd $LK && ./dev artisan jwt:fake --team-sid=$TEAM) printed no JWT." >&2
  echo "  The linkedin container answers /live, so this is the command or the seed, not Docker." >&2
  echo "  Check the seeded identity exists (gtm.service.id DevSeeder: $TEAM)." >&2
  exit 1
fi
export E2E_TOKEN="$TOKEN"
export E2E_TEAM_SID="$TEAM"
echo "  ✓ minted (${#TOKEN} chars)"

# ── 3. the worker ────────────────────────────────────────────────────────────
worker_up() { curl -sf -m 3 "$MCP_URL/health" >/dev/null 2>&1; }

if worker_up; then
  echo "→ worker already up at $MCP_URL, reusing it (it will be left running)"
else
  if [ "$MCP_URL" != "http://localhost:$PORT" ]; then
    echo "✗ MCP_URL is $MCP_URL, which is not this machine's :$PORT, and it is not answering /health." >&2
    echo "  This script only starts a LOCAL worker. Start the remote one, or unset MCP_URL." >&2
    exit 1
  fi
  echo "→ starting a worker on :$PORT (log: $WORKER_LOG)"
  # Job control ON for this one command, so the background job gets its own
  # process group and the trap above can signal the whole tree at once.
  set -m
  ( cd "$ROOT" && PORT="$PORT" bash bin/mcp-dev.sh ) >"$WORKER_LOG" 2>&1 &
  STARTED_WORKER_PGID=$!
  set +m

  waited=0
  until worker_up; do
    if ! kill -0 -- "-$STARTED_WORKER_PGID" 2>/dev/null; then
      echo "✗ the worker exited during boot. Last lines of $WORKER_LOG:" >&2
      tail -20 "$WORKER_LOG" >&2
      exit 1
    fi
    if [ "$waited" -ge "$BOOT_TIMEOUT" ]; then
      echo "✗ the worker did not answer $MCP_URL/health within ${BOOT_TIMEOUT}s. Last lines of $WORKER_LOG:" >&2
      tail -20 "$WORKER_LOG" >&2
      exit 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  echo "  ✓ up after ${waited}s"
fi

# A 200 from /health is not the same as a worker that can serve: `degraded` means
# a fail-closed piece is missing. Under `wrangler dev` the rate-limit binding is
# always isolate-local, so degraded is EXPECTED locally and is not a failure; the
# problems are printed so an operator sees what a live run did and did not cover.
node -e '
  fetch(process.argv[1] + "/health")
    .then((res) => res.json())
    .then((h) => {
      console.log(`  health: ${h.status}, ${h.tools} tools over ${h.mounts.length} mounts, auth ${h.auth_mode}, gate ${h.gate}`);
      for (const p of h.problems ?? []) console.log(`  ~ ${p.severity}: ${p.key}`);
    })
    .catch((err) => { console.log(`  health: unreadable (${err.message})`); });
' "$MCP_URL"

# ── 4. the suites ────────────────────────────────────────────────────────────
echo
echo "→ pnpm test:e2e   (RUN_E2E=1, against $MCP_URL)"
rm -f "$COVERAGE_JSON"
MCP_URL="$MCP_URL" pnpm -C "$ROOT" test:e2e
suite_status=$?

# ── 5. the coverage report ───────────────────────────────────────────────────
# Printed even on a red run: a failure that also lost half the read surface is a
# different problem from one that did not, and the buckets are what says which.
echo
if [ -f "$COVERAGE_JSON" ]; then
  node -e '
    const fs = require("node:fs");
    const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const pct = (n, of) => (of ? Math.round((n / of) * 100) : 0);
    const svc = Object.entries(r.registered.by_service).map(([s, n]) => `${s} ${n}`).join(", ");
    const ops = Object.entries(r.not_exercised.by_operation).map(([o, n]) => `${o} ${n}`).join(", ");
    console.log("LIVE E2E COVERAGE");
    console.log(`  registered tools        ${r.registered.total}  (${svc})`);
    console.log(`  domain mounts smoked    ${r.mounts.smoked} / ${r.mounts.domain}`);
    console.log(`  tools called live       ${r.exercised.total} / ${r.registered.total}  (${pct(r.exercised.total, r.registered.total)}%)`);
    console.log("");
    console.log(`  read surface            ${r.contract.total}`);
    console.log(`    outputSchema parsed   ${r.contract.contractChecked}  (${pct(r.contract.contractChecked, r.contract.total)}%)  <- the only assertion a live backend can make`);
    console.log(`    needs-args            ${r.contract.needsArgs}  (${pct(r.contract.needsArgs, r.contract.total)}%)  required filter, clean error envelope`);
    console.log(`    no-data               ${r.contract.noData}  (${pct(r.contract.noData, r.contract.total)}%)  nothing seeded to read`);
    console.log(`    other-error           ${r.contract.otherError}  (${pct(r.contract.otherError, r.contract.total)}%)`);
    if (r.contract.unaccounted !== 0) {
      console.log(`    UNACCOUNTED           ${r.contract.unaccounted}  cases that failed before they could classify the response`);
    }
    console.log("");
    console.log(`  called by smoke only    ${r.exercised.smoke_only.length}`);
    console.log(`  NOT called              ${r.not_exercised.total}  (${ops})`);
    // No third bucket here on purpose: the `creditable` flag left the tool
    // descriptor with the platform-wide credits removal (2026-08-16), so
    // tests/e2e/coverage.ts no longer emits a `creditable` key and this reader
    // printed `undefined` until it was dropped on 2026-08-16. The buckets below
    // are exactly the ones buildReport() writes.
    console.log(`    dangerous             ${r.not_exercised.dangerous}`);
    console.log(`    stub_501              ${r.not_exercised.stubs.length}`);
    console.log("");
    console.log("  A tool goes uncalled on purpose when it mutates or acts");
    console.log("  outward on LinkedIn. The preview STEP of one dangerous tool is smoked; no");
    console.log("  commit step ever is. Raising \"outputSchema parsed\" means seeding rows for");
    console.log("  the no-data reads, not calling more tools.");
    console.log("");
    console.log(`  full report: ${process.argv[1]}`);
  ' "$COVERAGE_JSON"
else
  echo "~ no coverage report at $COVERAGE_JSON: the contract suite did not reach its last case."
  echo "  (that suite writes the report, so a crash before it leaves this empty)"
fi

echo
if [ "$suite_status" -eq 0 ]; then
  echo "✓ live e2e GREEN. Record the date and the commit next to the release."
else
  echo "✗ live e2e FAILED (exit $suite_status). Nothing ships on a red live arm." >&2
  echo "  Re-run with --keep-worker and grep the dispatch log: $WORKER_LOG" >&2
fi
exit "$suite_status"
