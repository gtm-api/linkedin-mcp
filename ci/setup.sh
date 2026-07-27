#!/usr/bin/env bash
# Per-step setup for Bitbucket Pipelines: pin pnpm, install the workspace.
#
# Every step runs this, the same way the PHP service repos run their own
# ci/setup.sh in every step. Steps are separate containers, so there is nothing
# to share between them except the cache.
#
# The store lives OUTSIDE the clone on purpose. tests/dash-lint.test.ts walks
# every text file under the repo root, and a package store inside the clone
# would put thousands of third-party files in front of it (and fail the gate on
# somebody else's em dash). /opt/pnpm-store is on the same filesystem as the
# clone, so pnpm still hardlinks rather than copies.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STORE_DIR="${PNPM_STORE_DIR:-/opt/pnpm-store}"

# One source of truth for the pnpm version: package.json "packageManager".
# Read it with node rather than hardcoding it here, so a bump in that field is
# the whole change.
PNPM_VERSION="$(node -p "require('./package.json').packageManager.split('@')[1]")"
if [ "$(pnpm --version 2>/dev/null || echo none)" != "$PNPM_VERSION" ]; then
  echo "-> installing pnpm@$PNPM_VERSION (package.json packageManager)"
  npm install --global --no-fund --no-audit "pnpm@$PNPM_VERSION"
fi

echo "-> node $(node --version), pnpm $(pnpm --version), store $STORE_DIR"
pnpm install --frozen-lockfile --store-dir "$STORE_DIR"
