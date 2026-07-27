#!/usr/bin/env bash
# Point this clone's hooks at the versioned ones in bin/hooks.
#
# core.hooksPath is per clone and lives in .git/config, so hooks stay opt in while
# their content is reviewed like any other file in the repo. Nothing is copied into
# .git/hooks, so an edit to bin/hooks/pre-push takes effect immediately.
#
#   pnpm hooks:install                     enable
#   git config --unset core.hooksPath      disable
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

git config core.hooksPath bin/hooks
chmod +x bin/hooks/*

echo "OK core.hooksPath = bin/hooks"
echo "   pre-push runs pnpm typecheck + pnpm test (the same offline gates as CI)"
echo "   bypass once with: git push --no-verify"
echo "   disable with:     git config --unset core.hooksPath"
