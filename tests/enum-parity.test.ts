import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { ToolDefinition, ToolPackage } from '@gtm/mcp-runtime/types';
import { linkedinPackages } from '@gtm/mcp-linkedin';
import { idPackages } from '@gtm/mcp-id';
import { orchestrationPackages } from '@gtm/mcp-orchestration';

// ENUM PARITY. A sibling file to contract-parity.test.ts rather than a sixth
// gate inside it, for one reason: every gate over there resolves a tool to a
// route or to a Domain and then compares two flat lists. An enum has neither.
// A `z.enum([...])` is an anonymous array of strings with no PHP class name
// attached anywhere in the registry, so most of this file is the RESOLUTION
// BRIDGE that earns the right to compare at all, and folding it into a file
// that already carries five gates would bury both. The oracle fixtures, the
// service list and the Zod-walking helpers are the same shape on both sides;
// the small helpers are restated here so neither file has to import the other.
//
// Why it exists: the registry declares 193 literal z.enum([...]) value lists,
// every one of them a promise to an agent about what the backend will accept,
// and until the oracle grew a top-level FQCN `enums` map there was nothing to
// compare them to. The only enum payload before it was a per-entity block
// resolved by naming convention ({Entity}{Sortable|Filterable|GroupBy}FieldEnum),
// empty for 49 of 63 entities and never carrying a status / kind / action-type
// enum at all; it is deleted now that this map answers the question. Nothing
// compared the two sides, and the drift was what an unpinned contract predicts:
// an actor type (`mcp_agent`) that AccessIdentityValue::validate() rejects
// outright, a browser status two cases short, an account status enum missing
// entirely, and an 89-value webhook event vocabulary modelled as z.string().
//
// ─── The resolution bridge ──────────────────────────────────────────────
// A Zod enum carries no class name, so it has to be resolved before it can be
// compared. Three sources, tried in this order:
//
//  A. Rule::in, POSITIONAL and exact. The oracle now carries every action's
//     FormRequest rules(), one entry per rule key, with `in` already resolved to
//     literal values even where the PHP wrote Rule::in(SomeEnum::values()). A
//     rule key is a path ('filter.status.eq', 'sort.field', 'include.*',
//     'plan.steps.*.tool') and so is the path of a Zod node inside the tool's
//     inputSchema. Same tool's route, same path, nothing inferred. Strongest
//     match available, so it is tried first and it needs no name at all.
//
//  B. MANUAL_BRIDGE, below. One entry per enum whose own name reaches nothing
//     (or reaches the WRONG class), each with the reason. It is checked before
//     the name convention precisely because "resolves to something plausible"
//     is the dangerous failure mode here: `mass_action_items.step_log.*.status`
//     name-matches MassActionItemStatusEnum and is really the 5-case
//     MassActionItemStepStatusEnum.
//
//  C. FQCN name match against the oracle's top-level `enums` map, which is
//     convention-free: every real PHP enum under the service folder and under
//     Core/, keyed by FQCN. Candidates are built from the owning entity, the
//     parent path segment and the field, most specific first
//     ({Entity}{Parent}{Field}Enum -> {Entity}{Field}Enum -> {Field}Enum ...),
//     each compared against the FQCN's last segment case- and
//     separator-insensitively. A candidate that answers to TWO classes is an
//     ambiguity, not a match, and the site is left unmapped rather than guessed.
//
// Everything none of the three resolves is UNMAPPED, printed with its values
// and an owning tool, and counted against a shrink-only ceiling. An honest
// unmapped number is the point of this gate: a resolver that quietly dropped
// what it could not match would report a green suite over the same unpinned
// value lists we started with. Two structural sources dominate what is left and
// neither is fixable from this repo: Core\Values\CreditsSpentValue validates
// `reason` / `executed_on` with Rule::in over CLASS CONSTANTS rather than an
// enum (so no enum dump can ever carry them), and most search requests outside
// gtm.service.id constrain neither sort.field nor include.* at all, which means
// our Zod enum is stricter than the backend rather than drifting from it.
//
// ─── The gates ──────────────────────────────────────────────────────────
//  1. VALUE-SET PARITY, both directions, order-insensitive. A Zod value the PHP
//     enum does not carry is a 422 the agent cannot recover from: it was told to
//     send a token the backend rejects. A PHP case the Zod enum omits is the
//     opposite failure and just as real: a state the agent cannot express or
//     parse, failing silently rather than loudly, which is why this direction is
//     asserted and not warned. Both are compared as SETS; order is presentation.
//  2. UNMAPPED SHRINK-ONLY. Distinct unmapped enum sites per service may not
//     exceed the ceiling in enum-parity-baseline.json. Falling is free and
//     prints the new number; rising fails. Without it, gate 1 could be defeated
//     by renaming a field until nothing resolves.
//  3. MANUAL-BRIDGE HYGIENE. Every MANUAL_BRIDGE entry resolves at least one
//     site. A line that pins nothing is a comment claiming a guarantee it does
//     not give, and it hides the enum it was written for among the unmapped.
//
// NOT here, deliberately: "a request field the backend restricts with Rule::in
// must be a closed z.enum". That is the REQUEST direction, and the request-parity
// gates in contract-parity.test.ts own it end to end (they also own required
// fields, unknown keys and numeric bounds off the same rules() dump). This file
// owns what no request rule can describe: the RESPONSE projections, the shared
// value objects, and every enum on a field the backend constrains with no rule
// at all - which is where all of this run's drift actually lived.

type OracleRule = { field: string; rules: string[]; in: string[] | null };
type OracleRoute = {
  method: string;
  uri: string;
  operation: string | null;
  internal: boolean;
  rules: OracleRule[] | null;
  rules_reason: string | null;
};
type OracleEnum = { backing: string | null; cases: { name: string; value: string }[] };
type OracleEntity = { domain: { class: string; fields: { name: string }[] } };
type Oracle = {
  service: string;
  entities: Record<string, OracleEntity>;
  enums: Record<string, OracleEnum>;
  routes: OracleRoute[];
};

type Baseline = {
  /** Per service: the maximum number of DISTINCT unmapped Zod enum sites (gate 2). */
  unmapped_ceiling: Record<string, number>;
};

const BASELINE_FILE = 'fixtures/contract-oracle/enum-parity-baseline.json';

const readJson = (path: string) =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

const load = (file: string): Oracle => readJson(`../fixtures/contract-oracle/${file}`);
const baseline: Baseline = readJson(`../${BASELINE_FILE}`);

// Same service list and same reasoning as contract-parity.test.ts: a service
// with no MCP package is carried with an empty package set rather than left out,
// so "no tools at all" reads as no Zod side to check rather than as nothing to
// check. gtm.service.email is that case today.
const SERVICES: { name: string; packages: ToolPackage[]; oracle: Oracle }[] = [
  { name: 'linkedin', packages: linkedinPackages, oracle: load('linkedin.contract.json') },
  { name: 'id', packages: idPackages, oracle: load('id.contract.json') },
  { name: 'orchestration', packages: orchestrationPackages, oracle: load('orchestration.contract.json') },
  { name: 'email', packages: [], oracle: load('email.contract.json') },
];

// ─── source B: the manual bridge ────────────────────────────────────────
// `entity` is the MCP package entity ('*' for a shared value object reused
// everywhere). `at` matches EITHER the envelope-stripped path or the bare field
// name. `enumClass` is the FQCN's last segment. Every entry states why the name
// convention cannot reach it, because an unexplained entry here is
// indistinguishable from a wrong one.
type BridgeEntry = { service: string; entity: string; at: string; enumClass: string };

const MANUAL_BRIDGE: BridgeEntry[] = [
  // AccessIdentityValue is shared by every entity in every service, and its PHP
  // enum drops the field's `_type` suffix (ActorType, not ActorTypeEnum).
  { service: '*', entity: '*', at: 'actor_type', enumClass: 'ActorType' },
  // The sharing rework put share_role on the CHANNEL entities as well, and the
  // enum that backs it is named after the handover, not after either entity.
  { service: '*', entity: '*', at: 'share_role', enumClass: 'HandoverRoleEnum' },

  // ── linkedin ──
  // Messages carry the messenger axis but the enum is owned by the conversation
  // folder: one thread is LinkedIn or Sales Navigator, and every message in it
  // inherits that.
  { service: 'linkedin', entity: 'linkedin_messages', at: 'messenger_type', enumClass: 'LinkedinConversationMessengerTypeEnum' },
  // The results entity is LinkedinAutoScrapeResult, so {Entity}{Field} would be
  // LinkedinAutoScrapeResultResultKindEnum; the class drops the doubled word.
  { service: 'linkedin', entity: 'linkedin_auto_scrape_results', at: 'result_kind', enumClass: 'LinkedinAutoScrapeResultKindEnum' },
  // Field is browser_owner, class is AntidetectBrowserOwnerEnum: the entity name
  // already ends in the word the field repeats.
  { service: 'linkedin', entity: 'antidetect_browsers', at: 'browser_owner', enumClass: 'AntidetectBrowserOwnerEnum' },
  // limit_type on a LinkedinAccountSmartLimit row is the entity's own identity
  // axis, and its class is {Entity}TypeEnum with the `limit` word not repeated.
  // (Mirror-identical by contract with the automation-side LinkedinLimitTypeEnum,
  // which the finalize counter bridges to by backing value.)
  { service: 'linkedin', entity: 'linkedin_account_smart_limits', at: 'limit_type', enumClass: 'LinkedinAccountSmartLimitTypeEnum' },
  // The warmup breakdown rows are a value object inside the snapshot; the class
  // names the subject (Warmup) rather than the JSON key (warmup_breakdown).
  { service: 'linkedin', entity: 'linkedin_account_snapshots', at: 'warmup_breakdown.*.driver', enumClass: 'LinkedinAccountSnapshotWarmupDriverEnum' },
  // linkedin_scraping is a VERB package with no Domain of its own, so there is
  // no entity name to build a candidate from; both enums live with the subject
  // they describe.
  { service: 'linkedin', entity: 'linkedin_scraping', at: 'facet', enumClass: 'LinkedinScrapingLookupFacetEnum' },
  { service: 'linkedin', entity: 'linkedin_scraping', at: 'reaction_type', enumClass: 'LinkedinPostingReactionTypeEnum' },
  // run-now MINTS A RUN and reports it, so the status in its result block is the
  // run's 4-case vocabulary, not the scrape's 2-case active/paused. Pinned by
  // the FULL path so the scrape's own item.status keeps its own enum.
  { service: 'linkedin', entity: 'linkedin_auto_scrapes', at: 'result.status', enumClass: 'LinkedinAutoScrapeRunStatusEnum' },

  // ── id ──
  // A share row's channel is the platform-wide account channel (Core), not a
  // per-entity one.
  { service: 'id', entity: 'account_shares', at: 'channel', enumClass: 'AccountChannelEnum' },
  // A transaction inherits its subscription's collection mode; the enum is owned
  // by the subscription.
  { service: 'id', entity: 'billing_transactions', at: 'collection_mode', enumClass: 'BillingSubscriptionCollectionModeEnum' },
  // Line items on a transaction are products, and the class names the product.
  { service: 'id', entity: 'billing_transactions', at: 'items.*.product_type', enumClass: 'BillingProductTypeEnum' },
  // The credit vocabulary is CreditKindEnum on every credit surface (the ledger
  // row, the balance block and the purchase result alike); the entity name
  // credit_transactions does not reach it.
  { service: 'id', entity: 'credit_transactions', at: 'kind', enumClass: 'CreditKindEnum' },
  // The observability tree is spans, not requests: a SPAN status has a third
  // case (unset) the request status does not, and name resolution would silently
  // pick ObservabilityRequestStatusEnum for both.
  { service: 'id', entity: 'observability_requests', at: 'span_tree.status', enumClass: 'ObservabilitySpanStatusEnum' },
  { service: 'id', entity: 'observability_requests', at: 'span_tree.children.*.status', enumClass: 'ObservabilitySpanStatusEnum' },
  { service: 'id', entity: 'observability_requests', at: 'span_tree.kind', enumClass: 'ObservabilitySpanKindEnum' },
  { service: 'id', entity: 'observability_requests', at: 'span_tree.children.*.kind', enumClass: 'ObservabilitySpanKindEnum' },
  // Both classes name the subject of the sub-record rather than its JSON key.
  { service: 'id', entity: 'observability_requests', at: 'db_queries.*.operation', enumClass: 'ObservabilityDbOperationEnum' },
  { service: 'id', entity: 'observability_requests', at: 'permission_decisions.*.decision', enumClass: 'ObservabilityPermissionDecisionEnum' },

  // ── orchestration ──
  // A step_log row is a STEP outcome, a strict 5-case subset vocabulary of the
  // item's own 7-case status. The names collide, so this must be pinned by path.
  { service: 'orchestration', entity: 'mass_action_items', at: 'step_log.*.status', enumClass: 'MassActionItemStepStatusEnum' },
  // retry reports the status the log row held before the retry; same vocabulary
  // as `status`, which the field name alone cannot say.
  { service: 'orchestration', entity: 'webhook_logs', at: 'previous_status', enumClass: 'WebhookLogStatusEnum' },
];

// Alternative class-name prefixes for one oracle entity, tried after the entity
// name itself. Each line is a folder whose enums drop or shorten the entity
// name, which the {Entity}{Field} convention cannot see.
const CLASS_PREFIX_ALIAS: Record<string, string[]> = {
  // The sync-run enums drop the `Account` infix: LinkedinSyncRunStatusEnum, not
  // LinkedinAccountSyncRunStatusEnum.
  'linkedin|LinkedinAccountSyncRun': ['LinkedinSyncRun'],
  // disconnect_cause is the browser's cause, recorded on the session row.
  'linkedin|CloudBrowserSession': ['CloudBrowser'],
  // The OAuth vocabulary (grant type, registration kind, team scope mode) is
  // shared by both OAuth entities and prefixed with the protocol, not the entity.
  'id|OauthClient': ['Oauth'],
  'id|OauthAuthorization': ['Oauth'],
  // The Observability folder prefixes its enums with the folder, not the Domain.
  'id|ObservabilityRequest': ['Observability'],
};

// ─── Zod introspection ──────────────────────────────────────────────────
/* eslint-disable @typescript-eslint/no-explicit-any */

/** Peels the wrappers that do not change a node's path. */
const unwrap = (schema: unknown): any => {
  let current: any = schema;
  for (let hops = 0; hops < 20 && current?._def; hops++) {
    switch (current._def.typeName) {
      case 'ZodOptional':
      case 'ZodNullable':
      case 'ZodDefault':
      case 'ZodReadonly':
      case 'ZodCatch':
      case 'ZodBranded':
        current = current._def.innerType;
        break;
      case 'ZodEffects':
        current = current._def.schema;
        break;
      case 'ZodLazy':
        current = current._def.getter();
        break;
      case 'ZodPipeline':
        current = current._def.out;
        break;
      default:
        return current;
    }
  }
  return current;
};

type EnumSite = { path: string; values: string[] };

/**
 * Every ZodEnum / ZodNativeEnum reachable from a schema, with the dotted path
 * that reaches it. Arrays and records contribute a `*` segment, which is exactly
 * how Laravel spells the same position ('include.*', 'plan.steps.*.tool').
 * Unions contribute no segment: every arm sits at the same path.
 */
const enumSites = (schema: unknown): EnumSite[] => {
  const found = new Map<string, EnumSite>();

  const walk = (node: unknown, path: string, depth: number) => {
    // A self-recursive schema (the observability span tree is one) is reached
    // through a ZodLazy whose getter hands back a fresh object every call, so
    // identity cannot terminate the walk. The depth cap does, and the collapsed
    // path below folds the repeated levels into one site.
    if (depth > 24) return;
    const inner = unwrap(node);
    if (!inner?._def) return;

    switch (inner._def.typeName) {
      case 'ZodEnum': {
        const site = { path: collapse(path), values: [...(inner._def.values as string[])] };
        found.set(`${site.path}|${site.values.join(',')}`, site);
        return;
      }
      case 'ZodNativeEnum': {
        const site = {
          path: collapse(path),
          values: Object.values(inner._def.values as Record<string, string>),
        };
        found.set(`${site.path}|${site.values.join(',')}`, site);
        return;
      }
      case 'ZodObject':
        for (const [key, child] of Object.entries(inner.shape as Record<string, unknown>)) {
          walk(child, path ? `${path}.${key}` : key, depth + 1);
        }
        return;
      case 'ZodArray':
        walk(inner._def.type, path ? `${path}.*` : '*', depth + 1);
        return;
      case 'ZodRecord':
        walk(inner._def.valueType, path ? `${path}.*` : '*', depth + 1);
        return;
      case 'ZodTuple':
        for (const child of inner._def.items as unknown[]) walk(child, path ? `${path}.*` : '*', depth + 1);
        return;
      case 'ZodUnion':
      case 'ZodDiscriminatedUnion':
        for (const child of optionsOf(inner)) walk(child, path, depth + 1);
        return;
      case 'ZodIntersection':
        walk(inner._def.left, path, depth + 1);
        walk(inner._def.right, path, depth + 1);
        return;
      default:
        return;
    }
  };

  walk(schema, '', 0);
  return [...found.values()];
};

const optionsOf = (node: any): unknown[] => {
  const options = node._def.options;
  return (Array.isArray(options) ? options : [...options.values()]) as unknown[];
};

/* eslint-enable @typescript-eslint/no-explicit-any */

// ─── name helpers ───────────────────────────────────────────────────────

const flatten = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
const singularize = (value: string) =>
  value.endsWith('ies') ? `${value.slice(0, -3)}y`
    : value.endsWith('sses') ? value.slice(0, -2)
      : value.endsWith('s') && !value.endsWith('ss') ? value.slice(0, -1)
        : value;

/** 'Gtm\Lib\...\LinkedinAccountStatusEnum' -> 'LinkedinAccountStatusEnum'. */
const basename = (fqcn: string) => fqcn.split('\\').slice(-1)[0] ?? fqcn;

/** 'actor_type' -> 'ActorType'. */
const studly = (value: string) =>
  value.split(/[^A-Za-z0-9]+/).filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1)).join('');

/** 'a.children.*.children.*.kind' -> 'a.children.*.kind' (self-recursive schemas). */
const collapse = (path: string) => {
  let out = path;
  for (let pass = 0; pass < 24; pass++) {
    const next = out.replace(/(\.[^.]+\.\*)\1+/g, '$1');
    if (next === out) return out;
    out = next;
  }
  return out;
};

/** Envelope scaffolding, dropped so a path names the DATA and nothing else. */
const stripEnvelope = (path: string) =>
  path.replace(/^items\.\*\.item\./, '').replace(/^item\./, '').replace(/^result\./, '');

const FILTER_OPS = new Set(['eq', 'ne', 'in', 'nin', 'gte', 'lte', 'gt', 'lt', 'is_null']);

/** ['filter','status'] for 'filter.status.eq'; wildcards and operators dropped. */
const meaningfulSegments = (path: string): string[] => {
  const segments = path.split('.').filter((segment) => segment !== '*' && segment !== '');
  while (segments.length > 1 && FILTER_OPS.has(segments[segments.length - 1])) segments.pop();
  return segments;
};

const sameSet = (left: string[], right: string[]) => {
  const a = new Set(left);
  const b = new Set(right);
  return a.size === b.size && [...a].every((value) => b.has(value));
};

const unique = (values: string[]) => [...new Set(values.filter(Boolean))];

const routeKey = (tool: ToolDefinition) =>
  `${tool.route.method} ${tool.route.pathTemplate.replace(/^\//, '')}`;

// ─── the gates ──────────────────────────────────────────────────────────

type Resolved = {
  tool: string;
  direction: 'input' | 'output';
  path: string;
  values: string[];
  source: 'rules' | 'manual' | 'fqcn';
  via: string;
  phpValues: string[];
};
type Unmapped = { tool: string; direction: 'input' | 'output'; path: string; values: string[] };

// Same shrink discipline the allow-lists next door apply to waivers, applied to
// the bridge: an entry that resolves nothing is either a typo (so the enum it
// was meant to pin is silently unmapped) or a leftover from a field that has
// since been renamed. Either way it is a comment claiming a guarantee it does
// not provide, so it fails the suite. Asserted once, after every service's
// describe body has run its resolution.
const bridgeUsed = new Set<BridgeEntry>();

for (const service of SERVICES) {
  describe(`enum parity gate: ${service.name}`, () => {
    const tools = service.packages.flatMap((toolPackage) => toolPackage.tools);

    // FQCN index, keyed by the flattened last segment. Two classes answering to
    // one name make that name unusable as a bridge, so the collision is recorded
    // and the site left unmapped rather than resolved to whichever came first.
    const byName = new Map<string, string[]>();
    for (const fqcn of Object.keys(service.oracle.enums)) {
      const key = flatten(basename(fqcn));
      byName.set(key, [...(byName.get(key) ?? []), fqcn]);
    }

    const bridge = MANUAL_BRIDGE.filter(
      (entry) => entry.service === service.name || entry.service === '*',
    );

    /** Oracle entity key ('LinkedinAccount') for a tool's snake-plural entity. */
    const entityKeyOf = (entity: string): string | null => {
      const flat = flatten(entity);
      const singular = flatten(singularize(entity));
      for (const key of Object.keys(service.oracle.entities)) {
        if (flatten(key) === flat || flatten(key) === singular) return key;
      }
      return null;
    };

    const rulesByRoute = new Map<string, Map<string, string[]>>();
    for (const route of service.oracle.routes) {
      const constrained = new Map<string, string[]>();
      for (const rule of route.rules ?? []) if (rule.in) constrained.set(rule.field, rule.in);
      rulesByRoute.set(`${route.method} ${route.uri}`, constrained);
    }

    const resolved: Resolved[] = [];
    const unmapped: Unmapped[] = [];
    let ambiguous = 0;

    for (const tool of tools) {
      const entityKey = entityKeyOf(tool.entity);
      const constrained = rulesByRoute.get(routeKey(tool)) ?? new Map<string, string[]>();

      const collect = (schema: unknown, direction: 'input' | 'output') => {
        for (const site of enumSites(schema)) {
          // Names come off the ENVELOPE-STRIPPED path. Reading the parent off
          // the raw one makes `item` a name part, and MassAction's own
          // `item.status` then resolves to MassActionItemStatusEnum: a real
          // class, the wrong contract, and a failure that looks like drift.
          const stripped = stripEnvelope(site.path);
          const segments = meaningfulSegments(stripped);
          const field = segments[segments.length - 1] ?? '';
          const parent = segments[segments.length - 2] ?? '';

          const record = (source: Resolved['source'], via: string, phpValues: string[]) =>
            resolved.push({ tool: tool.name, direction, path: site.path, values: site.values, source, via, phpValues });

          // A. Rule::in, positional. Input only: rules() describes what goes IN.
          const positional = direction === 'input' ? constrained.get(site.path) : undefined;
          if (positional) {
            record('rules', `${routeKey(tool)} rules['${site.path}']`, positional);
            continue;
          }

          // B. Manual bridge, by full path, envelope-stripped path or bare field.
          const manual = bridge.find(
            (entry) => (entry.entity === tool.entity || entry.entity === '*')
              && (entry.at === site.path || entry.at === stripped || entry.at === field),
          );
          if (manual) bridgeUsed.add(manual);

          // C. FQCN name match, most specific candidate first.
          const prefixes = entityKey
            ? [entityKey, ...(CLASS_PREFIX_ALIAS[`${service.name}|${entityKey}`] ?? []), '']
            : [''];
          // The empty parent is appended, never unique()d in: it is the
          // {Entity}{Field} spelling most classes actually use, and it has to
          // survive as the LAST candidate after the parent-qualified ones.
          const fields = unique([studly(field), studly(singularize(field))]);
          const parents = [...(parent ? unique([studly(parent), studly(singularize(parent))]) : []), ''];

          const candidates = manual ? [manual.enumClass] : prefixes.flatMap((prefix) =>
            parents.flatMap((parentPart) =>
              fields.flatMap((fieldPart) => [
                `${prefix}${parentPart}${fieldPart}Enum`,
                `${prefix}${parentPart}${fieldPart}`,
              ])));

          let hit: string | null = null;
          for (const candidate of candidates) {
            const classes = byName.get(flatten(candidate)) ?? [];
            if (classes.length === 1) { hit = classes[0]; break; }
            if (classes.length > 1) ambiguous++;
          }

          if (!hit) {
            unmapped.push({ tool: tool.name, direction, path: site.path, values: site.values });
            continue;
          }

          record(
            manual ? 'manual' : 'fqcn',
            basename(hit),
            service.oracle.enums[hit].cases.map((enumCase) => enumCase.value),
          );
        }
      };

      collect(tool.inputSchema, 'input');
      collect(tool.outputSchema, 'output');
    }

    it('value-set parity: every resolved Zod enum equals its PHP enum, both directions', () => {
      const violations: string[] = [];

      for (const site of resolved) {
        if (sameSet(site.values, site.phpValues)) continue;

        const invented = site.values.filter((value) => !site.phpValues.includes(value));
        const missing = site.phpValues.filter((value) => !site.values.includes(value));
        violations.push(`${site.tool} ${site.direction}.${site.path} vs ${site.via}: ${[
          invented.length ? `invents ${invented.join(', ')} (the backend rejects it: 422)` : null,
          missing.length ? `omits ${missing.join(', ')} (a state the agent cannot express or parse)` : null,
        ].filter(Boolean).join('; ')}`);
      }

      /* eslint-disable-next-line no-console */
      console.log(`${service.name} enum value-set parity: ${resolved.length} site(s) resolved (${resolved.filter((site) => site.source === 'rules').length} by Rule::in, ${resolved.filter((site) => site.source === 'manual').length} by the manual bridge, ${resolved.filter((site) => site.source === 'fqcn').length} by FQCN name), ${unmapped.length} unmapped, ${ambiguous} candidate name(s) rejected as ambiguous.`);
      expect(violations.sort()).toEqual([]);
    });


    it('unmapped enums: the count is at or below the committed ceiling', () => {
      const ceiling = baseline.unmapped_ceiling[service.name];
      expect(
        ceiling,
        `${BASELINE_FILE} has no unmapped_ceiling for '${service.name}', so nothing bounds its unmapped enums`,
      ).toBeTypeOf('number');

      // Distinct sites, not occurrences: one shared value object reached from 99
      // tools is ONE unpinned promise and one edit, and counting it 99 times
      // would make the ceiling a popularity contest instead of a work queue.
      const distinct = new Map<string, string[]>();
      for (const entry of unmapped) {
        const key = `${entry.direction}.${entry.path} = [${entry.values.join(', ')}]`;
        distinct.set(key, [...(distinct.get(key) ?? []), entry.tool]);
      }

      /* eslint-disable no-console */
      if (distinct.size) {
        console.log(`${service.name} UNMAPPED enum sites (${distinct.size}/${ceiling}); no PHP enum resolves by rule key, manual bridge or class name:`);
        for (const [site, owners] of [...distinct].sort()) {
          console.log(`  ${site}  (${owners.length}x, e.g. ${owners[0]})`);
        }
      }
      if (distinct.size < ceiling) {
        console.log(`${service.name} unmapped enums fell to ${distinct.size} (ceiling ${ceiling}): lower unmapped_ceiling in ${BASELINE_FILE}.`);
      }
      /* eslint-enable no-console */

      expect(
        distinct.size,
        `${service.name} has ${distinct.size} distinct unmapped enum site(s), above the ${ceiling} in ${BASELINE_FILE}. Bridge them (a name the convention reaches, or a MANUAL_BRIDGE entry with a reason); never raise the ceiling.`,
      ).toBeLessThanOrEqual(ceiling);
    });
  });
}

describe('manual bridge hygiene', () => {
  it('every MANUAL_BRIDGE entry resolves at least one enum site', () => {
    const dead = MANUAL_BRIDGE
      .filter((entry) => !bridgeUsed.has(entry))
      .map((entry) => `${entry.service}|${entry.entity}|${entry.at} -> ${entry.enumClass}: nothing in the registry reaches it, so it pins nothing (delete the line, or fix the entity / path it names)`);

    /* eslint-disable-next-line no-console */
    console.log(`manual bridge: ${bridgeUsed.size}/${MANUAL_BRIDGE.length} entries in use.`);
    expect(dead.sort()).toEqual([]);
  });
});
