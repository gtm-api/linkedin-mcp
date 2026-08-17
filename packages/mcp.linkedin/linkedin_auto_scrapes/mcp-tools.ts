// Entity: LinkedIn Auto-scrape (gtm.service.linkedin)
// Source of truth: product/research/gtm.service.linkedin/entities/linkedin_auto_scrapes.md
// Format: registry v2, where each tool carries route metadata so the generic
// dispatcher can drive it. 10 tools = the 10 public api/linkedin-auto-scrapes
// routes, verified against fixtures/contract-oracle/linkedin.contract.json.
// Mounted on linkedin.auto-scrapes with its runs + results children.
//
// An auto-scrape is the COLLECTOR half of the platform's bulk loop: a saved,
// optionally recurring job that paginates one LinkedIn or Sales Navigator list
// surface, dedups what it finds by identity across runs, and appends every
// never-seen-before lead into a standing mass-action as one item. The other half
// (the plan that acts on those leads) lives in gtm.service.orchestration and is
// reached through preview_mass_action / create_mass_action on the
// /mcp/orchestration/mass-actions mount. set_linkedin_auto_scrape_mass_action is
// the wire between the two.
//
// include[] carries the two relations the controller actually joins:
// linkedin_account (the executor) and last_run (the newest run of the job, which
// is where a run in flight becomes visible; the parent's next_run_at is null for
// a one-shot too). mass_action and recent_runs are still NOT advertised: the
// mass-action lives in another service and would cost an HTTP hop per page, and
// recent_runs is search_linkedin_auto_scrape_runs. Chain by sid for those.
//
// One thing this file deliberately does NOT advertise: a metrics tool. There is
// no metrics route on this group at all.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  AccessIdentityValue,
  filterOp,
  usageMetaField,
  McpActionResponse,
  McpCreateResponse,
  McpGetRequestSchema,
  McpGetResponse,
  McpSearchRequestSchema,
  McpSearchResponse,
  McpSimpleDeleteRequestSchema,
  McpSimpleDeleteResponse,
  McpUpdateResponse,
} from '@gtm/mcp-shared';

const SID = z.string().length(18).startsWith('ln_as_')
  .describe('Auto-scrape sid (ln_as_...).');
const ACCOUNT_SID = z.string().length(18).startsWith('ln_ac_')
  .describe('Executor LinkedIn account sid (ln_ac_...): whose browser paginates the source.');
const MASS_ACTION_SID = z.string().length(18).startsWith('ma_ac_')
  .describe('Mass-action sid (ma_ac_...) authored beforehand with preview_mass_action then create_mass_action.');

// The auto-scrape-eligible subset of the scraping surface: the paginated verbs
// that return a list of people or companies. LinkedinAutoScrapeSourceMethodEnum
// in gtm.lib.common. result_kind and detected_platform are DERIVED from this
// value at create and frozen on the row.
const SourceMethod = z.enum([
  // People-returning (result_kind = person)
  'search-people-by-url',
  'search-people-by-params',
  'search-sales-nav-people-by-url',
  'search-sales-nav-people-by-params',
  'similar-profiles',
  'company-employees',
  'company-decision-makers',
  'get-post-comments',
  'get-post-reactors',
  'get-post-resharers',
  // The services marketplace joined the eligible set on 2026-07-30 with its verbs
  // going live: paginated, person-returning, and the by-url form is detected from a
  // pasted /search/results/services/ URL like the other by-url sources.
  'search-service-providers',
  'search-service-providers-by-url',
  // Company-returning (result_kind = company)
  'search-companies-by-url',
  'search-companies-by-params',
  'search-sales-nav-companies-by-url',
  'search-sales-nav-companies-by-params',
  'similar-companies',
]);

const DetectedPlatform = z.enum(['linkedin', 'sales_navigator', 'recruiter']);
const ResultKind = z.enum(['person', 'company']);
const ReplayFrequency = z.enum(['hourly', 'daily', 'weekly', 'monthly']);

// Control axis only, two values. End of life is the soft delete, never a status.
const Status = z.enum(['active', 'paused']);

const PausedReason = z.enum(['manual', 'too_many_failures', 'account_unavailable']);

// Run status, repeated here for the run-now result alone. The full run contract
// lives in ../linkedin_auto_scrape_runs/mcp-tools.ts.
const RunStatus = z.enum(['pending', 'in_progress', 'completed', 'failed']);

// Item projection: LinkedinAutoScrapeDomain field for field (22 fields, oracle
// order). passthrough keeps forward-compat if the backend adds one.
const LinkedinAutoScrape = z.object({
  sid: z.string(),
  team_sid: z.string(),
  linkedin_account_sid: z.string(),

  // Source, immutable after create
  source_method: SourceMethod,
  source_input: z.record(z.unknown()),        // the verb's own arguments, stored verbatim

  // Derived from source_method at create, frozen
  detected_platform: DetectedPlatform,
  result_kind: ResultKind,

  status: Status,
  consecutive_failures: z.number(),           // auto-pause fires at 10
  runs_count: z.number(),
  total_new_results: z.number(),              // cumulative distinct leads across all runs

  title: z.string().nullable(),
  replay_frequency: ReplayFrequency.nullable(),   // null = one-shot
  paused_reason: PausedReason.nullable(),         // populated only while status='paused'
  next_run_at: z.string().nullable(),             // null = paused, exhausted one-shot, or a run in flight
  last_run_at: z.string().nullable(),
  mass_action_sid: z.string().nullable(),         // null = collect-only

  created_by: AccessIdentityValue.nullable(),
  deleted_by: AccessIdentityValue.nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
}).passthrough();

const LinkedinAutoScrapeCounts = z.object({}).passthrough();

// Every key exists on the PHP LinkedinAutoScrapeFilter (15 fields). A key it does
// not declare is a 500 inside the backend, not a 422, so this list is pinned by
// the contract-parity gate. No q: title is display-only and source_input is
// opaque JSON, so there is no free-text column to search.
const LinkedinAutoScrapeFilter = z.object({
  sid: filterOp(z.string(), ['eq', 'in']).optional(),
  linkedin_account_sid: filterOp(z.string(), ['eq', 'in']).optional(),
  source_method: filterOp(SourceMethod, ['eq', 'ne', 'in', 'nin']).optional(),
  detected_platform: filterOp(DetectedPlatform, ['eq', 'ne', 'in', 'nin']).optional(),
  result_kind: filterOp(ResultKind, ['eq', 'in']).optional(),
  replay_frequency: filterOp(ReplayFrequency, ['eq', 'in', 'is_null']).optional()
    .describe('is_null:true selects the one-shot jobs (no cadence).'),
  status: filterOp(Status, ['eq', 'in']).optional(),
  paused_reason: filterOp(PausedReason, ['eq', 'in', 'is_null']).optional()
    .describe('Why a paused job stopped. account_unavailable is the only reason the platform lifts by itself.'),
  mass_action_sid: filterOp(z.string(), ['eq', 'in', 'is_null']).optional()
    .describe('is_null:true selects collect-only jobs; eq finds every collector feeding one mass-action.'),
  next_run_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional()
    .describe('Due horizon. is_null:true means paused, an exhausted one-shot, or a run already in flight.'),
  last_run_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(),
  total_new_results: filterOp(z.number().int(), ['eq', 'gte', 'lte', 'gt', 'lt']).optional(),
  created_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  updated_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  deleted_at: filterOp(z.string(), ['is_null', 'gte', 'lte']).optional()
    .describe('Omit for live jobs only; send any operator to bring deleted collectors into scope.'),
}).partial();

// Pinned by the contract-parity gate against LinkedinAutoScrapeIncludedBuilder::available().
const LinkedinAutoScrapeInclude = z.enum(['linkedin_account', 'last_run']);

const LinkedinAutoScrapeSortable = z.enum([
  'created_at',
  'updated_at',
  'next_run_at',
  'last_run_at',
  'total_new_results',
]);

const RunNowResult = z.object({
  run_sid: z.string().describe('The minted run (ln_ar_...); read it with get_linkedin_auto_scrape_run.'),
  run_number: z.number(),
  status: RunStatus,
}).passthrough();

const SetMassActionResult = z.object({
  mass_action: z.record(z.unknown()).describe('The linked mass-action row, embedded for confirmation.'),
  previous_mass_action_sid: z.string().nullable()
    .describe('What the slot held before. It keeps draining its already-enrolled items; null on the first link.'),
}).passthrough();

const UnsetMassActionResult = z.object({
  unset_mass_action_sid: z.string().describe('The mass-action that was unlinked. It keeps running.'),
}).passthrough();

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE_IDEM = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

// create and run-now MINT A RUN, and a run is outward: the driver paginates
// LinkedIn through the executor's real browser, writes activity-log rows, spends
// the scraping smart-limit bucket, and (when the job is linked) enrols real
// people into a live mass-action that starts sending. None of that can be taken
// back through this API, so both carry the preview-then-confirm gate, exactly
// like linkedin_posting's three outward verbs. The research annotates them
// destructiveHint:false, which predates that gate; the registry invariant is
// dangerous: true implies destructiveHint: true, and the gate is the point.
// update stays ungated on purpose: it patches a title and a cadence, nothing
// leaves the platform.
const DANGER = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const DANGER_IDEM = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

const base = {
  service: 'linkedin',
  entity: 'linkedin_auto_scrapes',
  mount: 'linkedin.auto-scrapes',
} as const;

export const linkedinAutoScrapesTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_linkedin_auto_scrapes',
    description:
      "List the team's collectors: saved jobs that paginate one LinkedIn or Sales Navigator list surface on a cadence and file deduped leads. "
      + 'Use for: which collectors are live or paused and why (status, paused_reason), what a given account collects (linkedin_account_sid), which ones feed outreach (mass_action_sid, is_null:true = collect-only), what runs next (sort next_run_at asc), and which produce (total_new_results). '
      + 'NOT for the leads themselves (search_linkedin_auto_scrape_results) or for one execution (search_linkedin_auto_scrape_runs). '
      + 'No q. include: linkedin_account (the executor row) and last_run (the newest run, the only place an in-flight run shows up). Sort: created_at (default desc) | updated_at | next_run_at | last_run_at | total_new_results. page_size:0 returns the count alone.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-auto-scrapes/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    inputSchema: McpSearchRequestSchema(LinkedinAutoScrapeFilter, LinkedinAutoScrapeInclude, LinkedinAutoScrapeSortable, 200),
    outputSchema: McpSearchResponse(LinkedinAutoScrape, undefined, LinkedinAutoScrapeCounts),
    annotations: { title: 'Search LinkedIn auto-scrapes', ...RO },
  },
  {
    ...base,
    name: 'get_linkedin_auto_scrape',
    description:
      'Fetch one collector by sid: status and paused_reason, next_run_at and last_run_at, runs_count and total_new_results, and mass_action_sid (null = collect-only). '
      + 'include: linkedin_account (the executor row), last_run (the newest run, null when the job has never run). '
      + 'Executions and leads are separate reads: search_linkedin_auto_scrape_runs and search_linkedin_auto_scrape_results.',
    toolClass: 'trivial',
    route: { service: 'linkedin', method: 'GET', pathTemplate: '/api/linkedin-auto-scrapes/{sid}', sidParam: 'sid' },
    operation: 'get',
    envelope: 'get',
    availability: 'ga',
    dangerous: false,
    inputSchema: McpGetRequestSchema('ln_as_', LinkedinAutoScrapeInclude),
    outputSchema: McpGetResponse(LinkedinAutoScrape),
    annotations: { title: 'Get LinkedIn auto-scrape', ...RO },
  },
  {
    ...base,
    name: 'create_linkedin_auto_scrape',
    description:
      [
        'Save a scraping source as a collector and start it. Give the source EXACTLY one way: a bare url (people and company searches only) or the pair source_method plus source_input. Anything else is 422.',
        '',
        'Use for the standing ask, "keep pulling everyone behind this link". To wire outreach, author the plan FIRST on the mass-actions mount (preview_mass_action, then create_mass_action with scope kind none) and pass its ma_ac_ sid here: every new lead is appended to that run as one item. Omit mass_action_sid to collect only, omit replay_frequency for a one-shot.',
        '',
        'Run 1 dispatches AT ONCE: real LinkedIn automation starts, and a linked run begins enrolling. Watch it with search_linkedin_auto_scrape_runs, read the leads with search_linkedin_auto_scrape_results. Rejections are all pre-flight 422: invalid_url, invalid_source_method, method_not_available, source_input_incomplete, account_not_in_team, sales_nav_required (sales-nav sources and company-decision-makers need Sales Navigator), mass_action_incompatible.',
      ].join('\n'),
    toolClass: 'complex',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-auto-scrapes' },
    operation: 'create',
    envelope: 'create',
    availability: 'ga',
    dangerous: true,
    inputSchema: z.object({
      linkedin_account_sid: ACCOUNT_SID,
      title: z.string().max(255).nullable().optional()
        .describe('Human label for the list view. Server derives "{result_kind} {source_method}" when omitted.'),
      url: z.string().max(2048).optional()
        .describe('LinkedIn or Sales Navigator people/company SEARCH url. Mutually exclusive with source_method plus source_input.'),
      source_method: SourceMethod.optional()
        .describe('The paginated verb to replay. Required (with source_input) for every non-search source.'),
      source_input: z.record(z.unknown()).optional()
        .describe("The verb's own arguments. One key is mandatory per family: url, filters, anchor_company_ln_id, anchor_nickname (similar-profiles takes the vanity slug, never a URN), or activity_urn. filters takes the SAME schema as the matching scrape_linkedin_search_* (the merged tools; the old _by_params names are gone) tool (see it for the facet vocabulary and typeahead workflow)."),
      replay_frequency: ReplayFrequency.nullable().optional()
        .describe('Cadence: hourly | daily | weekly | monthly. Omit or null for a one-shot job that runs once.'),
      mass_action_sid: MASS_ACTION_SID.nullable().optional()
        .describe('Standing mass-action new leads enrol into. Cross-checked for same team, live, and target family compatible with result_kind.'),
      ...usageMetaField,
    }),
    outputSchema: McpCreateResponse(LinkedinAutoScrape),
    annotations: { title: 'Create LinkedIn auto-scrape', ...DANGER },
  },
  {
    ...base,
    name: 'update_linkedin_auto_scrape',
    description:
      'Patch a collector. Only title and replay_frequency are writable, and at least one must be sent (else 422 nothing_to_update). '
      + 'The source is immutable by design: a different source is a different collector, so create a new one. The outreach link moves through set_linkedin_auto_scrape_mass_action / unset_linkedin_auto_scrape_mass_action, and status through pause_linkedin_auto_scrape / resume_linkedin_auto_scrape. '
      + 'A cadence change re-plans next_run_at only when the clock is already armed; a run in flight keeps its claim and picks the new cadence up when it finalizes.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'PATCH', pathTemplate: '/api/linkedin-auto-scrapes/{sid}', sidParam: 'sid' },
    operation: 'update',
    envelope: 'update',
    availability: 'ga',
    dangerous: false,
    inputSchema: z.object({
      sid: SID,
      title: z.string().max(255).nullable().optional(),
      replay_frequency: ReplayFrequency.nullable().optional()
        .describe('null turns a recurring collector into a one-shot; it does NOT resume a paused one.'),
      ...usageMetaField,
    }),
    outputSchema: McpUpdateResponse(LinkedinAutoScrape),
    annotations: { title: 'Update LinkedIn auto-scrape', ...WRITE_IDEM },
  },
  {
    ...base,
    name: 'delete_linkedin_auto_scrape',
    description:
      'Retire a collector for good: soft-delete, so no further run is ever minted and a run in flight abandons at its next page boundary. '
      + 'Runs and collected leads are retained for audit and stay readable by sid. The linked mass-action is INDEPENDENT and keeps draining the leads already enrolled in it: stop that separately with delete_mass_action. '
      + 'To stop collecting for a while without losing the job, use pause_linkedin_auto_scrape instead. No undo through MCP.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'DELETE', pathTemplate: '/api/linkedin-auto-scrapes/{sid}', sidParam: 'sid' },
    operation: 'delete',
    envelope: 'delete_simple',
    availability: 'ga',
    dangerous: true,
    inputSchema: McpSimpleDeleteRequestSchema('ln_as_'),
    outputSchema: McpSimpleDeleteResponse,
    annotations: { title: 'Delete LinkedIn auto-scrape', ...DANGER_IDEM },
  },
  {
    ...base,
    name: 'pause_linkedin_auto_scrape',
    description:
      "Freeze recurrence: status becomes paused with paused_reason 'manual' and next_run_at is cleared, so no new run is minted. A run already in flight FINISHES (pausing never abandons it). "
      + 'Idempotent. Use to stop collecting over a holiday or while an outreach plan is being reworked; use delete_linkedin_auto_scrape to retire the job outright.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-auto-scrapes/{sid}/pause', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    stepEligible: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: SID, ...usageMetaField }),
    outputSchema: McpActionResponse(LinkedinAutoScrape),
    annotations: { title: 'Pause LinkedIn auto-scrape', ...WRITE_IDEM },
  },
  {
    ...base,
    name: 'resume_linkedin_auto_scrape',
    description:
      'Re-arm a paused collector: status becomes active, paused_reason clears, consecutive_failures resets to 0 and next_run_at is set to now, so the next scheduler tick mints a run. '
      + 'Works on any paused job, including a paused one-shot (a repeat pass is cheap because identity dedup makes it near zero new). 409 invalid_status_transition when the job is already active: an exhausted one-shot stays active with a null clock, and resuming it is exactly how you run it again.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-auto-scrapes/{sid}/resume', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    stepEligible: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: SID, ...usageMetaField }),
    outputSchema: McpActionResponse(LinkedinAutoScrape),
    annotations: { title: 'Resume LinkedIn auto-scrape', ...WRITE_IDEM },
  },
  {
    ...base,
    name: 'run_linkedin_auto_scrape_now',
    description:
      "Mint a manual run immediately, off schedule, and return its run_sid in result. Asynchronous: a worker drives the page loop, so poll get_linkedin_auto_scrape_run for status, new_count and enrolled_count. "
      + 'Use when the operator will not wait for the next slot. Only one run may be in flight per collector: 409 run_in_progress while one is pending or in_progress, and 409 auto_scrape_not_active on a paused job (resume it first).',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-auto-scrapes/{sid}/run-now', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    massAction: false,
    stepEligible: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: SID, ...usageMetaField }),
    outputSchema: McpActionResponse(LinkedinAutoScrape, RunNowResult),
    annotations: { title: 'Run LinkedIn auto-scrape now', ...DANGER },
  },
  {
    ...base,
    name: 'set_linkedin_auto_scrape_mass_action',
    description:
      'Wire this collector to a mass-action: from the next run on, every newly discovered lead is appended to that run as one item, which is how collection turns into outreach. '
      + 'Author the run FIRST on the mass-actions mount (preview_mass_action, then create_mass_action, normally with scope kind none) and pass its ma_ac_ sid here. Slot semantics: an existing link is replaced and returned as previous_mass_action_sid, and that older run keeps draining what it already holds. '
      + 'A run in flight is unaffected, it keeps the link it was minted with. 422 when the mass-action is missing, foreign, deleted, or its target family cannot accept this collector result_kind.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-auto-scrapes/{sid}/set-mass-action', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    stepEligible: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID,
      mass_action_sid: MASS_ACTION_SID,
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(LinkedinAutoScrape, SetMassActionResult),
    annotations: { title: 'Link LinkedIn auto-scrape to a mass-action', ...WRITE_IDEM },
  },
  {
    ...base,
    name: 'unset_linkedin_auto_scrape_mass_action',
    description:
      'Cut the outreach wire: clear mass_action_sid so the collector goes back to collect-only from the next run. '
      + 'This does NOT stop the mass-action. Leads already enrolled keep running, and stopping them is delete_mass_action on the mass-actions mount. A run in flight keeps enrolling into the link it was minted with. '
      + '409 no_mass_action_set when nothing is linked. To point the collector at a different plan, call set_linkedin_auto_scrape_mass_action instead: it replaces the slot in one call.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-auto-scrapes/{sid}/unset-mass-action', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    stepEligible: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: SID, ...usageMetaField }),
    outputSchema: McpActionResponse(LinkedinAutoScrape, UnsetMassActionResult),
    annotations: { title: 'Unlink LinkedIn auto-scrape from its mass-action', ...WRITE_IDEM },
  },
];
