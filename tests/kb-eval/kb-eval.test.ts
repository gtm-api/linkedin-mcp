import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { searchKbMintlify, type KbHitIoMeta } from '@gtm/mcp-support';
import { GOLDEN, type GoldenQuery } from './queries';

// KB retrieval eval: the golden queries against the LIVE Mintlify discovery
// index, through the exact code the deployed worker runs for search_knowledge
// (searchKbMintlify + the 1400-char chunk cap). Transport and auth are
// excluded on purpose - the e2e smoke already proves the mount serves.
//
// Opt-in, from the repo root:
//
//   pnpm kb:eval
//
// Run it when a support answer looked wrong (replay the failing query, see
// what the index served) and after every docs deploy (the snapshot diff IS
// the drift report). The key comes from MINTLIFY_ASSISTANT_KEY or, when
// unset, from ~/.gtm-secrets/common.env - the same source bin/mcp-dev.sh
// reads. CI has neither, so the suite self-skips there.
//
// Every run rewrites snapshots/latest.json: outcomes in golden order, full
// post-cap chunk text, and the pre-cap content hash per hit. Commit it with
// the run - `git diff tests/kb-eval/snapshots/latest.json` after the next run
// then shows exactly which pages entered or left each query's results and
// which chunks changed content (hash) without moving.

const RUN = process.env.RUN_KB_EVAL === '1';
const DOMAIN = process.env.MINTLIFY_DOCS_DOMAIN ?? 'docs.gtm-api.com';
// The tool's production default is 5; override to probe how routing degrades
// at a smaller k (KB_EVAL_TOP_K=3 pnpm kb:eval) before touching the default.
const TOP_K = Number(process.env.KB_EVAL_TOP_K ?? 5);

function resolveKey(): string | null {
  const env = process.env.MINTLIFY_ASSISTANT_KEY?.trim();
  if (env) return env;
  try {
    const vault = readFileSync(join(homedir(), '.gtm-secrets', 'common.env'), 'utf8');
    return vault.match(/^MINTLIFY_ASSISTANT_KEY=(.+)$/m)?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

const KEY = RUN ? resolveKey() : null;

/** Entries ending with '/' match as a prefix (see GoldenQuery.expect_paths). */
const matchesPath = (hitPath: string, expected: string): boolean =>
  expected.endsWith('/') ? hitPath.startsWith(expected) : hitPath === expected;

interface EvalHit extends KbHitIoMeta {
  article_title: string;
  section: string;
  score: number;
  content: string;
}

interface QueryOutcome {
  id: string;
  query: string;
  outcome: 'pass' | 'fail' | 'gap';
  known_gap?: string;
  failures: string[];
  /** 1-based rank of the first hit matching expect_paths; null = not served. */
  first_expected_rank: number | null;
  received_count: number;
  duration_ms: number;
  hits: EvalHit[];
}

function judge(q: GoldenQuery, paths: string[], joinedChunks: string): string[] {
  const failures: string[] = [];
  if (!q.expect_paths.some((p) => paths.some((hp) => matchesPath(hp, p)))) {
    failures.push(`none of [${q.expect_paths.join(', ')}] in hits: [${paths.join(', ')}]`);
  }
  for (const s of q.must_contain ?? []) {
    if (!joinedChunks.includes(s.toLowerCase())) failures.push(`chunks never mention "${s}"`);
  }
  for (const p of q.forbid_paths ?? []) {
    if (paths.some((hp) => matchesPath(hp, p))) failures.push(`forbidden path ${p} present`);
  }
  return failures;
}

const outcomes: QueryOutcome[] = [];

describe.runIf(RUN)('kb retrieval eval', () => {
  if (!KEY) {
    it('needs a Mintlify key', () => {
      throw new Error(
        'RUN_KB_EVAL=1 but MINTLIFY_ASSISTANT_KEY is neither in the env nor in '
          + '~/.gtm-secrets/common.env - there is nothing to eval against.',
      );
    });
    return;
  }

  const key = KEY;
  // One retry: the live index occasionally drops a single call (seen on the
  // 2026-08-25 runs). A transient blip should not fail a golden run; a real
  // outage still fails both attempts.
  async function searchWithRetry(query: string) {
    try {
      return await searchKbMintlify({ key, domain: DOMAIN }, query, TOP_K);
    } catch (err) {
      console.warn(`kb-eval: retrying "${query}" after: ${String(err)}`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return searchKbMintlify({ key, domain: DOMAIN }, query, TOP_K);
    }
  }

  for (const q of GOLDEN) {
    it(q.id, { timeout: 45_000 }, async () => {
      const { hits, io } = await searchWithRetry(q.query);
      const paths = hits.map((h) => h.article_id);
      const failures = judge(q, paths, hits.map((h) => h.content).join('\n').toLowerCase());
      const rankIdx = paths.findIndex((hp) => q.expect_paths.some((p) => matchesPath(hp, p)));
      outcomes.push({
        id: q.id,
        query: q.query,
        outcome: failures.length === 0 ? 'pass' : q.known_gap ? 'gap' : 'fail',
        ...(q.known_gap ? { known_gap: q.known_gap } : {}),
        failures,
        first_expected_rank: rankIdx === -1 ? null : rankIdx + 1,
        received_count: io.received_count,
        duration_ms: io.duration_ms,
        hits: hits.map((h, i) => ({
          ...io.hits[i]!,
          article_title: h.article_title,
          section: h.section,
          score: h.score,
          content: h.content,
        })),
      });
      if (!q.known_gap) expect(failures, failures.join(' | ')).toEqual([]);
    });
  }

  afterAll(() => {
    if (outcomes.length === 0) return;
    const summary = {
      pass: outcomes.filter((o) => o.outcome === 'pass').length,
      gap: outcomes.filter((o) => o.outcome === 'gap').length,
      fail: outcomes.filter((o) => o.outcome === 'fail').length,
    };
    const dir = join(dirname(fileURLToPath(import.meta.url)), 'snapshots');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'latest.json'),
      `${JSON.stringify(
        { generated_at: new Date().toISOString(), domain: DOMAIN, top_k: TOP_K, summary, queries: outcomes },
        null,
        2,
      )}\n`,
    );
    for (const o of outcomes) {
      const mark = o.outcome === 'pass' ? 'PASS' : o.outcome === 'gap' ? 'GAP ' : 'FAIL';
      const detail = o.failures.length > 0 ? ` | ${o.failures.join(' | ')}` : '';
      console.log(`${mark} ${o.id}: ${o.hits.map((h) => h.article_id).join(', ')}${detail}`);
    }
    console.log(
      `kb-eval: ${summary.pass} pass, ${summary.gap} gap, ${summary.fail} fail -> snapshots/latest.json`,
    );
  });
});
