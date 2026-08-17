#!/usr/bin/env bash
# Generate (and validate) gtm.openapi.public from the Zod tool registry.
#
#   pnpm openapi:public          # regenerate product/openapi/gtm.openapi.public + validate
#   pnpm openapi:public:check    # CI gate: regenerate into a temp dir, fail on drift, validate
#
# The generator lives in packages/openapi and reads the registry directly, so it
# needs no running backend, no Docker and no network. Node >= 23 runs the
# TypeScript as-is; bin/lib/register-ts.mjs only teaches it the workspace's
# extensionless import specifiers.
#
# Validation runs bin/openapi-validate.py: the OAS structural check
# (openapi_spec_validator) plus the operationId / summary / description / 4xx /
# array-items / $ref / license / ambiguous-path rules. gtm.openapi.public is the
# only OpenAPI spec in the house now, this repo is what generates it, so the
# validator lives here next to its one caller.
#
# The Python deps (bin/requirements.txt) are installed into a throwaway venv the
# first time. It sits at product/openapi/gtm.openapi.public/.venv, gitignored
# there and deliberately outside this repo: tests/dash-lint.test.ts walks every
# text file under this repo root, so a venv full of third-party punctuation
# inside it would fail that gate. Set SKIP_VALIDATE=1 to generate without them.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OPENAPI_DIR="$(cd "$ROOT/../../openapi" && pwd)"
PUBLIC_DIR="$OPENAPI_DIR/gtm.openapi.public"
VENV="$PUBLIC_DIR/.venv"

MODE="write"
case "${1:-}" in
  "")       MODE="write" ;;
  --check)  MODE="check" ;;
  *)        echo "usage: $(basename "$0") [--check]" >&2; exit 2 ;;
esac

if [ "$MODE" = "check" ]; then
  echo "→ checking product/openapi/gtm.openapi.public against the Zod registry"
  node --import "$ROOT/bin/lib/register-ts.mjs" "$ROOT/packages/openapi/src/cli.ts" --check
else
  echo "→ generating product/openapi/gtm.openapi.public from the Zod registry"
  node --import "$ROOT/bin/lib/register-ts.mjs" "$ROOT/packages/openapi/src/cli.ts"
fi

if [ "${SKIP_VALIDATE:-0}" = "1" ]; then
  echo "→ SKIP_VALIDATE=1, not running the OAS validator"
  exit 0
fi

VALIDATOR="$ROOT/bin/openapi-validate.py"
REQUIREMENTS="$ROOT/bin/requirements.txt"
if [ ! -f "$VALIDATOR" ]; then
  echo "✗ validator not found at $VALIDATOR." >&2
  echo "  Re-run with SKIP_VALIDATE=1 to generate without validating." >&2
  exit 1
fi

if [ ! -x "$VENV/bin/python" ]; then
  echo "→ creating $VENV from bin/requirements.txt (one time)"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q -r "$REQUIREMENTS"
fi

echo "→ validating with bin/openapi-validate.py"
status=0
for dir in "$PUBLIC_DIR"/services/*/; do
  svc="$(basename "$dir")"
  echo "── $svc ───────────────────────────────────────────"
  "$VENV/bin/python" "$VALIDATOR" "$dir" || status=1
done
exit "$status"
