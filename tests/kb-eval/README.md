# KB retrieval eval

## What this is and why it exists

Support answers on this platform are grounded in the public docs site
(docs.gtm-api.com). When a user asks the in-product copilot or an external AI
client a product question, the agent calls the `search_knowledge` MCP tool,
gets back up to five chunks of docs text from the Mintlify search index, and
writes its answer from them. That makes retrieval quality a production
dependency: if the right page stops coming back for a question, answers get
worse and nobody notices. The index always returns SOMETHING - it has no
"no results" state, any text gets a page of nearest neighbours back, borscht
recipes included - so a broken query never looks broken on the surface.

This suite is the tripwire. It keeps a list of about 30 real support
questions ("golden queries"), each pinned to the docs pages that must come
back for it, runs them against the live index through the exact retrieval
code the production worker executes, and records everything into a committed
snapshot. A failing query means retrieval broke for a real question. A
changed snapshot after a docs deploy shows precisely what that deploy did to
retrieval.

## Files

| Path | What it is |
|---|---|
| `tests/kb-eval/queries.ts` | The golden set. The only file you normally edit. |
| `tests/kb-eval/kb-eval.test.ts` | The runner. |
| `tests/kb-eval/snapshots/latest.json` | Committed result of the last run: verdicts, ranks, full chunk text, content hashes. |

## Running it

From the repo root:

    pnpm kb:eval

Prerequisites: `pnpm install` done once, and the Mintlify key. The key is
read from the `MINTLIFY_ASSISTANT_KEY` env var or, when unset, from
`~/.gtm-secrets/common.env` (dev machines have it there already). Without a
key the suite skips and says so. A run takes about half a minute and makes
one live search per query.

Output is one line per query plus a summary:

    PASS connect-linkedin-account: kb/connect-a-linkedin-account, ...
    kb-eval: 30 pass, 0 gap, 0 fail -> snapshots/latest.json

- **PASS**: every expectation held.
- **FAIL**: a real regression. The line says which expected page is missing
  and what came back instead. Either the docs changed for the worse, the
  ranking moved, or the expectation is stale (see "Maintaining" below).
  Investigate before touching anything.
- **GAP**: the query is marked `known_gap` in queries.ts: a documented hole
  that does not fail the suite but stays visible in every snapshot.

## Reading the snapshot

`snapshots/latest.json` holds, per query: the verdict, `first_expected_rank`
(the position of the first correct page, 1 is best), and the served hits with
their full chunk text plus a hash of the untruncated source section.

The snapshot is committed together with whatever change or investigation
produced it. That makes

    git diff tests/kb-eval/snapshots/latest.json

after a re-run the drift report: which pages entered or left each query's
results, which moved, and which chunks changed content (hash changed) without
moving.

Two things are normal in a diff and not alarming on their own: the order of
ranks 4-5 wobbles a little between runs, and a couple of generated
api-reference pages change their chunk text between runs (KB and guide pages
are stable). What matters is where the expected pages sit, ranks 1-3.

## When to run it

- **After every docs deploy.** The main trigger: the index is rebuilt from
  the published site, so a deploy is exactly when retrieval can move.
- While investigating a wrong support answer (next section).
- Any time you edit queries.ts.

## Investigating "the copilot answered wrong"

1. Get the trace id of the turn (the copilot panel shows it).
2. In Grafana Loki, look at what actually happened. The copilot side shows
   whether the agent called `search_knowledge` at all and with what query:

       {service="gtm.agent.copilot"} | json | trace_id="<uuid>"

   The worker side shows what Mintlify returned for it - paths, sizes,
   whether chunks were truncated:

       {service="gtm.mcp"} |= "rest.io" |= "<part of the query>"

   Query recipes live in `product/deployment/RUNBOOK-copilot.md` in the
   umbrella repo.
3. Decide which link is weak:
   - The agent never called the tool, or phrased the query badly: a prompt
     or tool-description problem, not a KB problem.
   - The right page is absent from the results: a docs or ranking problem.
     Fix the docs (structure, headings, wording), deploy, re-run the eval.
   - The right page is there but the needed fact sat beyond the 1400-char
     chunk cap and the agent did not fetch the full page: restructure the
     page into shorter sections, or treat it as an agent problem.
   - The chunks were right and the answer still wrong: an agent problem,
     not retrieval.
4. Whatever the diagnosis, add the user's question to queries.ts. That is
   the point of the suite: every investigated case becomes a permanent
   regression probe.

## Adding a query

Append an entry to `GOLDEN` in `tests/kb-eval/queries.ts`:

    {
      // Where it came from: live trace, support ticket, coverage seed.
      id: 'payment-failed',
      query: 'payment failed subscription status past due',
      expect_paths: ['kb/billing-and-plans'],
    },

Field rules:

- `id`: stable kebab-case, never reused.
- `query`: English, phrased like a help-article search, kept verbatim once
  added. It is a regression probe, not prose to polish.
- `expect_paths`: docs paths (the part after `docs.gtm-api.com/`). At least
  one of them must appear in the results. An entry ending in `/` matches as
  a prefix, e.g. `api-reference/`.
- `must_contain` (optional): substrings the returned chunks must mention.
  Use sparingly, for load-bearing vocabulary only: chunk boundaries move on
  every docs deploy and tight phrases rot.
- `forbid_paths` (optional): pages that must NOT come back.
- `known_gap` (optional): set it, with the reason, when the docs genuinely
  cannot serve the query yet. The suite stays green, the gap stays on record
  in every snapshot until the docs close it.

Then run `pnpm kb:eval` and commit queries.ts together with the refreshed
snapshot.

## Maintaining existing queries

- Docs page renamed or split: update `expect_paths` in the same change as
  the docs restructure, and say so in the commit message.
- A query starts failing although the answer "should" work: that is the
  suite doing its job. Investigate first; relax the expectation only when it
  was genuinely wrong.
- Never delete a query that came from a real support case. If it cannot pass
  for now, mark it `known_gap` with the reason.

## Knobs

- `KB_EVAL_TOP_K=3 pnpm kb:eval` re-runs the set with fewer served chunks,
  to probe how routing degrades before changing the tool default (5).
- Each query gets one automatic retry: the live index drops roughly one call
  in a hundred, and a transient blip should not fail a golden run. A real
  outage fails both attempts.

## Background facts worth knowing

- The index returns no relevance scores and accepts no threshold. Gaps in
  the KB are found by this suite, never by counting empty results, because
  there are no empty results.
- Production serves the top 5 hits after dropping the `kb/index` hub page;
  each chunk is capped at 1400 characters, with a note telling the agent to
  fetch the full page via `get_kb_article` when it needs the rest.
- The retrieval code this suite calls is the same code the worker runs.
  Transport and auth are covered separately by the e2e smoke suite.
