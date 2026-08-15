// Entity: LinkedIn Account Activity Log (gtm.service.linkedin)
// Source of truth: product/research/gtm.service.linkedin/entities/linkedin_account_activity_log.md
// Format: registry v2, where each tool carries route metadata so the generic
// dispatcher can drive it. 2 tools (the linkedin-account-activity-log route
// group, a read-only diagnostic surface: search + metrics). Writes are owned by
// the service layer. Mounted on linkedin.account-monitor.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  filterOp,
  McpMetricsRequestSchema,
  McpMetricsResponse,
  McpSearchRequestSchema,
  McpSearchResponse,
} from '@gtm/mcp-shared';

// Item projection: every field of LinkedinAccountActivityLogDomain, field-for-
// field from the research #### Domain. .passthrough() keeps forward-compat if the
// backend adds fields (incl. queued action_type additions like get_my_followers_page).
const LinkedinAccountActivityLog = z.object({
  sid: z.string(),
  team_sid: z.string(),
  linkedin_account_sid: z.string(),
  trace_id: z.string(),

  // Action descriptor: set once at recordPending(...)
  // Open taxonomy (§6.4 / §8.2): the backend adds new automation verbs by
  // ripple (e.g. get_linkedin_profiles_search_by_params), so this is a plain
  // string, not a closed enum, to avoid false contract failures on new verbs.
  action_type: z.string(),
  status: z.enum(['pending', 'success', 'failed', 'skipped']),
  sync_run_sid: z.string().nullable(),
  // LinkedinAccountSmartLimitTypeEnum (owned by linkedin_account_smart_limits.md):
  // exact values not in this file's source, so this is kept as a nullable string.
  limit_type_override: z.string().nullable(),

  // Target identity: denormalised contact identifiers (KNOWLEDGE §3/§3b)
  target_ln_member_id: z.string().nullable(),
  target_ln_id: z.string().nullable(),
  target_sn_id: z.string().nullable(),
  target_nickname: z.string().nullable(),

  // Outcome: null while pending; populated by finalize(...)
  error_code: z.string().nullable().describe('§6.4 OPEN taxonomy: string, not enum.'),
  error_message: z.string().nullable(),
  duration_ms: z.number().nullable(),

  // Timestamps
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
}).passthrough();

// Metrics leaf: documented as LinkedinAccountActivityLogMetrics (research §metrics).
const LinkedinAccountActivityLogMetrics = z.object({
  avg_duration_ms: z.number().nullable(),
  avg_pending_age_seconds: z.number().nullable(),
}).passthrough();

const str = (ops: Parameters<typeof filterOp>[1]) => filterOp(z.string(), ops).optional();

const LinkedinAccountActivityLogFilter = z.object({
  sid: str(['eq', 'in']),
  linkedin_account_sid: str(['eq', 'in']).describe('Required for metrics (service-layer guardrail).'),
  trace_id: str(['eq', 'in']).describe('Grafana Tempo / Loki cross-lookup.'),
  action_type: str(['eq', 'ne', 'in', 'nin']),
  status: str(['eq', 'ne', 'in', 'nin']).describe('pending | success | failed | skipped.'),
  sync_run_sid: str(['eq', 'in', 'is_null']),
  error_code: str(['eq', 'in', 'is_null'])
    .describe("§6.4 open taxonomy; eq:'target_blocked' surfaces backend-derived block outcomes."),
  target_ln_id: str(['eq', 'in', 'is_null']),
  target_ln_member_id: str(['eq', 'in', 'is_null']).describe('Canonical cross-surface key.'),
  target_sn_id: str(['eq', 'in', 'is_null']),
  target_nickname: str(['eq', 'in', 'is_null']),
  duration_ms: filterOp(z.number().int(), ['eq', 'ne', 'gte', 'lte', 'gt', 'lt', 'is_null']).optional()
    .describe('is_null:true ⇒ pending row.'),
  created_at: str(['gte', 'lte', 'gt', 'lt']),
  updated_at: str(['gte', 'lte', 'gt', 'lt']),
  deleted_at: str(['is_null', 'gte', 'lte']).describe('Default scope: { is_null: true }.'),
}).partial();

// METRICS does not reuse the search filter, and that gap is the contract, not an
// oversight. LinkedinAccountActivityLogService::metrics() builds no
// LinkedinAccountActivityLogFilter: it reads two hand-picked keys off
// input(filter) and applies nothing else, so every other axis would be accepted
// by z.object, stripped by no one, and dropped by the aggregation - a filtered
// question answered with unfiltered numbers, which an agent cannot detect. The
// MetricsRequest declares exactly these two.
const LinkedinAccountActivityLogMetricsFilter = z.object({
  linkedin_account_sid: str(['eq', 'in'])
    .describe('REQUIRED: metrics rejects an unbounded scan with bounded_scan_required.'),
  // The service reads .eq (or a bare string); .ne / .in / .nin are not applied.
  status: filterOp(z.string(), ['eq']).optional()
    .describe('pending | success | failed | skipped. Only .eq is applied here.'),
}).partial();

const LinkedinAccountActivityLogInclude = z.enum([
  'linkedin_account',
  'linkedin_account_smart_limit',
  'sync_run',
]);
const LinkedinAccountActivityLogSortable = z.enum(['created_at', 'duration_ms']);
const LinkedinAccountActivityLogGroupable = z.enum(['action_type', 'status', 'linkedin_account_sid']);

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const base = {
  service: 'linkedin',
  entity: 'linkedin_account_activity_log',
  mount: 'linkedin.account-monitor',
} as const;

export const linkedinAccountActivityLogTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_linkedin_account_activity_log',
    description:
      'List activity-log rows, one per plugin call (Task↔Result cycle): pending on dispatch, then success / failed / skipped. ' +
      'Use for: "why is account X failing" (status:failed + created_at window, read error_message/error_code), inspecting in-flight pending tasks, cross-referencing a Grafana trace_id, and polling an MCP-triggered async action by sid until status flips terminal. ' +
      'NOT for LinkedIn quota hits (linkedin-account-quota-hits), the rolling limit count (linkedin-account-smart-limits), or account state (linkedin-accounts). No q. Sort: created_at (default desc) | duration_ms. include[]: linkedin_account, linkedin_account_smart_limit, sync_run.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-account-activity-log/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    inputSchema: McpSearchRequestSchema(LinkedinAccountActivityLogFilter, LinkedinAccountActivityLogInclude, LinkedinAccountActivityLogSortable, 200),
    // search emits no counts block: the counts/aggregate surface is metrics-only
    // (LinkedinAccountActivityLogController::search calls mcpSearch without a
    // counts arg; aggregate() is consumed solely by metrics()).
    outputSchema: McpSearchResponse(LinkedinAccountActivityLog),
    annotations: { title: 'Search LinkedIn account activity log', ...RO },
  },
  {
    ...base,
    name: 'get_linkedin_account_activity_log_metrics',
    description:
      'Period-bound aggregates over a filtered activity-log set (avg plugin duration, avg pending age) plus the counts block and an optional group_by axis (action_type | status | linkedin_account_sid). ' +
      'Use for: "what was done today/this week grouped by action_type", at-a-glance fail rate (group_by status). ' +
      'Guardrail (high-write table): period {from,to} is REQUIRED and filter must include linkedin_account_sid.eq/.in. Unbounded scans are rejected; window may not exceed 90 days. ' +
      'The filter here is NARROWER than search: linkedin_account_sid and status are the only axes the aggregation applies. Slice any other dimension with group_by, or use search.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-account-activity-log/metrics' },
    operation: 'metrics',
    envelope: 'metrics',
    availability: 'ga',
    dangerous: false,
    inputSchema: McpMetricsRequestSchema(LinkedinAccountActivityLogMetricsFilter).extend({
      period: z.object({
        from: z.string().describe('ISO 8601 UTC window start (inclusive).'),
        to: z.string().describe('ISO 8601 UTC window end (exclusive); must be after from.'),
      }).describe('Required metrics window [from, to), max 90 days.'),
      group_by: LinkedinAccountActivityLogGroupable.optional().describe('Optional single split axis.'),
    }),
    outputSchema: McpMetricsResponse(LinkedinAccountActivityLogMetrics),
    annotations: { title: 'LinkedIn account activity-log metrics', ...RO },
  },
];
