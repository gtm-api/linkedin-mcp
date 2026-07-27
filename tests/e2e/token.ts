import { execSync } from 'node:child_process';

// The one place the live arm gets its bearer.
//
// Every e2e suite used to carry its own copy of this: the same `jwt:fake`
// execSync, the same regex, and the same `catch { token = '' }`. Two problems
// with that, both of which cost real debugging time.
//
// First, the swallow. A failed mint (Docker down, the seeder never run, the
// artisan command renamed) produced an EMPTY token, and every suite then ran
// its whole list of calls unauthenticated. What a human saw was twenty or more
// assertion failures about envelopes and tool counts, none of which mentioned
// the actual cause. Now the mint throws, once, with the reason, so beforeAll
// fails the suite with the one line that is true.
//
// Second, the cost. Six suites shelling into a container for the same token is
// six `docker exec` round trips before any test runs. `E2E_TOKEN` short-circuits
// that: bin/e2e.sh mints once up front (where it can also fail the run BEFORE
// starting a worker) and exports it. Running `pnpm test:e2e` by hand with no
// E2E_TOKEN still works, it just pays the exec.

const LINKEDIN_DIR =
  process.env.LINKEDIN_DIR ?? '/Users/eugene/sites/gtm.ai/product/backend/gtm.service.linkedin';
const TEAM = process.env.E2E_TEAM_SID ?? 'ts_tm_seeddev00001';
const TTL = process.env.E2E_TOKEN_TTL ?? '3600';

/** A JWT is three base64url segments; the artisan output wraps it in chatter. */
const JWT_RE = /eyJ[A-Za-z0-9_.-]{40,}/g;

let cached = '';

/**
 * The dev bearer the live suites authenticate with, for the seeded team.
 *
 * Prefers `E2E_TOKEN` (bin/e2e.sh sets it), otherwise mints one with
 * `jwt:fake` in the linkedin container. Throws rather than returning '': an
 * unauthenticated live run fails in a way that describes anything except the
 * real problem.
 */
export function mintDevToken(): string {
  if (cached) return cached;

  const supplied = process.env.E2E_TOKEN?.trim();
  if (supplied) {
    cached = supplied;
    return cached;
  }

  let out = '';
  try {
    out = execSync(`./dev artisan jwt:fake --team-sid=${TEAM} --ttl=${TTL}`, {
      cwd: LINKEDIN_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const detail = String((err as { stderr?: string; message?: string })?.stderr ?? (err as Error)?.message ?? err).trim();
    throw new Error(
      `e2e: could not mint a dev bearer in ${LINKEDIN_DIR}.\n` +
        `  ./dev artisan jwt:fake --team-sid=${TEAM} failed: ${detail.slice(0, 400)}\n` +
        '  Is Docker up for the linkedin service? (cd there && ./dev up). ' +
        'bin/e2e.sh checks this before it starts anything.',
    );
  }

  const found = out.match(JWT_RE);
  if (!found || found.length === 0) {
    throw new Error(
      `e2e: jwt:fake ran but printed no JWT for team ${TEAM}. Output was:\n${out.slice(0, 400)}`,
    );
  }
  cached = found[found.length - 1];
  return cached;
}

/** The team every live suite operates as, for messages that need to say it. */
export const E2E_TEAM = TEAM;
