// Entity: LinkedIn Auto-scrape Run (gtm.service.linkedin)
// Source of truth: product/research/gtm.service.linkedin/entities/linkedin_auto_scrape_runs.md
// Format: registry v2, where each tool carries route metadata so the generic
// dispatcher can drive it. 2 tools = the 2 public api/linkedin-auto-scrape-runs
// routes (search + get), verified against
// fixtures/contract-oracle/linkedin.contract.json. Mounted on
// linkedin.auto-scrapes next to its parent and the results registry.
//
// A run is ONE execution of a collector's page loop, and it is append-only over
// MCP: there is no create, update or delete route. Runs are minted by the parent
// (create_linkedin_auto_scrape, the scheduler tick, run_linkedin_auto_scrape_now),
// and the only public write path is that parent surface.
//
// No include[] is advertised: the research designs linkedin_auto_scrape /
// new_results / new_results_counts, but the controller answers `included: []`, so
// naming them would promise a join the backend does not perform. The delta of a
// run is one search_linkedin_auto_scrape_results call on first_seen_run_sid.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  filterOp,
  McpGetRequestSchema,
  McpGetResponse,
  McpSearchRequestSchema,
  McpSearchResponse,
} from '@gtm/mcp-shared';

const Trigger = z.enum(['initial', 'scheduled', 'manual']);

// pending -> in_progress -> completed | failed. Terminal states never resurrect;
// an abandoned run (its parent was deleted mid-flight) is a failed row whose
// error_message starts with 'abandoned:'.
const RunStatus = z.enum(['pending', 'in_progress', 'completed', 'failed']);

// Item projection: LinkedinAutoScrapeRunDomain field for field (19 fields, oracle
// order). No deleted_at: runs are append-only execution records, hidden from
// default reads through the parent scope rather than deleted. passthrough keeps
// forward-compat if the backend adds a field.
const LinkedinAutoScrapeRun = z.object({
  sid: z.string(),
  team_sid: z.string(),

  linkedin_auto_scrape_sid: z.string(),
  linkedin_account_sid: z.string(),            // executor snapshot at mint

  run_number: z.number(),                      // 1-based ordinal within the parent
  trigger: Trigger,
  status: RunStatus,

  // Page counters, advanced by the driver one applied page at a time
  page_cursor: z.number(),                     // last fully applied page; the worker fetches page_cursor + 1
  pages_applied: z.number(),
  results_seen: z.number(),                    // new + seen + rows with no decodable identity

  // Delta counters, this run's contribution
  new_count: z.number(),
  seen_count: z.number(),
  enrolled_count: z.number(),                  // always <= new_count

  mass_action_sid: z.string().nullable(),      // the parent's link AS OF mint, frozen for audit

  completed_at: z.string().nullable(),
  failed_at: z.string().nullable(),
  error_message: z.string().nullable(),

  created_at: z.string(),
  updated_at: z.string(),
}).passthrough();

const LinkedinAutoScrapeRunCounts = z.object({}).passthrough();

// Every key exists on the PHP LinkedinAutoScrapeRunFilter (13 fields). A key it
// does not declare is a 500 inside the backend, not a 422, so this list is pinned
// by the contract-parity gate. No q: every string column is a sid, an enum, or a
// free-form error message.
const LinkedinAutoScrapeRunFilter = z.object({
  sid: filterOp(z.string(), ['eq', 'in']).optional(),
  linkedin_auto_scrape_sid: filterOp(z.string(), ['eq', 'in']).optional()
    .describe('Parent collector (ln_as_...). The dominant scope: one job history.'),
  linkedin_account_sid: filterOp(z.string(), ['eq', 'in']).optional(),
  mass_action_sid: filterOp(z.string(), ['eq', 'in', 'is_null']).optional()
    .describe('Which runs fed one mass-action. is_null:true = the run was minted collect-only.'),
  run_number: filterOp(z.number().int(), ['eq', 'gte', 'lte', 'gt', 'lt']).optional()
    .describe('Requires a linkedin_auto_scrape_sid partner, else 422 bounded_scan_required: the ordinal is per parent.'),
  trigger: filterOp(Trigger, ['eq', 'ne', 'in', 'nin']).optional(),
  status: filterOp(RunStatus, ['eq', 'ne', 'in', 'nin']).optional(),
  new_count: filterOp(z.number().int(), ['eq', 'gte', 'lte', 'gt', 'lt']).optional(),
  enrolled_count: filterOp(z.number().int(), ['eq', 'gte', 'lte', 'gt', 'lt']).optional(),
  completed_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(),
  failed_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(),
  created_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  updated_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
}).partial();

const LinkedinAutoScrapeRunSortable = z.enum([
  'created_at',
  'run_number',
  'completed_at',
  'new_count',
]);

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const base = {
  service: 'linkedin',
  entity: 'linkedin_auto_scrape_runs',
  mount: 'linkedin.auto-scrapes',
} as const;

export const linkedinAutoScrapeRunsTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_linkedin_auto_scrape_runs',
    description:
      'List executions of the collectors: one row per pass of one auto-scrape page loop, with its page progress and its delta (new_count, seen_count, enrolled_count). '
      + 'Use for: the history of one job (filter linkedin_auto_scrape_sid, sort run_number desc, page_size 1 for the latest), why collection stopped (status failed, then read error_message), which runs produced (sort new_count desc), and which fed a mass-action (mass_action_sid). '
      + 'NOT for the leads themselves (search_linkedin_auto_scrape_results on first_seen_run_sid) and NOT for starting a run (run_linkedin_auto_scrape_now): runs are server-minted and immutable. '
      + 'No q, no include[]. run_number needs its parent partner (422 bounded_scan_required). Sort: created_at (default desc) | run_number | completed_at | new_count.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-auto-scrape-runs/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: McpSearchRequestSchema(LinkedinAutoScrapeRunFilter, undefined, LinkedinAutoScrapeRunSortable, 200),
    outputSchema: McpSearchResponse(LinkedinAutoScrapeRun, undefined, LinkedinAutoScrapeRunCounts),
    annotations: { title: 'Search LinkedIn auto-scrape runs', ...RO },
  },
  {
    ...base,
    name: 'get_linkedin_auto_scrape_run',
    description:
      'Fetch one run by sid: the poll handle after run_linkedin_auto_scrape_now. Read status, page_cursor and pages_applied for progress, new_count against enrolled_count for how much of the delta reached the linked mass-action, and error_message for why a failed run failed. '
      + 'The leads it discovered come from search_linkedin_auto_scrape_results filtered on first_seen_run_sid, which is the authoritative delta (new_count is a best-effort rollup under crash retry).',
    toolClass: 'trivial',
    route: { service: 'linkedin', method: 'GET', pathTemplate: '/api/linkedin-auto-scrape-runs/{sid}', sidParam: 'sid' },
    operation: 'get',
    envelope: 'get',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: McpGetRequestSchema('ln_ar_'),
    outputSchema: McpGetResponse(LinkedinAutoScrapeRun),
    annotations: { title: 'Get LinkedIn auto-scrape run', ...RO },
  },
];
