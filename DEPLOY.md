# Deploying gtm.mcp to Cloudflare

The worker deploys as **`gtm-mcp`** (wrangler env `production`, config in
`apps/worker/wrangler.toml`). Local dev (`bin/mcp-dev.sh` → `wrangler dev` :8788) is
unaffected by anything here: the default env has no cloud bindings and the support KB
serves from the bundled BM25 index.

Production adds three account resources:

| Resource | Binding | Purpose |
|---|---|---|
| KV namespace | `COMMIT_TOKENS` | single-use commit tokens for the preview→confirm gate |
| Vectorize index `gtm-kb` | `VECTORIZE_KB` | embedded support-KB chunks (semantic retrieval) |
| Workers AI | `AI` | query-time embeddings (`@cf/baai/bge-m3`, 1024 dims) |

When `AI` + `VECTORIZE_KB` are bound, `search_knowledge` runs **hybrid** retrieval
(vector + BM25, RRF-fused) and degrades to BM25 on any vector-path error.

## 0. Prerequisites (once per account)

1. Cloudflare account on the **Workers Paid** plan (Vectorize + Workers AI need it).
2. `wrangler login` on the deploying machine, or a `CLOUDFLARE_API_TOKEN` env var for CI.
3. An API token for the KB pipeline (used by `bin/vectorize-kb.mjs`, NOT by the worker):
   Account permissions **Workers AI: Run** + **Vectorize: Edit**. Store as
   `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` in `~/.gtm-secrets` and render into
   the shell env when running the script.

## 1. Provision resources (once)

```bash
cd apps/worker

# Commit-token KV → paste the returned id into [env.production] kv_namespaces
wrangler kv namespace create COMMIT_TOKENS --env production

# Vector index: dimensions MUST match the embedding model (bge-m3 → 1024)
wrangler vectorize create gtm-kb --dimensions=1024 --metric=cosine
```

Fill the `TODO(deploy)` placeholders in `wrangler.toml` (`kv id`, `LINKEDIN_BASE_URL`,
`ID_BASE_URL`, `ORCHESTRATION_BASE_URL`: the backend gateway URLs reachable from
Cloudflare's edge. Every service that backs a tool needs one, or its tools fail at
dispatch with "no base URL configured"), then set secrets:

```bash
wrangler secret put PREVIEW_TOKEN_SECRET --env production   # HMAC for preview→confirm
# AUTH_ISSUER / MCP_RESOURCE_URL vars per auth/verifier.ts once the prod issuer is fixed
```

## 2. Deploy the worker

```bash
pnpm oracle:check                    # the contract fixtures still match the live backends
pnpm typecheck && pnpm test          # repo root, must be green
node bin/build-kb-index.mjs          # refresh the bundled BM25 index
cd apps/worker && wrangler deploy --env production
```

`oracle:check` comes first because `pnpm test` cannot replace it: every contract
gate compares the committed `fixtures/contract-oracle/*.contract.json` against this
repo's TypeScript, so a fixture that went stale takes the whole suite green with
it. It needs Docker up for the four backends (`./dev up` in each), which is why it
is not part of `pnpm test`, and why CI cannot run it either (see [CI](#ci-bitbucket-pipelines)).
Skip it only when no backend has moved since the last `pnpm oracle:refresh`;
shipping a worker whose tools were validated against a stale copy of the backend is
exactly the bug this catches.

`pnpm typecheck && pnpm test` is the same suite CI runs, so the pre-push hook
(`pnpm hooks:install`) has usually run it for you already.

First deploy prints the `*.workers.dev` URL: that URL is what a production copilot's
`MCP_BASE_URL` points to (custom domain `mcp.gtm-api.com` later: add a route + flip
`workers_dev = false`).

## 3. Load the vector index

```bash
export CLOUDFLARE_ACCOUNT_ID=…  CLOUDFLARE_API_TOKEN=…   # the §0.3 token
node bin/vectorize-kb.mjs --dry-run    # shows embed/delete counts
node bin/vectorize-kb.mjs              # embeds changed chunks, upserts, prunes stale ids
```

The script is incremental (manifest in `bin/.vectorize-manifest.json`, gitignored):
only new/changed chunks are embedded, ids that disappeared from the corpus are deleted.
`--full` forces a complete re-embed (e.g. after changing the embedding model; keep
`EMBEDDING_MODEL` in `vector-retriever.ts` and `vectorize-kb.mjs` in lockstep, and
recreate the index if dimensions change).

## 4. Smoke

```bash
WORKER=https://gtm-mcp.<account>.workers.dev
curl -s -X POST "$WORKER/mcp/support/knowledge" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $PROD_JWT" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_knowledge","arguments":{"query":"connect linkedin account"}}}'
```

A hybrid response is indistinguishable from BM25 in shape; to confirm the vector path is
live, check the worker logs (`wrangler tail --env production`): a
`support_kb_vector_fallback` event means the vector path failed and BM25 answered.

## KB update loop (after every article edit)

```bash
node bin/build-kb-index.mjs                      # bundled index (dev + prod fallback)
cd apps/worker && wrangler deploy --env production
cd ../.. && node bin/vectorize-kb.mjs            # embeddings (incremental)
```

Order matters only in that the deploy ships the new BM25 fallback; vectorize can run
before or after. Costs: bge-m3 embedding of the whole current corpus is fractions of a
cent; Vectorize storage/query at this scale is effectively free tier.

## CI (Bitbucket Pipelines)

`bitbucket-pipelines.yml` at the repo root. It runs on every pull request and on
every push to `master`, three steps in parallel on a pinned `node:24-bookworm`
(full image, not `-slim`: git has to be there, and Node 24 strips TypeScript types
natively, which the OpenAPI generator runs on).

| Step | Command | What it holds |
|---|---|---|
| Typecheck | `pnpm typecheck` | `tsc` over every workspace package |
| Gates (vitest) | `pnpm test` | contract-parity, oracle-freshness, coverage-gate, step-eligibility, research-parity, openapi-public-drift, dash-lint, worker-boot, plus the runtime unit tests |
| OpenAPI public drift | `SKIP_VALIDATE=1 pnpm openapi:public:check` | the committed public spec still matches the Zod registry |

Every step starts with `bash ci/setup.sh`: it pins pnpm to the `packageManager`
field in `package.json` and runs `pnpm install --frozen-lockfile` with the store at
`/opt/pnpm-store` (cached, keyed on `pnpm-lock.yaml`). The store stays outside the
clone on purpose, because `dash-lint` walks every text file under the repo root.

There is no deploy step. Cloudflare deploys stay manual (sections 1 to 4 above)
until the production config is settled.

### What CI does not run, and who does

| Not in CI | Why | Where it runs instead |
|---|---|---|
| `pnpm oracle:check` | regenerates the contract fixtures from four LIVE backends (Docker, DBs). No reviewer could fix that failure from the diff | workstation: first line of the deploy checklist above, and named by the pre-push hook |
| `pnpm test:e2e` | `RUN_E2E=1` calls every safe read tool through a running worker against live backends with a seeded team | workstation, before a release |
| `pnpm lint` | identical work to `pnpm typecheck` (every package's `lint` is the same `tsc --noEmit`) | nowhere, deliberately |
| the OAS validator | `bin/openapi-public.sh` normally ends with `gtm.openapi.tech/_tools/validate.py`; that validator, its `requirements.txt` and its venv live in a third repo | workstation: `pnpm openapi:public` validates in write mode and refuses to run without it, so the spec is validated whenever it is generated |

The fixture staleness that CI cannot see is the one that hurts most: every contract
gate reads `fixtures/contract-oracle/*.contract.json`, so a fixture that went stale
against a backend that moved makes all of them green for the wrong reason. **Run
`pnpm oracle:check` locally before you push anything that follows a backend
change**, and `pnpm oracle:refresh` when it reports drift.

### The pre-push hook

```bash
pnpm hooks:install       # git config core.hooksPath bin/hooks
```

`bin/hooks/pre-push` runs `pnpm typecheck && pnpm test` (a couple of seconds, the
same offline gates as CI) and then prints the `pnpm oracle:check` reminder. Opt in
per clone, versioned in the repo, `git push --no-verify` bypasses it once,
`git config --unset core.hooksPath` turns it off.

### The umbrella corpus (cross repo input)

Two gates read files this repo does not own, resolved relative to the repo root
because a workstation has gtm.mcp checked out at `<umbrella>/product/mcp/gtm.mcp`:

| Path | Read by |
|---|---|
| `../../research` | `tests/research-parity.test.ts` (the design side of every tool) |
| `../../openapi/gtm.openapi.public` | `tests/openapi-public-drift.test.ts`, `bin/openapi-public.sh` |

Both live in the umbrella repo `gtm-api/gtm.ai`. A CI clone has only gtm.mcp, so
`ci/fetch-corpus.sh` sparse clones the umbrella and symlinks those two paths into
the same relative offset (on a workstation it finds them already there and does
nothing). It needs read access to `gtm.ai`, one of:

- an SSH key on this repo (Repository settings > SSH keys), public half added to
  `gtm.ai` as an access key, or
- a read-scoped repository access token in the secured repo variable
  `UMBRELLA_TOKEN`.

It fails loudly when it cannot get the corpus rather than skipping: a gate that
quietly stops reading its inputs is worse than a red one.

**Ordering rule.** A change here that also needs a research edit or a regenerated
public spec goes green only once the umbrella side is on `gtm.ai` master. Land it
there first (`pnpm openapi:public`, commit the regenerated
`product/openapi/gtm.openapi.public`), then push here.

## Not yet wired (deliberate)

- **Deploy from CI**: `build-kb-index → wrangler deploy → vectorize-kb` maps onto
  one more Pipelines step with `CLOUDFLARE_API_TOKEN` as a repo secret. Left manual
  until the production config is settled.
- **Custom domain / gateway route**, staging env, rate-limit bindings: later stages
  (see wrangler.toml header note).
