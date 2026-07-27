// Entity: LinkedIn Account Block Log (gtm.service.linkedin)
// Source of truth: product/research/gtm.service.linkedin/entities/linkedin_account_block_log.md
// Format: registry v2, where each tool carries route metadata so the generic
// dispatcher can drive it. 1 tool (the linkedin-account-block-log route group).
// Immutable per-(account, target) hostility ledger; read-only public surface.
// Mounted on linkedin.account-monitor.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  filterOp,
  McpSearchRequestSchema,
  McpSearchResponse,
} from '@gtm/mcp-shared';

// Item projection: every field of LinkedinAccountBlockLogDomain (immutable,
// append-only: no updated_at / deleted_at / created_by). .passthrough() keeps
// forward-compat if the backend adds fields.
const LinkedinAccountBlockLog = z.object({
  sid: z.string(),
  team_sid: z.string(),
  linkedin_account_sid: z.string(),

  // Target identity: denormalised contact identifiers (KNOWLEDGE §3/§3b)
  target_ln_member_id: z.string(),
  target_ln_id: z.string().nullable(),
  target_sn_id: z.string().nullable(),
  target_nickname: z.string().nullable(),

  // Provenance: joins this row to its causing audit trail
  linkedin_account_activity_log_sid: z.string(),
  linkedin_connection_sid: z.string().nullable(),

  // Timestamp: append-only
  created_at: z.string(),
}).passthrough();

// Counts: distinctive documented shape (research §MCP Tools). Same object is
// returned in search.counts AND on the parent linkedin-accounts include.
const LinkedinAccountBlockLogCounts = z.object({
  total_count: z.number(),
  last_24h_count: z.number(),
  last_7d_count: z.number(),
  last_30d_count: z.number(),
  with_connection_count: z.number(),
  without_connection_count: z.number(),
  // PHP serialises an empty group map as [], so accept object or array.
  groups: z.record(z.unknown()),
}).passthrough();

const LinkedinAccountBlockLogFilter = z.object({
  sid: filterOp(z.string(), ['eq', 'in']).optional(),
  linkedin_account_sid: filterOp(z.string(), ['eq', 'in']).optional(),
  target_ln_id: filterOp(z.string(), ['eq', 'in']).optional()
    .describe('Raw regular-profile URN; normalized to target_ln_member_id on filter.'),
  target_ln_member_id: filterOp(z.string(), ['eq', 'in', 'is_null']).optional()
    .describe('Canonical permanent-dedup key (cross-account hostile-target lookup).'),
  target_sn_id: filterOp(z.string(), ['eq', 'in', 'is_null']).optional(),
  target_nickname: filterOp(z.string(), ['eq', 'in', 'is_null']).optional()
    .describe('Exact-match only.'),
  linkedin_account_activity_log_sid: filterOp(z.string(), ['eq', 'in']).optional()
    .describe('Reverse lookup from a failed task.'),
  linkedin_connection_sid: filterOp(z.string(), ['eq', 'in', 'is_null']).optional()
    .describe('is_null:true ⇒ blocks against profiles that were never our connections.'),
  created_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
}).partial();

const LinkedinAccountBlockLogInclude = z.enum([
  'linkedin_account',
  'linkedin_account_activity_log',
  'linkedin_connection',
]);
const LinkedinAccountBlockLogSortable = z.enum(['created_at']);

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const base = {
  service: 'linkedin',
  entity: 'linkedin_account_block_log',
  mount: 'linkedin.account-monitor',
} as const;

export const linkedinAccountBlockLogTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_linkedin_account_block_log',
    description:
      'List per-target block observations for the team: one permanently-deduplicated row per (account, target) whenever a target profile blocked one of our accounts (established by the §5.6 check-target-block). ' +
      'Use for: "did target X block any of our accounts" (filter target_ln_member_id, no account filter → crosses the team), churn caused by blocks (include linkedin_connection), a hostile-segment trend (created_at window + total_count), reverse-lookup from a failed activity_log row or a soft-deleted connection. ' +
      'NOT for platform-wide locks (weekly cap / InMail rate-limit → linkedin-account-quota-hits) or raw plugin error text (linkedin-account-activity-log). No q; target_nickname is exact-match. Sort: created_at (default desc). include[]: linkedin_account, linkedin_account_activity_log, linkedin_connection.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-account-block-log/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: McpSearchRequestSchema(LinkedinAccountBlockLogFilter, LinkedinAccountBlockLogInclude, LinkedinAccountBlockLogSortable, 200),
    outputSchema: McpSearchResponse(LinkedinAccountBlockLog, undefined, LinkedinAccountBlockLogCounts),
    annotations: { title: 'Search LinkedIn account block log', ...RO },
  },
];
