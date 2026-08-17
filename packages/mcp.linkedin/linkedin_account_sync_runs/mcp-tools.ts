// Entity: LinkedIn Account Sync Run (gtm.service.linkedin)
// Source of truth: product/research/gtm.service.linkedin/entities/linkedin_account_sync_runs.md
// Format: registry v2, where each tool carries route metadata so the generic
// dispatcher can drive it. 3 tools (the linkedin-account-sync-runs route group,
// read-only over MCP: search + metrics + get). Runs are created/advanced by the
// worker; the write surface is on linkedin-accounts (reset-sync / sync).
// Mounted on linkedin.account-monitor.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  AccessIdentityValue,
  filterOp,
  McpGetRequestSchema,
  McpGetResponse,
  McpMetricsRequestSchema,
  McpMetricsResponse,
  McpSearchRequestSchema,
  McpSearchResponse,
} from '@gtm/mcp-shared';

// Item projection: every field of LinkedinAccountSyncRunDomain (no deleted_at:
// system-generated tracking row, cancelled is the abandon path). .passthrough()
// keeps forward-compat if the backend adds fields. Counts have no concrete
// documented shape → left loose; the Metrics leaf carries avg_completed_duration_seconds.
const LinkedinAccountSyncRun = z.object({
  sid: z.string(),
  team_sid: z.string(),
  linkedin_account_sid: z.string(),

  // Classification (immutable after create)
  sync_type: z.enum([
    'connections',
    'connection_requests',
    'connection_invitations',
    'conversations',
    'sales_navigator_conversations',
    'messages',
    'sales_navigator_messages',
    'followers',
    'following',
    'snapshot',
    'premium_check',
  ]),
  sync_mode: z.enum(['initial', 'incremental']),
  scope_sid: z.string().nullable(), // ln_cv_* for message syncs; null for account-wide runs
  triggered_by: z.enum(['scheduler', 'account_created', 'reset_sync', 'event_handler']),

  // Pagination checkpoint
  next_cursor: z.string().nullable(),

  // Status
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled'])
    .describe('No failed state: dispatch failure is a browser problem, run is deferred.'),

  // Progress counters
  items_saved: z.number(),
  items_deleted: z.number(),
  pages_fetched: z.number(),

  // Worker liveness
  last_progress_at: z.string().nullable(),
  attempt_count: z.number(),

  // Deferred-attempt gate
  next_attempt_at: z.string().nullable(),
  wait_reason: z.string().nullable(),

  // Terminal
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  error_message: z.string().nullable(),

  // Audit: shared AccessIdentityValue
  created_by: AccessIdentityValue,

  // Timestamps
  created_at: z.string(),
  updated_at: z.string(),
}).passthrough();

const LinkedinAccountSyncRunCounts = z.object({}).passthrough();
// Leaf metrics object (lives at response.metrics.aggregated.metrics). Backend
// AVG(TIMESTAMPDIFF(...)) over completed runs, cast to int, or null when none.
const LinkedinAccountSyncRunMetrics = z.object({
  avg_completed_duration_seconds: z.number().nullable(),
}).passthrough();

const str = (ops: Parameters<typeof filterOp>[1]) => filterOp(z.string(), ops).optional();

const LinkedinAccountSyncRunFilter = z.object({
  sid: str(['eq', 'in']),
  linkedin_account_sid: str(['eq', 'in']),
  sync_type: str(['eq', 'in']),
  sync_mode: str(['eq']),
  scope_sid: str(['eq', 'in']),
  triggered_by: str(['eq', 'in']),
  status: str(['eq', 'in']).describe('Dominant query: { status: { in: ["pending","in_progress"] } }.'),
  // Deferral surface ("what is waiting"): a deferred run stays in_progress with a
  // future next_attempt_at; wait_reason (limit:* / browser:* / worker:*) slices by cause.
  next_attempt_at: str(['is_null', 'gte', 'lte']),
  wait_reason: str(['eq', 'in', 'is_null']),
  started_at: str(['gte', 'lte']),
  finished_at: str(['gte', 'lte', 'is_null']),
  created_at: str(['gte', 'lte']),
}).partial();

const LinkedinAccountSyncRunInclude = z.enum([
  'linkedin_account',
  'activity_log_pages',
  'limit',
]);
const LinkedinAccountSyncRunSortable = z.enum([
  'created_at',
  'started_at',
  'finished_at',
  'last_progress_at',
  'next_attempt_at',
  'items_saved',
]);
const LinkedinAccountSyncRunGroupable = z.enum(['status', 'sync_type', 'triggered_by']);

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const base = {
  service: 'linkedin',
  entity: 'linkedin_account_sync_runs',
  mount: 'linkedin.account-monitor',
} as const;

export const linkedinAccountSyncRunsTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_linkedin_account_sync_runs',
    description:
      'List sync runs: the backend-owned progress tracker for one paginated sync of one data surface (connections, connection_requests, connection_invitations, conversations, sales_navigator_conversations, followers) or a §5.7 composition (snapshot, premium_check). ' +
      'Use for: "is account X fully synced / how far along" (filter linkedin_account_sid + status in [pending, in_progress]), "which accounts are stuck mid-sync" (status in_progress, sort last_progress_at), "how fresh is the connection data" (latest completed connections run → finished_at). ' +
      'Runs are not created here; the write surface is linkedin-accounts.reset-sync / .sync. No q. Sort: created_at (default desc) | started_at | finished_at | last_progress_at | next_attempt_at | items_saved. include[]: linkedin_account, activity_log_pages, limit (default).',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-account-sync-runs/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    inputSchema: McpSearchRequestSchema(LinkedinAccountSyncRunFilter, LinkedinAccountSyncRunInclude, LinkedinAccountSyncRunSortable, 200),
    outputSchema: McpSearchResponse(LinkedinAccountSyncRun, undefined, LinkedinAccountSyncRunCounts),
    annotations: { title: 'Search LinkedIn account sync runs', ...RO },
  },
  {
    ...base,
    name: 'get_linkedin_account_sync_runs_metrics',
    description:
      'Aggregate sync-run counters for dashboards: a counts block (total + per-status: pending, in_progress, completed, cancelled) plus avg_completed_duration_seconds, with an optional group_by axis (status | sync_type | triggered_by) that repeats the same block per group. Required period {from,to} bounds the window.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-account-sync-runs/metrics' },
    operation: 'metrics',
    envelope: 'metrics',
    availability: 'ga',
    dangerous: false,
    // filter omitted: the backend metrics() query ignores it (it is only echoed
    // in applied_filters), so advertising it would be misleading. period is
    // REQUIRED by the backend FormRequest (period + period.from + period.to).
    inputSchema: McpMetricsRequestSchema(LinkedinAccountSyncRunFilter).omit({ filter: true }).extend({
      period: z.object({
        from: z.string().describe('ISO 8601 UTC window start (inclusive).'),
        to: z.string().describe('ISO 8601 UTC window end (exclusive); must be after from.'),
      }).describe('Required metrics window [from, to).'),
      group_by: LinkedinAccountSyncRunGroupable.optional().describe('Optional single split axis.'),
    }),
    outputSchema: McpMetricsResponse(LinkedinAccountSyncRunMetrics),
    annotations: { title: 'LinkedIn account sync-run metrics', ...RO },
  },
  {
    ...base,
    name: 'get_linkedin_account_sync_run',
    description:
      'Fetch one sync run by sid, with includes (linkedin_account; activity_log_pages for the per-page fetch log; limit for the gating smart-limit bucket, always resolved). Use to drill into a single run\'s progress, resume-cursor state, and per-page audit.',
    toolClass: 'trivial',
    route: { service: 'linkedin', method: 'GET', pathTemplate: '/api/linkedin-account-sync-runs/{sid}', sidParam: 'sid' },
    operation: 'get',
    envelope: 'get',
    availability: 'ga',
    dangerous: false,
    inputSchema: McpGetRequestSchema('ln_sy_', LinkedinAccountSyncRunInclude),
    outputSchema: McpGetResponse(LinkedinAccountSyncRun),
    annotations: { title: 'Get LinkedIn account sync run', ...RO },
  },
];
