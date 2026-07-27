# Oracle fixtures

This is the one place that explains how every oracle fixture in `fixtures/` is
regenerated. There is one oracle now: the contract oracle in this folder. The
hand-maintained `route-oracle/` next door was deleted once both route gates
started reading `routes[]` from these dumps.

`*.contract.json` are machine-generated dumps of each backend service's real
contract surface. Parity tests on this side compare the Zod schemas and the tool
registry against these files instead of against hand-written mirrors, so a
backend change that is not reflected in the TypeScript contract fails a test.

Do not hand-edit the `*.contract.json` dumps. Regenerate them. Every other file
in this folder is the opposite: `ratchet.json`, `drift-ledger.json`,
`mass-action-allowlist.json`, `step-eligible-allowlist.json` and
`enum-parity-baseline.json` are hand-maintained by whoever moves the coverage,
and each is described at the bottom of this page. All of them shrink only.

## Covered services

| Fixture | Backend | Entities | Routes (public `/api`) | Read by |
|---|---|---|---|---|
| `linkedin.contract.json` | `gtm.service.linkedin` | 25 | 173 (150) | coverage gate, ledger gate, contract parity, step-eligibility |
| `id.contract.json` | `gtm.service.id` | 22 | 130 (81) | coverage gate, ledger gate, contract parity, step-eligibility |
| `orchestration.contract.json` | `gtm.service.orchestration` | 4 | 30 (21) | coverage gate, ledger gate, contract parity, step-eligibility |
| `email.contract.json` | `gtm.service.email` | 12 | 58 (44) | coverage gate, ledger gate, contract parity, step-eligibility |

`email.contract.json` landed on 2026-07-27 with the `step_eligible` field, for the
cross-service step-eligibility gate: `gtm.service.email` owns `email-messages.send`,
the platform's paced bulk-send verb and a mass-action plan step, and that gate reads
the fixture *directory* rather than a service list.

There is still no `@gtm/mcp-email` package. Until 2026-07-27 that meant the three
registry-keyed gates left the service out entirely, and the arithmetic was worse
than it looked: **all 44** public email routes were uncovered, 13 of them ACTION,
and every gate counted that as zero. `POST api/email-messages/send` was the sharp
end. It is `stepEligible: true` and `scheduleRequired: true`, so orchestration
plans it and drives it once per item, while no MCP tool exists for an agent to
describe, inspect or call it, and nothing said so out loud.

Those three gates now carry email with an **empty package set** instead of
skipping it (`packages: []` in `coverage-gate.test.ts`, `oracle-freshness.test.ts`
and `contract-parity.test.ts`). The empty set is the honest input, not a
placeholder: it makes the service measured exactly the way the other three are, so
its 44 routes sit in `ratchet.json` and `drift-ledger.json` like any other debt,
and `email-messages.send` is waived by name in `step-eligible-allowlist.json` with
the reason it is not covered. Replace the empty set with `emailPackages` the day
the package is authored, and burn the numbers down from there.

A service appears here once its `src/bootstrap/app.php` registers the command
via `->withCommands([ContractOracle::class])` and its key is added to `SERVICES`
in `bin/oracle-refresh.sh`. Those two lists must move together: a backend that
registers the command but is missing from the script silently keeps a fixture
nobody refreshes.

`orchestration.contract.json` is read against a real package set since
`@gtm/mcp-orchestration` landed (2026-07-26). The 10 `webhooks` / `webhook-logs`
routes the linkedin ledger used to list under `stale_routes` are covered there:
they did not disappear, they moved service, so the tools were repointed rather
than retired. The 11 `mass-actions` / `mass-action-items` routes that were still
uncovered came off on 2026-07-27, which took this service to **full coverage**
(ratchet `0`, both ledger lists empty). The 8 `api/example-entity` routes the
`service.empty` scaffold used to ship were deleted from the backend on
2026-07-26 (bundle, routes and table), which is why the public count dropped from
29 to 21 and the orchestration ratchet from 19 to 11 before it reached 0.

## Regeneration

```bash
pnpm oracle:refresh                 # rewrite every covered fixture
pnpm oracle:refresh linkedin        # one or more (linkedin | id | orchestration | email)
```

That is `bin/oracle-refresh.sh`. It shells into each service directory, runs the
generator through the service's `./dev` wrapper (Docker must be up for that
service), sanity-checks the dump (right service key, non-empty entities, at
least one public `/api` route) so a half-booted run cannot overwrite a good
fixture, and moves it onto the fixture. Then run `pnpm test`.

## Freshness (`pnpm oracle:check`)

```bash
pnpm oracle:check                   # verify every fixture against its live backend
pnpm oracle:check id                # one or more
```

Same script, `--check`: it re-runs the generator into a temp dir, compares byte
for byte with what is committed, prints what moved (entities and routes added or
removed, routes whose `#[ApiMethod]` facts changed) and exits 1 on any difference.
It writes no fixture, so it is safe on a dirty tree.

**Run it whenever a backend contract may have moved, and before trusting a green
suite after a backend change.** Nothing in `pnpm test` can do this job. Every gate
that reads these fixtures is offline: it compares the committed JSON against this
repo's TypeScript, which cannot distinguish a dump taken a minute ago from one
that went stale three releases back. That is not a hypothetical: `id.contract.json`
was stale against the live backend and the entire suite was green both before and
after the refresh that fixed it. `oracle:check` is the only thing in this repo that
asks a running backend, which is why it costs Docker and lives outside vitest.

It is the same shape as `pnpm openapi:public:check`, deliberately: regenerate into
a temp location, diff, fail on drift.

The generator is the `gtm:contract-oracle` artisan command
(`gtm.lib.common/src/Core/Commands/ContractOracle.php`). It is read-only: no DB
access, no JWT, no writes other than the `--out` file. The four invocations the
script wraps, if you would rather run them by hand:

```bash
# linkedin
cd ~/sites/gtm.ai/product/backend/gtm.service.linkedin
./dev artisan gtm:contract-oracle --service=linkedin --out=storage/app/contract-oracle.json
mv src/storage/app/contract-oracle.json \
   ~/sites/gtm.ai/product/mcp/gtm.mcp/fixtures/contract-oracle/linkedin.contract.json

# id
cd ~/sites/gtm.ai/product/backend/gtm.service.id
./dev artisan gtm:contract-oracle --service=id --out=storage/app/contract-oracle.json
mv src/storage/app/contract-oracle.json \
   ~/sites/gtm.ai/product/mcp/gtm.mcp/fixtures/contract-oracle/id.contract.json

# orchestration
cd ~/sites/gtm.ai/product/backend/gtm.service.orchestration
./dev artisan gtm:contract-oracle --service=orchestration --out=storage/app/contract-oracle.json
mv src/storage/app/contract-oracle.json \
   ~/sites/gtm.ai/product/mcp/gtm.mcp/fixtures/contract-oracle/orchestration.contract.json

# email
cd ~/sites/gtm.ai/product/backend/gtm.service.email
./dev artisan gtm:contract-oracle --service=email --out=storage/app/contract-oracle.json
mv src/storage/app/contract-oracle.json \
   ~/sites/gtm.ai/product/mcp/gtm.mcp/fixtures/contract-oracle/email.contract.json
```

The dump is deterministic, so an unchanged backend regenerates a byte-identical
fixture and a noisy diff means the backend actually moved.

`--out` is resolved inside the container, so it has to point at a path under
`src/` (that is the only host-mounted tree). Without `--out` the command writes
the JSON to stdout, but the `./dev` wrapper prefixes docker-compose chatter, so
piping is not reliable.

`--service=` overrides the service key. It defaults to the last dotted segment
of `APP_NAME` (`gtm.service.orchestration` -> `orchestration`), which the command
StudlyCases into a folder name under `gtm.lib.common/src/Microservices/`
(`Orchestration`), falling back to a case-insensitive scan of that directory. No
service is special-cased, so passing `--service=` is only ever needed to dump a
service key that differs from the running app's name. If the folder does not
exist the command fails loudly and lists the ones that do, rather than emitting a
dump with an empty `entities` map.

## Shape

```jsonc
{
  "service": "linkedin",
  "entities": {
    "LinkedinAccount": {
      "domain":   { "class": "...Domain",   "fields": [{ "name", "type", "nullable", "has_default" }] },
      "response": { "class": "...Response", "fields": [ ... ] },   // null when the entity has no {Entity}Response
      "filter":   { "class": "...Filter",   "fields": ["status", ...] }   // null when there is no {Entity}Filter
    }
  },
  "enums": {
    // EVERY enum the contract can express, keyed by FQCN. The one enum block:
    // entities carry no nested enums (see the note below the route facts).
    "Gtm\\Lib\\Common\\Microservices\\Linkedin\\LinkedinAccount\\Enums\\LinkedinAccountStatusEnum": {
      "backing": "string",            // null for a pure enum
      "cases": [{ "name": "Active", "value": "active" }, ...]
    }
  },
  "routes": [
    {
      "method": "POST",
      "uri": "api/linkedin-posting/react",
      "controller": "App\\Entities\\LinkedinPosting\\LinkedinPostingController",
      "action": "react",
      "operation": "action",          // lowercased McpOperation, null when the method carries no #[ApiMethod]
      "mass_action": true,            // this verb's OWN surface takes a filter/targets[] set
      "step_eligible": true,          // orchestration may run this verb as a mass-action plan step
      "schedule_required": false,
      "declared_arguments": ["description", "massAction", "operation", "stepEligible"],  // what the call site actually WROTE
      "required_permission": null,
      "internal": false,              // true when the method carries #[InternalMethod]
      "request_class": "App\\Entities\\LinkedinPosting\\Requests\\LinkedinPostingReactRequest",  // null when the action takes none
      "rules": [                      // null when it could not be evaluated, see rules_reason
        {
          "field": "reaction",        // the rule key verbatim, dots and wildcards included
          "rules": ["required", "string", "in:\"like\",\"praise\""],  // every token, unchanged
          "required": true,
          "nullable": false,
          "type": "string",           // first type-declaring token, null when none
          "in": ["like", "praise"],   // literal values, enum-backed ones already resolved
          "min": null, "max": null, "size": null, "between": null
        }
      ],
      "rules_reason": null            // why `rules` is null; null when it is not
    }
  ]
}
```

Notes for consumers:

- `entities` keys are the entity name (the `{Entity}Domain` class name minus the
  `Domain` suffix), sorted. Fields are in constructor declaration order, which is
  the wire order the backend documents.
- `type` is the declared PHP type, rendered as written: `?string`,
  `Carbon\Carbon|string|null`, `int`, `mixed`. `nullable` is the resolved
  answer, so a consumer never has to parse the string to learn optionality.
- `routes` covers every registered route that resolves to a controller action,
  sorted by `uri` then `method`. HEAD is dropped (Laravel mirrors it onto every
  GET). Closure routes and framework noise are skipped because they have no
  controller. Filter on `uri.startsWith('api/')` and `!internal` to get the
  public MCP surface: that subset is what both route gates measure against.
- `mass_action` and `step_eligible` are the two INDEPENDENT bulk facts of
  SERVICE_CONVENTIONS §R4 and neither implies the other. `mass_action` means the
  verb's own request shape takes a set the owning service drains inline;
  `step_eligible` means the orchestration engine may run the verb as a plan step,
  calling it once per item over its `/internal` hop. `api/linkedin-posting/react`
  is both, `api/account-shares/recall` is only the first, and
  `api/email-messages/send` is only the second. Reading one for the other gives
  the wrong answer about what the verb can do.
- `declared_arguments` is the `#[ApiMethod]` constructor arguments the PHP call
  site ACTUALLY wrote, sorted, with positional ones mapped to their parameter
  names. It exists because the three booleans above cannot answer one question on
  their own: `massAction` defaults to `false`, so a verb nobody ever asked the
  question about is byte-identical to one somebody answered "single-target". Both
  sides then agree and every flag gate passes on an unanswered question - which is
  exactly how five orchestration routes went undeclared until 2026-07-27.
  `ReflectionAttribute::getArguments()` returns only what was passed, so the
  difference survives compilation and lands here. An empty list means the method
  carries no `#[ApiMethod]` at all: `operation` is required, so a real one always
  declares it. The field is additive - the booleans keep their keys and meaning.
- `rules` is the action's FormRequest `rules()`, one entry per rule key, in
  declaration order. It is the first thing in this document that describes what
  goes IN rather than what comes back, and it exists because the request body had
  no oracle at all: nothing could tell a tool that sends `{status: ...}` from one
  that sends `{state: ...}` until a tenant got a 422, which is how three GA tools
  shipped 422-ing on every possible call. Nested keys are kept whole
  (`filter.status`, `plan.steps.*.tool`) because the nesting is the contract.
- `rules: null` is NOT `rules: []`. An empty list means a FormRequest that
  declares no rules, so the action validates nothing. `null` means the rule set
  could not be read, and `rules_reason` says why: today every null is an action
  with no FormRequest on its signature, split between "takes no request object"
  (a `{sid}` route with no body) and "reads the raw request" (a body accepted
  with no rule set behind it, which is a finding, not a limitation of the dump).
  A `rules()` that throws would land here too rather than emit a half-evaluated
  rule set: a gate holding tools to a contract the backend never had is worse
  than a gate that knows it has no answer.
- `in` is resolved to literal values even when the PHP wrote
  `Rule::in(SomeEnum::values())`, `Rule::in(SomeEnum::cases())` or
  `new Enum(SomeEnum::class)`. A class name would be unusable to a consumer that
  cannot load PHP. The raw token stays in `rules` next to it.
- top-level `enums` is the ONE enum block, and it is convention-free: every real
  `enum` under the service's folder and under `Core/`, keyed by FQCN so a gate
  resolves without guessing.

  It used to sit next to a per-entity `enums` block that resolved three enums
  per entity by naming convention (`{Entity}{Sortable|Filterable|GroupBy}FieldEnum`).
  That block is **deleted**, on the evidence: 49 of the 63 entities emitted three
  empty arrays, not one status / kind / action-type enum ever appeared in it, all
  14 non-empty entries were already in this map under their FQCN, and no gate in
  this repo ever read it (`OracleEntity` never had the key). It was payload that
  looked like an answer, which is worse than an absent one - a reader who trusted
  `entities.X.enums.filterable === []` would conclude the entity closes no field.
  Ask this map by FQCN instead.

## The two route gates

Both read `routes[]` from these fixtures, for all four services. Neither has a
hand-maintained input any more, so neither can go green by carrying a stale copy
of the backend surface in this repo. Neither can tell whether the *fixture* is
current either: that is `pnpm oracle:check`, above. They split the work:

- **`tests/coverage-gate.test.ts` is the hard gate.** Per service: every
  registered tool must map to a route the backend actually serves, and the number
  of public `/api` routes with an `#[ApiMethod]` operation that no tool covers
  must stay at or below `ratchet.json`. It reports the raw disagreement and does
  not consult the ledger, so accepted debt still shows up red until it is paid
  off. A service with no MCP package is carried with an empty package set, so
  "no tools at all" reads as full debt rather than as nothing to check.
- **`tests/oracle-freshness.test.ts` is the ledger gate.** It checks the fixture
  is structurally sound (which catches a truncated or half-booted dump), that
  every disagreement is written down in `drift-ledger.json`, and that no ledger
  entry has stopped drifting. Its file name predates the split and overstates it:
  the docblock says what it actually owns, and points at `oracle:check` for the
  freshness half.

## The cross-service step-eligibility gate

`tests/step-eligibility.test.ts` is the only gate that reads every fixture at
once, and it reads the *directory* rather than a service list, so a backend with
no MCP package is still checked. It asserts three things about every route the
dumps report as `step_eligible`: it is a public `/api` ACTION; its
`internal/{same-path}` twin exists in the same dump and carries
`#[InternalMethod]` (without that hop, every item of a run planning it fails on
the wire); and no two services claim the same step-tool name.

It deliberately does NOT assert that the orchestration executor has an arm for
the verb - no dump carries the executor. That half is pinned in the backend, by
`MassActionStepToolEnum` in gtm.lib.common plus each declaring service's
`tests/Unit/Architecture/StepEligibilityTest`. Copying the vocabulary into this
repo would recreate exactly the hand-maintained mirror the oracle removed.

### The ratchet (`ratchet.json`)

Per service, the maximum number of public `/api` routes with an `#[ApiMethod]`
operation that no MCP tool covers. Routes with a `null` operation are excluded:
no attribute means the method is deliberately not an MCP surface, so it would
otherwise sit in the ratchet forever. A baseline may only ever decrease. Lower it
the moment coverage improves (the gate prints the new number when it drops);
never raise it to turn a red suite green. `0` means full coverage.

Every service the oracle dumps has an entry, including one with no MCP package:
`email` sits at `44`, its entire public surface. A service without a baseline is
not a service without debt, it is a service whose debt nobody counts, which is
what the `email` entry was fixing on 2026-07-27.

### The drift ledger (`drift-ledger.json`)

The written-down debt: the disagreements we know about today, listed route by
route with a note on why. `stale_routes` are routes a registered tool still
points at and the backend no longer serves; `uncovered_routes` are the routes the
ratchet counts. Anything not in it fails the ledger gate, and an entry that
stopped drifting fails it too, so the lists can only shrink. Adding an entry is a
deliberate, reviewable act; it records debt, it does not excuse it. Run
`pnpm oracle:check` before touching the ledger, and `pnpm oracle:refresh` if it
reports drift, so you never record debt that a stale dump invented.

### The mass-action allow-list (`mass-action-allowlist.json`)

Read by `tests/contract-parity.test.ts`, which compares the `mass_action` /
`schedule_required` flags in BOTH directions. TS -> backend is free: every action
tool is checked against the route it points at, and a tool aimed at a route the
backend does not serve fails there rather than being skipped. backend -> TS is
what this file exists for. A mass-action route fans one call out over `filter` /
`targets[]`, so a backend route with `mass_action: true` and no MCP tool is both
the most expensive thing to miss and the only direction that can be missed in
silence. Every public one is either covered by a tool that declares `massAction`,
or listed here per service as `{ route, reason }` with a one-line reason. Same
discipline as the ledger: an entry that stopped applying (route retired,
`mass_action` dropped, or a tool now covers it) fails the gate and prints the
line to delete, so the list can only shrink. It is a separate file from the
ledger because the ledger records missing *coverage* while this records a waived
*flag contract*; an uncovered mass-action route legitimately appears in both.

### The step-eligible allow-list (`step-eligible-allowlist.json`)

The same file, one flag over: read by the step-eligibility parity gate in
`tests/contract-parity.test.ts`, which compares `stepEligible` against
`step_eligible` in both directions. Two allow-lists rather than one because the
two flags are independent (§R4) and fail differently. A mass-action route we do
not expose is a fan-out surface the agent cannot reach; a step-eligible route we
do not expose is a verb the orchestration engine can plan and call once per item
while the agent has no tool to describe, inspect or invoke it. Empty arrays are
the goal state, not a placeholder, and the shrink discipline is identical: an
entry that stopped applying fails the gate and prints the line to delete.

`gtm.service.email` is in scope here since 2026-07-27, and carries the one waiver
in this file: `POST api/email-messages/send`. It used to be excluded on the
grounds that a service with no MCP package cannot cover anything, which had it
backwards. That verb is the platform's paced bulk-send: orchestration plans it and
calls it once per item while no agent can describe, inspect or invoke it, which is
precisely the failure this file exists to name. Leaving the service out did not
make the debt smaller, it made it unwritten. The entry clears when the email
package ships a `send` tool with `stepEligible: true`.

Its sibling entry in `mass-action-allowlist.json` is an empty array, and that is a
different statement: `gtm.service.email` declares no `mass_action` route at all, so
there is nothing to waive on that flag. Empty because the backend says so, not
because we are covered.

### The bulk-flag declaration gate (no allow-list, by design)

The fifth gate in `tests/contract-parity.test.ts`, and the only one there that
touches no tool registry: it reads `declared_arguments` on every ACTION route of
all four dumps (email included) and fails any route that did not write
`massAction:` at its call site. Both flag-parity gates above compare RESOLVED
booleans, so they agree perfectly on a verb nobody ever classified - the exact
hole that hid five orchestration routes, one of which (`mass-action-items.retry`)
turned out to be a real `filter`-mode fan-out reported as single-target. It also
fails when `declared_arguments` is absent, so a fixture cut by an older oracle
cannot make the check vacuous.

There is no allow-list. An omission is never a waivable state of the world: the
answer is in the verb's own FormRequest, in front of whoever writes the
attribute. The stricter, earlier copy of this check lives in the backend, one
`tests/Unit/Architecture/BulkFlagDeclarationTest` per service over
`Core\Testing\BulkFlagDeclarationScan`, which reflects the LIVE router and so
fails in the offending repository before any fixture is regenerated. This gate is
the cross-repo backstop for the committed dumps.

## The four request-parity gates

Gates 6 to 9 in `tests/contract-parity.test.ts`, added 2026-07-27, the first
ones in this repo that read what goes IN rather than what comes back. They read
the per-route `rules` block (above), so they only became possible when the oracle
started dumping it: before that the request body had no oracle at all and no
gate, which is how three GA tools shipped 422-ing on every possible call.

Per tool, resolved to the route it points at:

- **required-field parity.** Every field the backend marks `required` has a slot
  in the tool's `inputSchema`. This is the sharpest class in the file: `z.object`
  strips unknown keys before dispatch, so a required field with no slot cannot be
  supplied by any agent under any prompt, and the tool 422s on every call for the
  whole life of the deployment while the error names a field the agent was never
  offered. `get_billing_transactions_metrics` was exactly that (its route requires
  `period` + `period.from` + `period.to`) and is fixed.
- **unknown-key parity.** No `inputSchema` key sits outside the rule set, reported
  at the SHALLOWEST undeclared path (naming `filter.updated_at` says everything
  its `.gte` / `.lte` operator keys would). Remaining drift is in
  `request-parity-baseline.json`, below.
- **bound parity.** No STATED Zod bound is wider than the stated backend bound.
  The page-size ceiling is per entity, not global (`McpFormRequest::pageSize()`
  clamps at 500 but the owning `{Entity}SearchRequest` validates, and caps at 100,
  200, 500 or 1000), so `McpSearchRequestSchema` takes `maxPageSize` per tool: 23
  search tools advertised 0..500 against a `max:200` route. A bound the schema
  simply omits is the weaker case (the backend answers a recoverable 422 naming
  the field) and prints as a WARNING.
- **enum parity.** A field the backend closes with `in:` is a `z.enum` with the
  same values. `in:` is the one rule an agent cannot recover from by reading the
  error, because a 422 says the value is invalid and never which values are valid.
  A value the tool offers and the backend rejects FAILS; a value the backend
  allows and the tool omits is a coverage WARNING.

Routes whose `rules` are `null` are printed as skips with `rules_reason`, never
silent passes, and `rules: []` (a FormRequest that constrains nothing) is printed
as its own kind of skip. Keys the runtime consumes before the request is built
are excluded on the Zod side, because the backend never sees them: `_meta`, the
`{sid}` / `pathParams` bindings, and `commit_token` on dangerous tools.

Rule keys are matched segment by segment with `*` matching any one segment, so
`sync_config.entries.*.interval_minutes` covers the seven tracks the schema names
individually instead of calling all seven undeclared.

### The request-parity baseline (`request-parity-baseline.json`)

Read by the unknown-key gate only. The other three request gates carry NO
baseline, by design: their drift was driven to zero the day they landed, and
every class they catch is a tool-side fix. Same shrink discipline as the ledger
and the two allow-lists: one line per key, each with the reason it is not fixed,
and an entry that stopped drifting FAILS the gate and prints the line to delete.

It holds 118 keys in three shapes, and the shape matters because only one of them
is a tool bug:

1. **89 metrics filter axes.** The 8 `*_metrics` tools reuse their entity's search
   filter, while each `{Entity}MetricsRequest` declares a much narrower set and
   the metrics service reads hand-picked keys off `input('filter')`. Those axes
   are silently ignored, which is a wrong answer rather than a 422. Narrowing the
   tools needs the backend to agree with itself first:
   `LinkedinAccountActivityLogMetricsRequest` declares only
   `filter.linkedin_account_sid` while its own service also reads `filter.status`.
2. **14 account-share filter operators + 11 scattered filter/include keys.** The
   FormRequest under-declares what the controller then applies through
   `input()`, so the key works and nothing validates it.
3. **4 `linkedin_tracked_post_sid` inputs.** The research file documents
   `linkedin_tracked_post_sid` XOR `post`; the backend implements only `post`
   since the tracked-post entity moved to `gs.service.signals`. Mirroring the
   backend here would delete a documented capability, so it is recorded instead.

Nine more `include` params were FIXED rather than recorded, with
`.omit({ include: true })`: on those the tool named no relation at all, the
SearchRequest declares no `include` rule and the controller builds no `included`
block, so the param was a silent no-op. Three of this class stayed in the
baseline because the tool names real relations the backend has not built.

## The enum-parity gate (`tests/enum-parity.test.ts`)

The gate that reads the top-level `enums` map. It exists because nothing else
could: the registry declares 193 literal `z.enum([...])` value lists that are
each a promise to an agent about what the backend accepts, and the only enum
payload the oracle carried before that map was a per-entity block resolved by
naming convention, empty for 49 of 63 entities and never carrying a status /
kind / action-type enum at all (now deleted, see the Shape notes above). It asserts the same value SET on both sides, order-insensitive:
a value we offer and PHP rejects is a 422 the agent was invited to make, and a
PHP case we omit is a state the agent can neither express nor parse.

An enum has no class name attached anywhere in the TypeScript, so the file's real
work is the RESOLUTION BRIDGE, in this order: the route's `rules[].in` matched
POSITIONALLY by path (`filter.status.eq`, `sort.field`, `include.*`) which needs
no name at all; then a small `MANUAL_BRIDGE` table, one commented line per enum
whose own name reaches nothing or reaches the wrong class; then the FQCN's last
segment, matched against candidates built from entity + parent + field, most
specific first, with a name answering to two classes counted as ambiguous rather
than guessed. Whatever none of the three resolves is UNMAPPED and printed by
name; a third gate keeps every `MANUAL_BRIDGE` line load-bearing, so a typo in
the table fails instead of quietly unpinning the enum it was written for.

The request direction of the same question - a field the backend restricts with
`Rule::in` must be a closed `z.enum` with those values - belongs to the
request-parity gates in `tests/contract-parity.test.ts`, which own required
fields, unknown keys, numeric bounds and `in:` lists off the same `rules()` dump.
This gate deliberately does not repeat it. What it owns instead is everything no
request rule can describe: the RESPONSE projections, the shared value objects,
and every enum on a field the backend constrains with no rule at all. That is
where all of the drift found on 2026-07-27 actually lived - an invented
`mcp_agent` actor type that `AccessIdentityValue::validate()` rejects, an 11-case
browser status against a 13-case PHP enum, a 15-case smart-limit type against 16,
and `LinkedinAccountStatusEnum` missing from the account item entirely under a
comment asserting the account carried no status enum.

### The unmapped ceiling (`enum-parity-baseline.json`)

Per service, the maximum number of DISTINCT unmapped enum sites. Distinct sites
rather than occurrences: one shared value object reached from 99 tools is one
unpinned promise and one edit. It may only decrease; the gate prints the new
number the moment it falls and fails when it rises. Two structural classes
dominate what is in it and neither is fixable from this repo:
`Core\Values\CreditsSpentValue` constrains `reason` / `executed_on` with
`Rule::in` over class CONSTANTS rather than an enum, so no enum dump can carry
them; and most search FormRequests outside `gtm.service.id` constrain neither
`sort.field` nor `include.*`, which makes our Zod enum stricter than the backend
rather than drifted from it. The file's `_comment` lists the rest by class.
