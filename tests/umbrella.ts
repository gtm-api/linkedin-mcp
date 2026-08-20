import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// Where the umbrella corpus is. Two gates read files this repo does not own;
// they live in the umbrella repo (gtm-api/gtm.ai), which on a workstation has
// this repo checked out at <umbrella>/product/mcp/gtm.mcp, so <umbrella>/product
// sits two directories up:
//
//   ../../research                    research-parity.test.ts (the design side
//                                     of every tool)
//   ../../openapi/gtm.openapi.public  openapi-public-drift.test.ts (the
//                                     committed public spec)
//
// A CI clone contains only gtm.mcp; ci/fetch-corpus.sh rebuilds the same offset
// (sparse umbrella clone, then a symlink per path) before the suite runs. Both
// of those layouts resolve through the first branch below, unchanged.
//
// The offset breaks in exactly one real layout: a linked git worktree. Claude
// Code creates them under .claude/worktrees/<name>/, where ../.. is the main
// checkout's gitignored .claude/ and holds no corpus, so every corpus-reading
// test failed in a worktree while passing in the checkout it mirrors. A
// worktree knows its main checkout through the git common dir, and the main
// checkout is the one sitting inside the umbrella, so the fallback resolves
// the same two-up offset from there. When neither branch finds research/ the
// adjacent path is returned anyway, so the gates keep failing with their own
// "corpus missing" messages pointing at the canonical location.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function umbrellaProductDir(): string {
  const adjacent = resolve(REPO_ROOT, '..', '..');
  if (existsSync(join(adjacent, 'research'))) return adjacent;
  try {
    // ".git" (relative to the cwd) from a main checkout, an absolute path from
    // a linked worktree; resolve() against the repo root covers both spellings.
    const commonDir = resolve(
      REPO_ROOT,
      execFileSync('git', ['rev-parse', '--git-common-dir'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
    );
    const viaMainCheckout = resolve(dirname(commonDir), '..', '..');
    if (existsSync(join(viaMainCheckout, 'research'))) return viaMainCheckout;
  } catch {
    // Not a git checkout (a tarball), or no git on PATH: nothing to walk to.
  }
  return adjacent;
}

const UMBRELLA_PRODUCT_DIR = umbrellaProductDir();

/** Trailing separator kept: research-parity.test.ts appends with template strings. */
export const RESEARCH_ROOT = join(UMBRELLA_PRODUCT_DIR, 'research/');

export const OPENAPI_PUBLIC_DIR = join(UMBRELLA_PRODUCT_DIR, 'openapi', 'gtm.openapi.public');
