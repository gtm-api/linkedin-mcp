# Package & mount map

The registry holds one `mcp.{service}/{entity}` package per entity; a **mount** groups several of
them behind one URL and is the thing that carries a tool budget. The default budget is **25 tools**;
a mount may declare its own `maxTools`, and exactly one does today (`/mcp/linkedin/messaging`, 28).
Tool authoring reads this file to place a new tool, `apps/worker/src/mounts.config.ts` declares
the mounts, and the coverage gate tracks progress toward full coverage.

Rule: every public `/api` endpoint → exactly one tool (1:1). The counts below are read off the
**built registry** (`buildRegistry` + `resolveMounts` over the packages the worker mounts), not off
a plan. Every row below is ✅ shipped: three services are at full MCP coverage and the only remaining
gap is `gtm.service.email`, which has no package and therefore no row.

## mcp.linkedin: 11 mounts / 150 tools

> 2026-07-24 service split: `linkedin-tracked-posts` / `-comments` / `-engagements` / `-searches` /
> `-search-results` left this backend for `gs.service.signals`, and the outbound authoring verbs
> collapsed into the stateless `linkedin-posting` group (`create-post`, `comment`, `react`). Post
> READING is `linkedin-scraping` (get-post-comments / -commenters / -reactors / -resharers) and
> `linkedin-enrichment` (post-details); the saved-search job store is gone, so `/mcp/linkedin/data`
> is the credit ledger alone.

| Mount group | Mount | Registry packages (tools) | Tools | Status |
|---|---|---|---|---|
| accounts | `/mcp/linkedin/accounts` | linkedin_accounts (18), linkedin_account_smart_limits (3) | 21 | ✅ |
| account_monitor | `/mcp/linkedin/account-monitor` | linkedin_account_snapshots (1), linkedin_benchmarks (1), linkedin_account_quota_hits (1), linkedin_account_block_log (1), linkedin_account_activity_log (2), linkedin_account_sync_runs (3) | 9 | ✅ |
| messaging | `/mcp/linkedin/messaging` | linkedin_conversations (13), linkedin_messages (12) | 25 | ✅ (budget **28**, 3 free) |
| network | `/mcp/linkedin/network` | linkedin_connections (6), linkedin_connection_requests (6), linkedin_connection_invitations (6), linkedin_followers (3) | 21 | ✅ |
| content | `/mcp/linkedin/content` | linkedin_posting (3: create-post, comment, react) | 3 | ✅ |
| scraping | `/mcp/linkedin/scraping` | linkedin_scraping (21) | 21 | ✅ |
| auto_scrapes | `/mcp/linkedin/auto-scrapes` | linkedin_auto_scrapes (10), linkedin_auto_scrape_runs (2), linkedin_auto_scrape_results (1) | 13 | ✅ |
| enrichment | `/mcp/linkedin/enrichment` | linkedin_enrichment (19) | 19 | ✅ |
| data | `/mcp/linkedin/data` | data_requests (2) | 2 | ✅ |
| browsers | `/mcp/linkedin/browsers` | antidetect_browsers (8), antidetect_browser_proxies (3), antidetect_browser_logs (1), cloud_browsers (1), cloud_browser_sessions (2) | 15 | ✅ |
| platform | `/mcp/linkedin/platform` | linkedin_custom_requests (1, admin-gated escape hatch) | 1 | ✅ |

`/mcp/linkedin/auto-scrapes` shipped 2026-07-27 and is a **new mount, not a tenant of an existing
one** - the 13 routes it covers were the last of this service's ratchet debt, so `linkedin.baseline`
went 13 → 0 and `linkedin.uncovered_routes` is empty. The three
auto-scrape packages (13 tools) ride together for the same reason `mass_actions` +
`mass_action_items` do: they are read as one chain (find the saved job → drill into the run that
executed it → read the leads that run discovered), and the child search tools are useless without the
parent. Neither existing candidate was honest:

- **`/mcp/linkedin/scraping`** (21 / 25) is the nearest domain and still the wrong home. It does not
  fit at all (21 + 13 = 34, so it would take a budget of 34 and gut the reason the cap exists), and
  the two surfaces answer different questions - the design research (§9.6, in the private
  monorepo) layers them deliberately: scraping is
  a run-now, one-page pull with the rows inline in the HTTP response and credits debited per call;
  an auto-scrape is a saved, deduped, multi-page, optionally recurring job with persisted results and
  a new-lead delta. The mount instruction on each now names the other, so the router is explicit.
- **`/mcp/linkedin/account-monitor`** (9 / 25) fits on arithmetic alone and is wrong on every other
  axis. That mount is declared read-only account health and audit; auto-scrapes carry 8 write verbs
  (create, update, delete, pause, resume, run-now, set-/unset-mass-action). The LinkedIn account is
  only the *executor* that paginates the source, not the subject, so an LLM asked to "pull everyone
  who liked our launch post every week" would never open a mount described as account health.

It sits at **13 / 25**, which leaves room for the surface to grow (the research defers a
pool-executor mode and a v2 signals consumer) without another budget conversation.

⚠️ `/mcp/linkedin/messaging` is the one mount off the default budget: **25 / 28**, raised from 25 on
2026-07-27 (Eugene). The 28 is a product decision, not a test fix. The inbox is a single job to a
client (find the thread, read it, answer it), so the alternative - splitting `linkedin_conversations`
from `linkedin_messages` onto two URLs - would make a client mount twice to do one thing.
`resolveMounts` throws at module scope on the 29th tool, which kills the worker isolate rather than
degrading one mount, and `tests/worker-boot.test.ts` is the only thing that catches it: read its
headroom table before authoring a messaging tool.

## mcp.orchestration: 2 mounts / 21 tools

`gtm.service.orchestration` owns the cross-service plumbing: one webhook registry and one delivery
log for every producer service, plus mass actions. Base URL `ORCHESTRATION_BASE_URL` (local `:8025`,
`:8056` through the mitm tap).

| Mount group | Mount | Registry packages (tools) | Tools | Status |
|---|---|---|---|---|
| webhooks | `/mcp/orchestration/webhooks` | webhooks (6), webhook_logs (4) | 10 | ✅ |
| mass_actions | `/mcp/orchestration/mass-actions` | mass_actions (9), mass_action_items (2) | 11 | ✅ |

⚠️ `webhooks` + `webhook_logs` moved here from `mcp.linkedin/platform` at the 2026-07-26
orchestration cutover: the registry is platform-wide, so the log carries `account_sid`
(prefix-agnostic) and `source_service` instead of the old `linkedin_account_sid`, and `include`
accepts `webhook` only (the log cannot join another service's account table). The 6 + 4 route paths
did not change.

`mass_action_items` shipped 2026-07-27 and opened the `/mcp/orchestration/mass-actions` mount with
its 2 tools (`search_mass_action_items`, `retry_mass_action_items`). `retry` is the service's only
`mass_action: true` route, so its allow-list waiver in
`fixtures/contract-oracle/mass-action-allowlist.json` is gone and that list is empty for
orchestration. The 9 parent `mass_actions` tools landed on the same mount later that day
(`preview_` / `create_` / `search_` / `get_` / `delete_mass_action`, `get_mass_actions_metrics`,
`pause_` / `resume_mass_action`, `release_mass_action_canary`), which took the orchestration ratchet
to **0** and emptied its `drift-ledger.json` lists: the service is at full MCP coverage. All four
parent lifecycle verbs are `massAction: false` / `stepEligible: false` by declaration, not by
omission: the fan-out this service performs is the RUN, and its control surface is single-target
(the backend's SERVICE_CONVENTIONS §R4: the flags describe the verb's own request shape, not what
the run does).

⚠️ **`create_mass_action` is deliberately `dangerous: false`.** Two different `commit_token`s exist
and they collide on the JSON key. The BACKEND one is minted by `POST /api/mass-actions/preview` and
consumed by `POST /api/mass-actions`: a 15-minute HMAC over the plan + scope + schedule + canary +
caller, and the run's single consent artifact. The WORKER one is the preview-gate token that
`server-factory.ts` injects into every `dangerous: true` tool. Had create carried the gate, the gate
would have read the caller's backend token, failed to verify it as its own HMAC, and answered
"request a fresh preview" without ever calling the backend, so no run could ever be committed. The
backend contract is also the stronger gate (it validates and prices the whole plan before a single
item is enrolled), and the research locks exactly one consent layer for plan mode. `buildRequest`
(`runtime/src/url.ts`) was narrowed in the same change to strip `commit_token` only for
`dangerous` tools, since on a non-dangerous tool no gate ever touched the args and the field is the
tool's own. `delete_mass_action` keeps the generic gate: its input is a bare sid.

Things the tools do NOT expose, because the live controllers do not serve them (research describes
all of them): on the child surface, `include[]` (`MassActionItemSearchRequest` declares no include
rule and the controller never builds an `included` block) and a `counts` block (`mcpSearch` is called
without one); on the parent surface, the same missing `counts` block, and the `items` /
`failed_items` / `cancelled_items` includes (only `metrics` is built, and only by `get`). Run-level
aggregation is the parent's `metrics` tool.

## mcp.id: 5 mounts / 77 tools

| Mount group | Mount | Registry packages (tools) | Tools | Status |
|---|---|---|---|---|
| identity | `/mcp/id/identity` | users (2), teams (6), team_members (6), sessions (2) | 16 | ✅ |
| access | `/mcp/id/access` | api_keys (7), oauth_clients (5), oauth_authorizations (3), account_shares (5) | 20 | ✅ |
| billing | `/mcp/id/billing` | billing_products (1), billing_subscriptions (13), billing_transactions (4), billing_payment_methods (3) | 21 | ✅ |
| credits | `/mcp/id/credits` | credit_transactions (4) | 4 | ✅ |
| platform | `/mcp/id/platform` | notifications (4), ssl_certificates (7), observability_requests (2), support_requests (3) | 16 | ✅ |
⚠️ `account_shares` moved here from `mcp.linkedin/platform` at the 2026-07-26 handover cutover: a
handover binds TWO tenants that may live in different clusters, so the record and its tools belong on
`gtm.service.id`, and the LinkedIn service now exposes only the six internal `/internal/handover/*`
channel verbs (never MCP tools). `account_transfers` stays out of MCP **by design**: its 4 controller
methods carry no `#[ApiMethod]`, which is the gate, so an LLM can never give a connected account away
permanently.

**`account_shares` (5 tools) shipped 2026-07-27 onto `/mcp/id/access`, and got NO mount of its own.** This
supersedes the earlier plan for a `/mcp/id/handover` mount. `access` is already the "who may act on
this team's behalf, and how do I take it back" surface: an API key is a machine acting as the team,
an OAuth authorization is a third-party app acting for the user, and a share is another *team* acting
through this team's connected account. All three are granted and revocable, which is why `recall` and
`return` read naturally next to `rotate` and `revoke`. The alternatives were worse for
discoverability: `/mcp/id/identity` is the org roster (users, teams, members, sessions) and a share
crosses tenants rather than adding one to yours; `/mcp/id/platform` is the leftovers drawer
(notifications, certificates, observability, support) and nothing about delegation belongs there; and
a standalone 5-tool mount would mean a client that mounted `/mcp/id/access` to manage delegated
access silently could not see the one grant that hands over a live LinkedIn identity. It fits without
a budget change: 15 + 5 = **20 / 25**.

The 5 routes were this service's whole ratchet debt, so shipping them took `ratchet.json`
`id.baseline` 5 → 0, emptied `id.uncovered_routes` in `drift-ledger.json`, and cleared both entries
from `fixtures/contract-oracle/mass-action-allowlist.json` (`recall` and `return` declare
`massAction: true`, which is what closes the waiver; declaring `false` would have failed the parity
gate the other way).

## mcp.email: no package, 44 routes of debt

`gtm.service.email` has no MCP package at all, so nothing in this file describes it and
nothing in the worker serves it. That is a coverage gap the size of a service: **44** public
routes, 13 of them ACTION, 0 covered.

⚠️ `POST api/email-messages/send` is `stepEligible: true` + `scheduleRequired: true`. The
orchestration engine may name it as a mass-action plan step and call it once per item over its
`/internal` hop, so a run can spend its whole target set on a verb no agent can describe,
inspect or call. It is waived by name in `fixtures/contract-oracle/step-eligible-allowlist.json`
until the tool ships.

Since 2026-07-27 the three registry-keyed gates carry email with an empty package set instead
of skipping it, so the 44 routes are counted like any other debt: `ratchet.json` baseline `44`,
all 44 listed in `drift-ledger.json`. Authoring the package burns both down route by route.

## mcp.support: 1 mount / 2 tools

No backend service: the KB is bundled into the worker (BM25 index, plus Cloudflare Vectorize in
production), so the 1:1 `/api` rule does not apply here.

| Mount group | Mount | Registry packages (tools) | Tools | Status |
|---|---|---|---|---|
| knowledge | `/mcp/support/knowledge` | kb_articles (2: search_knowledge, get_kb_article) | 2 | ✅ |

## Facade

`/mcp`: `facade: 'toolsets'` (3 meta-tools) over all four services, **250 tools**
(linkedin 150 + id 77 + orchestration 21 + support 2).

The support row used to be left out of the facade's selectors, with the note that "support is not a
service". That was wrong twice over. `support` is a `ServiceId` like the other three, and the
selectors never gated reachability in the first place: `list_toolsets` and `get_toolset_tools` are
projections of the catalog `index.ts` hands the facade (`DOMAIN_MOUNTS`, i.e. **every** non-facade
mount, `support.knowledge` among them), and `call_tool` resolves names against the whole
`registry.byName`. Both KB tools were already callable through `/mcp` while this file said they were
outside it. The selector list drives one thing only: the DECLARED surface, which is the `/health`
tool count for this path and the number quoted here. Listing three services made both under-report by
2, so the fourth selector was added on 2026-07-27 and `tests/worker-boot.test.ts` now asserts the
facade's declared set equals the registry, which is what stops that number drifting again. The KB
running on a bundled index instead of a backend service is a dispatch detail (`localHandler`), not a
reason to hide it from the one endpoint that is meant to be the whole platform.

Totals: **49 registry packages / 250 tools**, served over **19 mounts + 1 facade**. By service:
linkedin 150 (27 packages), id 77 (17), orchestration 21 (4), support 2 (1). Every number in this
file is read off the built registry (`buildRegistry` over the four barrels, then `resolveMounts` over
`MOUNTS`); the per-mount ones are the headroom table `tests/worker-boot.test.ts` prints on a green
run, so re-run it rather than editing a count by hand.

Remaining coverage debt is **44** routes and all of it is `gtm.service.email`. `gtm.service.linkedin`,
`gtm.service.id` and `gtm.service.orchestration` are each at full coverage (ratchet 0, empty ledger):
linkedin and id got there on 2026-07-27 with the auto-scrapes and account-shares packages.

Live smoke coverage is no longer a thing to remember. `/mcp/linkedin/auto-scrapes` shipped without a
row and the gap sat here as a written-down follow-up; `/mcp/support/knowledge` had the same gap and
nobody had noticed it at all. Both now have rows, and the table they live in
(`tests/e2e/smoke-mounts.ts`) throws at COLLECTION time when a mount in `mounts.config.ts` has none,
so `pnpm test` goes red on the offline run rather than a mount shipping unexercised. The same module
checks each row against the registry: the named tool has to be on that mount, a row's "stub" has to
actually be `availability: 'stub_501'`, and its arguments have to satisfy the tool's own schema.
That last pair caught two rows calling GA creditable tools (`scrape_linkedin_similar_profiles`,
`enrich_linkedin_person_contact_info`) in the belief they were stubs.
