# KB retrieval eval

## Overview

`search_knowledge` is the MCP tool the in-product copilot and external AI
clients use to answer product questions. It searches the published docs site
(docs.gtm-api.com) through the Mintlify index and returns up to 5 chunks of
docs text; the agent writes its answer from them. If the right page stops
coming back for a question, answers silently degrade: the index has no
"no results" state and returns nearest neighbours for any input, so a broken
query still looks fine on the surface.

This suite catches that. About 30 real support questions (golden queries),
each pinned to the docs pages that must come back for it, run against the
live index through the same retrieval code the production worker executes.
The result is committed as a snapshot, so any two runs can be diffed.

Three jobs it does:

- regression check after a docs deploy;
- localizing a wrong support answer (docs problem vs agent problem);
- turning every diagnosed case into a permanent probe.

## Files

| Path | Role |
|---|---|
| `queries.ts` | Golden set. The only file you normally edit. |
| `kb-eval.test.ts` | Runner. |
| `snapshots/latest.json` | Committed result of the last run. |

## Run it

1. Once: `pnpm install`. The Mintlify key must be in `MINTLIFY_ASSISTANT_KEY`
   or in `~/.gtm-secrets/common.env` (dev machines already have it there).
2. From the repo root: `pnpm kb:eval`. About 30 seconds, one live search per
   query.
3. Read the verdict lines:
   - PASS: expectations held.
   - FAIL: an expected page is missing from the results. Real regression or
     stale expectation; investigate, do not just edit the expectation.
   - GAP: a `known_gap` query, a documented hole; does not fail the suite.
4. Commit `snapshots/latest.json` together with whatever prompted the run.

## After a docs deploy

1. `pnpm kb:eval`
2. `git diff tests/kb-eval/snapshots/latest.json`
3. Judge the diff:
   - expected pages hold ranks 1-3: fine, commit;
   - an expected page dropped out or a FAIL appeared: the deploy hurt
     retrieval; fix the docs page (headings, structure, wording), redeploy,
     re-run;
   - ignorable noise: ranks 4-5 reordering, chunk-text (hash) changes on
     generated api-reference pages. KB and guide pages are stable.

## Investigate a wrong support answer

1. Take the turn's trace id from the copilot panel.
2. Loki, copilot side: did the agent call the tool, and with what query?

       {service="gtm.agent.copilot"} | json | trace_id="<uuid>"

3. Loki, worker side: what did Mintlify return (paths, sizes, truncation)?

       {service="gtm.mcp"} |= "rest.io" |= "<part of the query>"

   More recipes: `product/deployment/RUNBOOK-copilot.md` in the umbrella repo.
4. Localize:
   - no tool call, or a badly phrased query: prompt / tool-description
     problem, not KB;
   - right page absent from the results: docs or ranking problem; fix the
     docs, deploy, re-run the eval;
   - right page present but the fact sat beyond the 1400-char chunk cap and
     the agent did not fetch the full page: restructure the page into
     shorter sections, or treat as an agent problem;
   - chunks right, answer still wrong: agent problem.
5. Add the user's question to queries.ts (next section) so the case stays
   guarded.

## Add a query

1. Append to `GOLDEN` in `queries.ts`:

       {
         // Source: live trace / support ticket / coverage seed.
         id: 'payment-failed',
         query: 'payment failed subscription status past due',
         expect_paths: ['kb/billing-and-plans'],
       },

2. Field rules:
   - `id`: stable kebab-case, never reused.
   - `query`: English, help-article wording, verbatim once added.
   - `expect_paths`: docs paths; at least one must appear in the results.
     Trailing `/` matches as a prefix (`api-reference/`).
   - `must_contain` (optional): substrings the chunks must mention. Use
     sparingly; chunk boundaries move on every deploy.
   - `forbid_paths` (optional): pages that must not come back.
   - `known_gap` (optional): reason string when the docs cannot serve the
     query yet; keeps the suite green and the gap on record.
3. `pnpm kb:eval`, then commit queries.ts and the snapshot together.

## Maintain

- Docs page renamed or split: update `expect_paths` in the same change.
- A query started failing: investigate first; relax the expectation only if
  it was wrong to begin with.
- Never delete a query born from a real case; mark it `known_gap` instead.

## Knobs and facts

- `KB_EVAL_TOP_K=3 pnpm kb:eval`: probe routing at a smaller k before
  touching the tool default (5).
- One automatic retry per query: the live index drops about 1 call in 100;
  a real outage fails both attempts.
- The index returns no scores and accepts no relevance threshold. KB gaps
  are found by this suite, not by counting empty results (there are none).
- Production serves the top 5 after dropping the `kb/index` hub page; chunks
  cap at 1400 chars with a pointer to `get_kb_article` for the full page.
- Transport and auth are covered by the e2e smoke, not here.
