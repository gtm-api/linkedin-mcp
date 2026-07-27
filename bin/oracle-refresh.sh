#!/usr/bin/env bash
# Regenerate (or verify) fixtures/contract-oracle/*.contract.json from the live backends.
#
#   pnpm oracle:refresh              # rewrite every fixture in SERVICES below
#   pnpm oracle:refresh linkedin     # one or more (linkedin | id | orchestration | email)
#   pnpm oracle:check                # verify only: regenerate into a temp dir, fail on drift
#   pnpm oracle:check email          # one or more
#
# WHY --check EXISTS. Every gate that reads these fixtures is offline by
# construction: it compares the committed JSON against this repo's TypeScript, so
# it cannot tell a dump taken a minute ago from one that went stale three backend
# releases back. A stale fixture makes all of them green for the wrong reason, and
# that is not theoretical: id.contract.json was stale against the live backend and
# the whole suite passed both before and after the refresh that fixed it. Only
# re-running the generator against a live backend can settle the question, which
# is what --check does: same dump, into a temp dir, compared byte for byte with
# what is committed, exit 1 on any difference. It writes no fixture, so it is safe
# on a dirty tree, and it is the same shape as `pnpm openapi:public:check`.
#
# The generator is the `gtm:contract-oracle` artisan command
# (gtm.lib.common/src/Core/Commands/ContractOracle.php). It is read-only: no DB,
# no JWT, no writes other than the --out file. It runs inside the service
# container, so Docker has to be up for that service (`./dev up`). That is the one
# cost of a real freshness check, and the reason it is a command rather than a
# vitest case.
#
# --out is resolved inside the container and only `src/` is host-mounted, so the
# dump lands at <service>/src/storage/app/contract-oracle.json and is moved from
# there onto the fixture (or into the temp dir under --check). Piping stdout
# instead is not an option: the ./dev wrapper prefixes docker-compose chatter.
#
# The dump is deterministic (entities and routes sorted, fields in declaration
# order), so an unchanged backend produces a byte-identical fixture and every
# difference --check reports is a real backend move.
#
# After a refresh, run `pnpm test`: tests/oracle-freshness.test.ts reports what
# the new dump disagrees with, and tests/contract-parity.test.ts checks the
# TypeScript contract against it.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURES="$ROOT/fixtures/contract-oracle"
BACKEND="$(cd "$ROOT/../../backend" && pwd)"
OUT_REL="storage/app/contract-oracle.json"   # container-relative, must stay under src/

# Every backend that registers `gtm:contract-oracle` in src/bootstrap/app.php.
# Add a service here the same day you add it there, otherwise its fixture rots
# unnoticed: nothing else in this repo knows the service exists.
SERVICES=("linkedin" "id" "orchestration" "email")

MODE="write"
SELECTED=""
for arg in "$@"; do
  case "$arg" in
    --check) MODE="check" ;;
    -*)      echo "usage: $(basename "$0") [--check] [service...]" >&2; exit 2 ;;
    *)       SELECTED="$SELECTED $arg" ;;
  esac
done
if [ -n "$SELECTED" ]; then
  # Service keys never contain spaces, so plain word splitting is the whole parse.
  # shellcheck disable=SC2206
  SERVICES=($SELECTED)
fi

TMP_ROOT=""
cleanup() {
  if [ -n "$TMP_ROOT" ]; then rm -rf "$TMP_ROOT"; fi
}
trap cleanup EXIT
if [ "$MODE" = "check" ]; then
  TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/gtm-contract-oracle-XXXXXX")"
fi

# Runs the generator for one service and leaves a sanity-checked dump at $2.
# Anything that could put a truncated or half-booted dump in front of a caller
# fails the whole run, in both modes: overwriting a good fixture with one and
# reporting one as drift are the same mistake.
dump() {
  local service="$1"
  local dest="$2"
  local dir="$BACKEND/gtm.service.$service"
  local host_out="$dir/src/$OUT_REL"

  if [ ! -x "$dir/dev" ]; then
    echo "✗ no ./dev wrapper at $dir, unknown service '$service'" >&2
    exit 1
  fi

  echo "→ $service: (cd $dir && ./dev artisan gtm:contract-oracle --service=$service --out=$OUT_REL)"
  rm -f "$host_out"
  if ! ( cd "$dir" && ./dev artisan gtm:contract-oracle --service="$service" --out="$OUT_REL" ); then
    echo "✗ $service: artisan failed. Is Docker up for this service?  (cd $dir && ./dev up)" >&2
    exit 1
  fi
  if [ ! -s "$host_out" ]; then
    echo "✗ $service: expected the dump at $host_out, found nothing" >&2
    exit 1
  fi

  node -e '
    const fs = require("fs");
    const [file, service] = process.argv.slice(1);
    const dump = JSON.parse(fs.readFileSync(file, "utf8"));
    const fail = (why) => { console.error("✗ " + service + ": " + why); process.exit(1); };
    if (dump.service !== service) fail(`dump says service="${dump.service}"`);
    if (!dump.entities || Object.keys(dump.entities).length === 0) fail("no entities in the dump");
    if (!Array.isArray(dump.routes) || dump.routes.length === 0) fail("no routes in the dump");
    if (!dump.routes.some((r) => r.uri.startsWith("api/"))) fail("no public /api routes in the dump");
  ' "$host_out" "$service"

  mv "$host_out" "$dest"
}

# Prints what moved between the committed fixture and a fresh dump. Bytes decide
# the exit code; this only makes the answer actionable: which entities and routes
# appeared or disappeared, and which routes changed an #[ApiMethod] fact.
explain_drift() {
  node -e '
    const fs = require("fs");
    const [committedFile, freshFile] = process.argv.slice(1);
    const committed = JSON.parse(fs.readFileSync(committedFile, "utf8"));
    const fresh = JSON.parse(fs.readFileSync(freshFile, "utf8"));
    const key = (route) => `${route.method} ${route.uri}`;
    const line = (text) => console.error("      " + text);
    const bullet = (label, items) => {
      if (!items.length) return;
      line(`${label} (${items.length}):`);
      for (const item of items.slice(0, 12)) line(`  ${item}`);
      if (items.length > 12) line(`  ... and ${items.length - 12} more`);
    };

    const entitiesBefore = Object.keys(committed.entities ?? {});
    const entitiesAfter = Object.keys(fresh.entities ?? {});
    bullet("entities added", entitiesAfter.filter((entity) => !entitiesBefore.includes(entity)));
    bullet("entities removed", entitiesBefore.filter((entity) => !entitiesAfter.includes(entity)));

    const before = new Map((committed.routes ?? []).map((route) => [key(route), route]));
    const after = new Map((fresh.routes ?? []).map((route) => [key(route), route]));
    bullet("routes added", [...after.keys()].filter((k) => !before.has(k)).sort());
    bullet("routes removed", [...before.keys()].filter((k) => !after.has(k)).sort());

    const facts = ["operation", "mass_action", "step_eligible", "schedule_required", "internal"];
    const changed = [];
    for (const [k, route] of after) {
      const was = before.get(k);
      if (!was) continue;
      const moved = facts
        .filter((fact) => JSON.stringify(was[fact]) !== JSON.stringify(route[fact]))
        .map((fact) => `${fact} ${JSON.stringify(was[fact])} -> ${JSON.stringify(route[fact])}`);
      if (moved.length) changed.push(`${k}: ${moved.join(", ")}`);
    }
    bullet("routes whose #[ApiMethod] facts changed", changed.sort());

    // Entity fields, filter keys, enums and declared_arguments are NOT summarised
    // above. The byte comparison has already failed, so say that plainly rather
    // than let an empty summary read as "nothing really changed".
    line("(field, filter, enum and declared_arguments changes are not listed here: diff the two files)");
  ' "$1" "$2" >&2
}

status=0

for service in "${SERVICES[@]}"; do
  fixture="$FIXTURES/$service.contract.json"

  if [ "$MODE" = "write" ]; then
    dump "$service" "$fixture"
    echo "✓ $service → ${fixture#"$ROOT/"}"
    continue
  fi

  fresh="$TMP_ROOT/$service.contract.json"
  dump "$service" "$fresh"

  if [ ! -f "$fixture" ]; then
    echo "✗ $service: the backend dumps a contract but ${fixture#"$ROOT/"} does not exist" >&2
    status=1
    continue
  fi

  if cmp -s "$fixture" "$fresh"; then
    echo "✓ $service: ${fixture#"$ROOT/"} is current"
  else
    echo "✗ $service: ${fixture#"$ROOT/"} is STALE, it is not what the live backend dumps" >&2
    explain_drift "$fixture" "$fresh"
    status=1
  fi
done

echo
if [ "$MODE" = "write" ]; then
  echo "Next: pnpm test  (oracle-freshness + contract-parity read these fixtures)"
  exit 0
fi

if [ "$status" -ne 0 ]; then
  echo "DRIFT: at least one committed fixture no longer matches its live backend." >&2
  echo "Every gate that reads it is green for the wrong reason until you run:  pnpm oracle:refresh" >&2
  echo "Then reconcile ratchet.json / drift-ledger.json / the allow-lists, and run pnpm test." >&2
  exit 1
fi

echo "OK, every committed fixture matches its live backend."
