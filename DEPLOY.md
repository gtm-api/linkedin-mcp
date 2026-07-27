# Deploying gtm.mcp to Cloudflare

Three wrangler environments, and the default one is not deployable on purpose:

| Env | Command | Lands on |
|---|---|---|
| default | `pnpm dev` | `wrangler dev` on :8788, no cloud bindings |
| `staging` | `pnpm deploy:staging` | `gtm-mcp-staging.<account>.workers.dev` |
| `production` | `pnpm deploy:production` | `gtm-mcp.<account>.workers.dev` |

Local dev is unaffected by anything here: the default env has no cloud bindings and
the support KB serves from the bundled BM25 index.

Both deploy scripts run `bin/deploy-preflight.mjs` first and stop on the first
unfilled placeholder, so the ordered walkthrough below is the only supported path.

> The production script is `deploy:production`, not `deploy`, because **`pnpm deploy`
> is a pnpm built-in** (it packs a workspace package into a deployable directory) and
> shadows a script of that name. `pnpm deploy` here does not run wrangler at all: it
> exits with `ERR_PNPM_NOTHING_TO_DEPLOY`. A colon-suffixed name has no such clash.

> **Read [Blockers](#blockers-the-first-production-deploy-cannot-happen-yet) first.**
> Two of them are outside this repo, and neither can be worked around by anything in
> the runbook.

## Blockers: the first production deploy cannot happen yet

| # | Blocker | Effect | Who clears it |
|---|---|---|---|
| 1 | **No orchestration host exists.** `gateway_orchestration_backend` is the literal `REPLACE_ME:80` and the `/orchestration/v4` route is commented out in `gateway_routes` (`host_vars/id-beta.yml`), because an unresolvable `proxy_pass` upstream fails `nginx -t` and would take the whole edge down. | `ORCHESTRATION_BASE_URL` has no value that exists. Two mounts need it, so `requiredBaseUrlServices()` includes `orchestration` and the missing URL is **fatal**: `/health` and every mount answer 503. Not a partial outage, a total one. | **Eugene.** Create the box, fill `gateway_orchestration_backend` + `cluster_allowed_ips` + `inventory/beta.ini`, uncomment the route, re-run `provision-id.yml --tags gateway`. Then set the var to `https://app.gtm-api.com/orchestration/v4`. |
| 2 | **`AUTH_ISSUER` has no single correct value.** `verifier.ts` does an exact `payload.iss !== auth.issuer` match. The id service sets no `iss` custom claim, so jwt-auth's `Claims/Factory::iss()` returns `$this->request->url()`, the URL of the *minting endpoint*. Probed against the running container: a gateway-minted token carries `iss = https://app.gtm-api.com/oauth/token`, while the id service advertises its issuer as `https://app.gtm-api.com/id/v4` (`config('app.url')`), which is also the only value the discovery document can publish as an authorization server. | Pick the advertised issuer and **every token 401s** with `issuer mismatch`. Pick the token endpoint and the discovery document names a token endpoint as an authorization server, which no MCP client can bootstrap from. `AUTH_MODE=jwt` has never run against a real id-minted token: the worker's own tests use a synthetic issuer that matches by construction, and the live e2e ran in `AUTH_MODE=dev`, where the `iss` check is deliberately relaxed. | **Eugene**, by choosing the fix. Either the id service mints an explicit `iss` claim equal to `config('app.url')` (which RFC 8414 requires of it anyway), or the worker splits the verify-issuer from the discovery-issuer. Both are code changes, not config. |

Everything else in this document is ready to run.

Production adds five account resources:

| Resource | Binding | Purpose |
|---|---|---|
| KV namespace | `COMMIT_TOKENS` | single-use commit tokens for the preview→confirm gate |
| Vectorize index `gtm-kb` | `VECTORIZE_KB` | embedded support-KB chunks (semantic retrieval) |
| Workers AI | `AI` | query-time embeddings (`@cf/baai/bge-m3`, 1024 dims) |
| Rate limiter | `RATE_LIMIT_CALLS` | per-tenant ceiling on all tool calls (600 / 60s) |
| Rate limiter | `RATE_LIMIT_WRITES` | per-tenant ceiling on non-read-only tool calls (120 / 60s) |

The two rate limiters need no provisioning step: `namespace_id` in the
`[[env.production.ratelimits]]` blocks is ours to choose and only has to be unique per
worker. With neither bound the gate still runs, counting per isolate instead of per
account, and `/health` reports `rate_limit.status: "isolate_local"` so the difference is
visible rather than assumed. Their `simple.limit` and the `RATE_LIMIT_*_PER_WINDOW` vars
have to be changed together: the binding enforces, the var is what the agent is told.

When `AI` + `VECTORIZE_KB` are bound, `search_knowledge` runs **hybrid** retrieval
(vector + BM25, RRF-fused) and degrades to BM25 on any vector-path error.

## The runbook

Each step is marked with **who runs it**. Steps marked *Eugene* touch the Cloudflare
account or a value only he can read; everything else is repo-local and any engineer
can run it. Do the steps in order: the preflight in step 3 is what makes step 5 a
single reviewed command.

### Step 0. Account prerequisites, once per account (Eugene)

1. Cloudflare account on the **Workers Paid** plan (Vectorize + Workers AI need it).
2. `wrangler login` on the deploying machine (or export `CLOUDFLARE_API_TOKEN`).
   Nothing before this step needs credentials, including the preflight.
   ```bash
   cd apps/worker && pnpm exec wrangler login
   pnpm exec wrangler whoami        # confirms the account the deploy will land in
   ```
3. An API token for the KB pipeline (used by `bin/vectorize-kb.mjs`, **not** by the
   worker): account permissions **Workers AI: Run** + **Vectorize: Edit**. Store as
   `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` in `~/.gtm-secrets` and render
   into the shell env when running that script.

### Step 1. Fill the config (any engineer, then Eugene for the rest)

The two backend gateway URLs are **already filled** in `apps/worker/wrangler.toml`
for both envs, derived from `gateway_routes` + `gateway_server_name` in
`product/deployment/gtm.deployment.ansible/host_vars/id-beta.yml`:

```toml
LINKEDIN_BASE_URL = "https://app.gtm-api.com/linkedin/v4"
ID_BASE_URL       = "https://app.gtm-api.com/id/v4"
```

> The host is **`app.gtm-api.com`**, not the apex. `product/deployment/README.md`
> still says `https://gtm-api.com/{svc}/v4`; that is stale. The apex serves the
> WordPress landing on DigitalOcean, and `gateway_server_name` plus
> `app_url: "https://app.gtm-api.com/id/v4"` in the same host_vars settle it.

What is still a placeholder, and who supplies each one:

| Var | Supplied by | How |
|---|---|---|
| `ORCHESTRATION_BASE_URL` | Eugene | Blocker 1 above. No value exists until the box does. |
| `AUTH_ISSUER` | Eugene | Blocker 2 above. Needs a decision, not a lookup. |
| `MCP_RESOURCE_URL` | Eugene | The workers.dev URL echoed by the step 4 staging deploy, plus `/mcp`. |
| `COMMIT_TOKENS.id` | Eugene | Step 4 / step 5 (`wrangler kv namespace create`). |
| `PREVIEW_TOKEN_SECRET` | Eugene | Step 4 / step 5 (`wrangler secret put`). Never committed. |

### Step 2. Local gates (any engineer)

```bash
pnpm oracle:check              # contract fixtures still match the live backends
pnpm typecheck && pnpm test    # the same suite CI runs, must be green
pnpm e2e                       # the LIVE arm: real worker, real backends, real envelopes
node bin/build-kb-index.mjs    # refresh the bundled BM25 index
```

`oracle:check` comes first because `pnpm test` cannot replace it: every contract gate
compares the committed `fixtures/contract-oracle/*.contract.json` against this repo's
TypeScript, so a fixture that went stale takes the whole suite green with it. It needs
Docker up for the four backends (`./dev up` in each), which is why it is not part of
`pnpm test` and why CI cannot run it either (see [CI](#ci-bitbucket-pipelines)). Skip
it only when no backend has moved since the last `pnpm oracle:refresh`.

`pnpm e2e` is the other gate CI cannot run, and the only one that holds a tool's
`outputSchema` against a response a backend really sent. It brings up everything it
needs and tears it down again; what its coverage block means, and what has to be green
before a release, is [The live e2e arm](#the-live-e2e-arm).

### Step 3. Preflight (any engineer, no credentials needed)

```bash
pnpm deploy:preflight            # env.production
pnpm deploy:preflight:staging    # env.staging
```

Exit 0 means ready; exit 1 prints every blocker with the var name and who supplies it.
It reads `wrangler.toml` directly and runs **every offline check first**, so it gives a
straight answer on a laptop with no `wrangler login` and no network. Only once those
pass does it ask the account whether `PREVIEW_TOKEN_SECRET` is set, and it treats "I
could not check" as a blocker rather than a pass.

It refuses on: any var still carrying a `TODO` / `REPLACE_ME` placeholder, a base URL
that is not absolute http(s), `AUTH_MODE` that is not `jwt`, an `ENV_NAME` that
disagrees with the block it sits in, an unset or placeholder `COMMIT_TOKENS` id, a
missing rate-limit binding, and a `RATE_LIMIT_*_PER_WINDOW` var that disagrees with the
`simple.limit` the binding actually enforces.

Both deploy scripts run it, so a deploy cannot skip it by accident.

### Step 4. Staging first (Eugene)

**The first live wrangler run must not be production.** Staging is a separate worker
script with its own URL, KV namespace, rate-limit counters and secret; deleting it
never touches `gtm-mcp`.

```bash
cd apps/worker

pnpm exec wrangler kv namespace create COMMIT_TOKENS --env staging
#   -> paste the echoed id into [[env.staging.kv_namespaces]] id

pnpm exec wrangler secret put PREVIEW_TOKEN_SECRET --env staging
#   -> paste 32+ random bytes, e.g. from `openssl rand -base64 32`
#      A DIFFERENT value from production: a staging commit token must never be
#      redeemable there.

cd ../.. && pnpm deploy:staging
```

The deploy prints `https://gtm-mcp-staging.<account>.workers.dev`. Put that URL plus
`/mcp` into `MCP_RESOURCE_URL` in `[env.staging.vars]`, then run `pnpm deploy:staging`
again so the worker's `aud` check and discovery document name its own real URL.

Now run the [post-deploy checks](#post-deploy-checks) against the staging URL. This is
where blocker 2 gets settled: staging is the safe place to discover that a real
id-minted token does or does not pass the `iss` check.

> Staging talks to the **same backends as production**, because there is no backend
> staging to talk to: `inventory/staging.ini` is a skeleton with every `ansible_host`
> still `REPLACE_ME`, and the playbooks pin the beta hosts. Treat any write here as a
> production write. Its rate limits are deliberately tighter (120 calls / 20 writes per
> minute) for the same reason.

### Step 5. Production (Eugene)

Only after staging is green and both blockers are cleared.

```bash
cd apps/worker

pnpm exec wrangler kv namespace create COMMIT_TOKENS --env production
#   -> paste the echoed id into [[env.production.kv_namespaces]] id

pnpm exec wrangler vectorize create gtm-kb --dimensions=1024 --metric=cosine
#   dimensions MUST match the embedding model (bge-m3 -> 1024)

pnpm exec wrangler secret put PREVIEW_TOKEN_SECRET --env production
```

Then the one reviewed command, from the repo root:

```bash
pnpm deploy:production
```

That is `deploy-preflight.mjs production && wrangler deploy --env production`. The
`--env production` is not optional decoration: without it wrangler publishes the
**default (dev) config** to the public internet, which is a worker named `gtm-mcp-dev`
with no rate-limit bindings and a KV id that does not exist. The script used to omit
it.

First deploy prints the `*.workers.dev` URL. Set `MCP_RESOURCE_URL` to that URL plus
`/mcp` and deploy once more, exactly as in step 4. That URL is what a production
copilot's `MCP_BASE_URL` points to (custom domain `mcp.gtm-api.com` later: add a route
and flip `workers_dev = false`).

### Step 6. Load the vector index (Eugene, production only)

See [Load the vector index](#load-the-vector-index) below. Staging has no `AI` or
`VECTORIZE_KB` binding on purpose, so its `search_knowledge` serves from the bundled
BM25 index, which is the documented fallback.

## Post-deploy checks

Run these against whichever env you just deployed.

```bash
WORKER=https://gtm-mcp-staging.<account>.workers.dev   # or gtm-mcp.<account>.workers.dev
```

**1. Health.** This is the gate: nothing else is worth reading until it is `ok`.

```bash
curl -s "$WORKER/health" | jq '{status, problems, rate_limit, preview_gate, commit_tokens}'
```

- `"status":"ok"` and `problems: []` means the deploy is done.
- `"status":"degraded"` with HTTP 200 means it serves with a fail-closed piece
  missing. Read `problems[]`; the usual causes are an unset `PREVIEW_TOKEN_SECRET` or
  an unbound `COMMIT_TOKENS`, both of which make dangerous tools refuse rather than
  misbehave.
- **HTTP 503** means it is not serving at all and `problems[]` names the exact var.
  Expect this until blockers 1 and 2 are cleared.
- Confirm `rate_limit.status` is `"edge"`. `"isolate_local"` means the `[[ratelimits]]`
  bindings did not resolve for this env, so a distributed caller is uncapped.

**2. OAuth discovery.** The document an MCP client bootstraps from.

```bash
curl -s "$WORKER/.well-known/oauth-protected-resource" | jq
```

Expect `resource` to equal your `MCP_RESOURCE_URL` and `authorization_servers` to hold
the id service. A 503 here means the OAuth pair is still unset. Then confirm the
issuer it names actually resolves, which is the check blocker 2 is about:

```bash
curl -s "$(curl -s "$WORKER/.well-known/oauth-protected-resource" \
  | jq -r '.authorization_servers[0]')/.well-known/oauth-authorization-server" | jq '.issuer, .token_endpoint'
```

**3. One live read tool call.** Reads only: no preview, no confirm, no writes.

```bash
curl -s -X POST "$WORKER/mcp/linkedin/accounts" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $PROD_JWT" -H "Team-SID: $TEAM_SID" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_linkedin_accounts","arguments":{"page_size":3}}}' | jq
```

A 401 with `WWW-Authenticate` means the token did not verify; `issuer mismatch` in the
body is blocker 2 confirming itself. A successful result proves the whole path: edge
auth, the rate-limit gate, the gateway prefix, and the backend.

Optionally the in-worker support KB, which needs no backend at all and so isolates a
backend problem from a worker problem:

```bash
curl -s -X POST "$WORKER/mcp/support/knowledge" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $PROD_JWT" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_knowledge","arguments":{"query":"connect linkedin account"}}}'
```

A hybrid response is indistinguishable from BM25 in shape; to confirm the vector path
is live, check `wrangler tail --env production`: a `support_kb_vector_fallback` event
means the vector path failed and BM25 answered.

## Rollback

```bash
cd apps/worker
pnpm exec wrangler deployments list --env production
pnpm exec wrangler rollback <deployment-id> --env production
```

Config-only mistakes (a wrong var) are faster to fix forward: edit `wrangler.toml`,
`pnpm deploy:production`. A rollback reverts the code **and** the vars bundled with that version,
so it also undoes a var you meant to keep.

## Reference: what config.ts refuses

`apps/worker/src/config.ts` checks the environment on every request and splits the
outcome in two:

| Outcome | HTTP | When |
|---|---|---|
| `fail` | **503** on `/health`, on both `.well-known` documents and on every mount | a base URL missing or still a TODO; `AUTH_MODE` unset/unknown; `AUTH_MODE=jwt` without `AUTH_ISSUER` or `MCP_RESOURCE_URL`; `AUTH_MODE=dev` in a deployed `ENV_NAME`; a non-numeric `BACKEND_TIMEOUT_MS` |
| `degraded` | 200, body `"status":"degraded"` | it serves, with a fail-closed piece missing: no `PREVIEW_TOKEN_SECRET`, no `COMMIT_TOKENS` binding, no platform rate-limit binding |

The code carries the fatal case so a Cloudflare Health Check alerts with no body
matching configured; the body carries `status` + an itemised `problems[]` so a
monitor can also alert on `degraded`, which is not a code-worthy outage. Curl
`/health` right after the first deploy and read `problems` before anything else.

The auth pair is not optional paperwork: with `AUTH_MODE=jwt` and no issuer the
edge would have nothing to compare `iss` and `aud` against, so both checks would
pass everything. That configuration is now refused instead of served.

`pnpm typecheck && pnpm test` is the same suite CI runs, so the pre-push hook
(`pnpm hooks:install`) has usually run it for you already.

## Load the vector index

```bash
export CLOUDFLARE_ACCOUNT_ID=…  CLOUDFLARE_API_TOKEN=…   # the step 0.3 token
node bin/vectorize-kb.mjs --dry-run    # shows embed/delete counts
node bin/vectorize-kb.mjs              # embeds changed chunks, upserts, prunes stale ids
```

The script is incremental (manifest in `bin/.vectorize-manifest.json`, gitignored):
only new/changed chunks are embedded, ids that disappeared from the corpus are deleted.
`--full` forces a complete re-embed (e.g. after changing the embedding model; keep
`EMBEDDING_MODEL` in `vector-retriever.ts` and `vectorize-kb.mjs` in lockstep, and
recreate the index if dimensions change).

## KB update loop (after every article edit)

```bash
node bin/build-kb-index.mjs    # bundled index (dev + prod fallback)
pnpm deploy:production         # ships the new BM25 fallback
node bin/vectorize-kb.mjs      # embeddings (incremental)
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
| Gates (vitest) | `pnpm test` | contract-parity, oracle-freshness, coverage-gate, step-eligibility, research-parity, openapi-public-drift, dash-lint, worker-boot, the worker's own config + edge tests (`apps/worker/src/*.test.ts`), plus the runtime unit tests |
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
| `pnpm e2e` | `RUN_E2E=1` calls every safe read tool through a running worker against live backends with a seeded team. CI has no Docker, no seeded database and no worker on :8788, so it structurally cannot | workstation: [The live e2e arm](#the-live-e2e-arm) below |
| `pnpm lint` | identical work to `pnpm typecheck` (every package's `lint` is the same `tsc --noEmit`) | nowhere, deliberately |
| the OAS validator | `bin/openapi-public.sh` normally ends with `gtm.openapi.tech/_tools/validate.py`; that validator, its `requirements.txt` and its venv live in a third repo | workstation: `pnpm openapi:public` validates in write mode and refuses to run without it, so the spec is validated whenever it is generated |

The fixture staleness that CI cannot see is the one that hurts most: every contract
gate reads `fixtures/contract-oracle/*.contract.json`, so a fixture that went stale
against a backend that moved makes all of them green for the wrong reason. **Run
`pnpm oracle:check` locally before you push anything that follows a backend
change**, and `pnpm oracle:refresh` when it reports drift.

### The live e2e arm

```bash
pnpm e2e                  # backends -> token -> worker -> suites -> coverage -> teardown
pnpm e2e --keep-worker    # same, but leave the worker up to debug a failure
```

**Who runs it:** the engineer cutting the release, on their workstation, as the last
gate before `wrangler deploy`. It has no other owner and no schedule, because there is
nowhere else it can run.

**What must be green before a release:**

| Gate | Command | Runs where |
|---|---|---|
| offline suite | `pnpm typecheck && pnpm test` | CI on every PR, and the pre-push hook |
| contract fixtures are current | `pnpm oracle:check` | workstation, step 2 of the runbook |
| **the live arm** | `pnpm e2e` | **workstation only, this section** |

**Why CI cannot run it, structurally.** The suites drive a real `wrangler dev` worker
over HTTP against three Laravel services on Docker, each with its own MySQL, seeded
with the DevSeeder identity, and they authenticate with a JWT minted by
`artisan jwt:fake` inside the linkedin container. A Pipelines runner has none of that,
and none of it can be faked without deleting the only thing the arm proves. This is not
"we have not got round to it": a mocked backend cannot tell you that a tool's
`outputSchema` matches what the backend actually returns, and that check exists nowhere
else in this repo. Every other gate compares TypeScript against TypeScript or against a
committed fixture.

**What one green run covers.** `bin/e2e.sh` prints it rather than leaving you to infer
it from a pass count:

- how many of the registered tools were called live, and how many of the domain mounts
  were smoked (the mount half is also gated offline: `tests/e2e/smoke-mounts.ts` fails
  collection if a mount in `mounts.config.ts` has no smoke row, so a new mount cannot
  ship unexercised);
- the read surface split four ways: **outputSchema parsed** (the real assertion),
  **needs-args** (the tool wanted a required filter and returned a clean error
  envelope), **no-data** (nothing seeded to read), **other-error**;
- what was not called, and why: mutating, creditable and outward tools are never run
  against a live tenant. One dangerous tool is driven to its PREVIEW step; no commit
  step ever runs.

Read `needs-args` and `no-data` as coverage debt, not as passes. They mean the call was
well formed and the error envelope was valid, which is worth something, but the
contract itself went unchecked. The way to move those into the parsed column is to seed
rows for them, not to call more tools.

**Record the result.** A green run is only evidence if someone can date it, so put the
date, the commit and the parsed/total from the coverage block next to the release. The
run leaves the full report at `tests/.e2e-coverage.json` (gitignored) if you want to
paste numbers rather than retype them.

**When it is red, nothing ships.** Re-run with `--keep-worker` and grep the dispatch
log it names; every call carries a `trace_id`.

The script is idempotent in both directions. A worker already listening on :8788 is
reused and left running; a worker the script started is stopped on success, on failure
and on Ctrl-C alike, by killing the whole process group (killing the wrapper alone
orphans `wrangler`, which then holds the port and makes the next run "reuse" a worker
built from the previous checkout).

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

- **Deploy from CI**: `build-kb-index → deploy-preflight → wrangler deploy →
  vectorize-kb` maps onto one more Pipelines step with `CLOUDFLARE_API_TOKEN` as a
  repo secret. Left manual until the two blockers above are cleared and a first
  production deploy has actually happened.
- **Custom domain**: `mcp.gtm-api.com` needs a route plus `workers_dev = false`.
  Both envs are on `*.workers.dev` until then.
- **A backend staging tier**: the worker now has a staging env, but it points at the
  beta backends because no staging host exists (`inventory/staging.ini` is a skeleton
  and the playbooks pin the beta hosts). Standing one up is an ansible-side change.
