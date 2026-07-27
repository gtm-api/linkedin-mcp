#!/usr/bin/env bash
# Materialise the two gate inputs that live in the UMBRELLA repo (gtm-api/gtm.ai).
#
# Two gates in this repo read files this repo does not own:
#
#   ../../research                    tests/research-parity.test.ts
#                                     (product/research/gtm.service.*/entities/*.md,
#                                     the DESIGN side of every tool)
#   ../../openapi/gtm.openapi.public  tests/openapi-public-drift.test.ts and
#                                     bin/openapi-public.sh (the generated public spec)
#
# Both paths are resolved RELATIVE to this repo root, because on a workstation
# gtm.mcp is checked out at <umbrella>/product/mcp/gtm.mcp and the corpus is
# simply next door. A CI clone contains only gtm.mcp, so this script rebuilds the
# same relative offset: sparse clone of the umbrella, then a symlink per path.
#
# On a workstation it finds the corpus already there and exits without touching
# the network, which is why it is safe to call from anywhere.
#
# Access to gtm-api/gtm.ai is required in CI. Either:
#   - an SSH key on this repo (Repository settings > SSH keys), public half added
#     to gtm.ai as an access key, or
#   - a repository access token with read scope on gtm.ai, stored as the secured
#     repo variable UMBRELLA_TOKEN.
# Overrides: UMBRELLA_REPO_URL, UMBRELLA_REF (default master), UMBRELLA_DIR (use
# an existing checkout instead of cloning).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The directory that must contain research/ and openapi/, i.e. what <umbrella>/product
# is on a workstation. In Pipelines the clone sits at /opt/atlassian/pipelines/agent/build,
# so this resolves to /opt/atlassian/pipelines.
PARENT="$(cd "$ROOT/../.." && pwd)"

RESEARCH="$PARENT/research"
OPENAPI="$PARENT/openapi"
REF="${UMBRELLA_REF:-master}"

if [ -d "$RESEARCH" ] && [ -d "$OPENAPI/gtm.openapi.public" ]; then
  echo "OK corpus already present next to the repo ($PARENT), nothing to fetch"
  exit 0
fi

CLONE_DIR="${UMBRELLA_DIR:-$PARENT/.umbrella}"

if [ ! -d "$CLONE_DIR/product" ]; then
  if [ -n "${UMBRELLA_TOKEN:-}" ]; then
    URL="https://x-token-auth:${UMBRELLA_TOKEN}@bitbucket.org/gtm-api/gtm.ai.git"
    SHOWN_URL="https://bitbucket.org/gtm-api/gtm.ai.git (token auth)"
  else
    URL="${UMBRELLA_REPO_URL:-git@bitbucket.org:gtm-api/gtm.ai.git}"
    SHOWN_URL="$URL"
  fi

  echo "-> sparse cloning $SHOWN_URL @ $REF into $CLONE_DIR"
  # blob:none + sparse: only the two directories the gates read are ever
  # downloaded. The umbrella carries the whole company knowledge base and a full
  # clone would be minutes of CI time for files nothing here reads.
  if ! git clone --quiet --depth 1 --filter=blob:none --sparse --branch "$REF" "$URL" "$CLONE_DIR"; then
    echo "FAIL could not clone the umbrella repo." >&2
    echo "  Two gates read product/research and product/openapi/gtm.openapi.public from it." >&2
    echo "  Give this pipeline read access to gtm-api/gtm.ai: add an SSH key under" >&2
    echo "  Repository settings > SSH keys (public half as an access key on gtm.ai)," >&2
    echo "  or set the secured repo variable UMBRELLA_TOKEN to a read-scoped access token." >&2
    exit 1
  fi
  git -C "$CLONE_DIR" sparse-checkout set product/research product/openapi
fi

for path in "product/research" "product/openapi/gtm.openapi.public"; do
  if [ ! -d "$CLONE_DIR/$path" ]; then
    echo "FAIL $CLONE_DIR/$path is missing at $REF." >&2
    echo "  The gates cannot run against a corpus that is not committed there." >&2
    echo "  gtm.openapi.public in particular is GENERATED here and committed in the" >&2
    echo "  umbrella: run 'pnpm openapi:public' and commit the result to gtm.ai first." >&2
    exit 1
  fi
done

[ -e "$RESEARCH" ] || ln -s "$CLONE_DIR/product/research" "$RESEARCH"
[ -e "$OPENAPI" ] || ln -s "$CLONE_DIR/product/openapi" "$OPENAPI"

echo "OK corpus linked from umbrella $(git -C "$CLONE_DIR" rev-parse --short HEAD) ($REF)"
echo "   $RESEARCH -> $CLONE_DIR/product/research"
echo "   $OPENAPI -> $CLONE_DIR/product/openapi"
