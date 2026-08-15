// Entity: LinkedIn Auto-scrape Result (gtm.service.linkedin)
// Source of truth: product/research/gtm.service.linkedin/entities/linkedin_auto_scrape_results.md
// Format: registry v2, where each tool carries route metadata so the generic
// dispatcher can drive it. 1 tool = the 1 public
// api/linkedin-auto-scrape-results route (search), verified against
// fixtures/contract-oracle/linkedin.contract.json. Mounted on
// linkedin.auto-scrapes with the parent collector and its runs.
//
// This is the lead registry: one row per UNIQUE person or company per collector,
// deduped across every run by the identity ladder (ln_member_id, then ln_id, then
// sn_id, then nickname; company_ln_id then nickname for companies). A re-sighting
// UPDATES the row rather than adding one, so a run's new-lead delta is exactly
// the rows whose first_seen_run_sid is that run.
//
// Search is the whole public surface by design: there is no get (a filtered
// search already returns the full payload inline), no metrics (counts.total_count
// IS the unique-lead count because dedup is built into the row), and no write
// route (rows are written in-process by the run driver).

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  filterOp,
  McpSearchRequestSchema,
  McpSearchResponse,
} from '@gtm/mcp-shared';

const ResultKind = z.enum(['person', 'company']);

// Item projection: LinkedinAutoScrapeResultDomain field for field (17 fields,
// oracle order). passthrough keeps forward-compat if the backend adds one.
const LinkedinAutoScrapeResult = z.object({
  sid: z.string(),
  team_sid: z.string(),
  linkedin_auto_scrape_sid: z.string(),        // the owning collector = the dedup scope

  // Provenance
  first_seen_run_sid: z.string(),              // the run that first inserted this lead: the delta key
  last_seen_run_sid: z.string(),
  seen_runs_count: z.number(),                 // how many runs have observed it, a recurrence signal

  result_kind: ResultKind,
  dedup_key: z.string(),                       // canonical identity string, frozen at insert

  // Identity, flat and authoritative for filtering (payload is descriptive only)
  ln_member_id: z.string().nullable(),
  ln_id: z.string().nullable(),
  sn_id: z.string().nullable(),
  nickname: z.string().nullable(),
  company_ln_id: z.string().nullable(),

  payload: z.record(z.unknown()),              // latest raw observation: name, headline, location, industry, size

  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
}).passthrough();

const LinkedinAutoScrapeResultCounts = z.object({}).passthrough();

// Every key exists on the PHP LinkedinAutoScrapeResultFilter (15 fields). A key
// it does not declare is a 500 inside the backend, not a 422, so this list is
// pinned by the contract-parity gate. No q: every string column is a hash
// identifier, a vanity slug matched exactly, or a sid.
const LinkedinAutoScrapeResultFilter = z.object({
  sid: filterOp(z.string(), ['eq', 'in']).optional(),
  linkedin_auto_scrape_sid: filterOp(z.string(), ['eq', 'in']).optional()
    .describe('Parent collector (ln_as_...): the whole registry of one job.'),
  first_seen_run_sid: filterOp(z.string(), ['eq', 'in']).optional()
    .describe('The new-lead delta of one run (ln_ar_...). This is the ingest filter after a run completes.'),
  last_seen_run_sid: filterOp(z.string(), ['eq', 'in']).optional(),
  result_kind: filterOp(ResultKind, ['eq', 'in']).optional(),
  seen_runs_count: filterOp(z.number().int(), ['eq', 'gte', 'lte', 'gt', 'lt']).optional()
    .describe('Recurrence: gte 3 selects leads still showing up in the source. Pair with the parent sid.'),
  dedup_key: filterOp(z.string(), ['eq', 'in']).optional()
    .describe('Requires a linkedin_auto_scrape_sid partner, else 422 bounded_scan_required: the key is per collector.'),
  ln_member_id: filterOp(z.string(), ['eq', 'ne', 'in', 'nin', 'is_null']).optional()
    .describe('Canonical member id, exact match. The cross-surface bridge between classic and Sales Navigator sightings.'),
  ln_id: filterOp(z.string(), ['eq', 'ne', 'in', 'nin', 'is_null']).optional(),
  sn_id: filterOp(z.string(), ['eq', 'ne', 'in', 'nin', 'is_null']).optional(),
  nickname: filterOp(z.string(), ['eq', 'in', 'is_null']).optional()
    .describe('Vanity slug, exact match only (no partial or fuzzy matching).'),
  company_ln_id: filterOp(z.string(), ['eq', 'ne', 'in', 'nin', 'is_null']).optional(),
  created_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional()
    .describe('First-seen moment of the lead.'),
  updated_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional()
    .describe('Last re-sighting.'),
  deleted_at: filterOp(z.string(), ['is_null', 'gte', 'lte']).optional(),
}).partial();

// Pinned by the contract-parity gate against
// LinkedinAutoScrapeResultIncludedBuilder::available(). Both keys resolve against
// the runs table: the row stores run sids, and every reader wants the run NUMBER.
const LinkedinAutoScrapeResultInclude = z.enum(['first_seen_run', 'last_seen_run']);

const LinkedinAutoScrapeResultSortable = z.enum([
  'created_at',
  'updated_at',
  'seen_runs_count',
]);

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const base = {
  service: 'linkedin',
  entity: 'linkedin_auto_scrape_results',
  mount: 'linkedin.auto-scrapes',
} as const;

export const linkedinAutoScrapeResultsTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_linkedin_auto_scrape_results',
    description:
      'Read the leads a collector has captured: one row per unique person or company, deduped across every run, each carrying flat identifiers plus the latest payload (name, headline, location, industry). '
      + 'Use for: the whole registry of a job (filter linkedin_auto_scrape_sid), the fresh delta of one run (first_seen_run_sid, the ingest path once a run completes), is this person already collected (parent sid plus ln_member_id or company_ln_id), and which leads keep re-appearing (seen_runs_count gte 3). '
      + 'page_size 0 returns counts.total_count, which IS the unique-lead count because dedup is built into the row. '
      + 'NOT for how a run went (search_linkedin_auto_scrape_runs), NOT for managing the job (search_linkedin_auto_scrapes), and NOT for outreach state: this registry records who was collected, never what was done to them. '
      + 'No q; include first_seen_run / last_seen_run for the run number behind the sid; nickname is exact match; dedup_key needs its parent partner. Sort: created_at (default desc) | updated_at | seen_runs_count.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-auto-scrape-results/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    inputSchema: McpSearchRequestSchema(LinkedinAutoScrapeResultFilter, LinkedinAutoScrapeResultInclude, LinkedinAutoScrapeResultSortable, 200),
    outputSchema: McpSearchResponse(LinkedinAutoScrapeResult, undefined, LinkedinAutoScrapeResultCounts),
    annotations: { title: 'Search LinkedIn auto-scrape results', ...RO },
  },
];
