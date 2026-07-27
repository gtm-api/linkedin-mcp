// Entity: LinkedIn Account Quota Hit (gtm.service.linkedin)
// Source of truth: product/research/gtm.service.linkedin/entities/linkedin_account_quota_hits.md
// Format: registry v2, where each tool carries route metadata so the generic
// dispatcher can drive it. 1 tool (the linkedin-account-quota-hits route group).
// Immutable append-only audit of LinkedIn-side blocks; read-only public surface.
// Mounted on linkedin.account-monitor.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  filterOp,
  McpSearchRequestSchema,
  McpSearchResponse,
} from '@gtm/mcp-shared';

// Item projection: every field of LinkedinAccountQuotaHitDomain (immutable,
// append-only: no updated_at / deleted_at / created_by). .passthrough() keeps
// forward-compat if the backend adds fields. Counts is the generic
// { total_count, groups:{} } → left loose.
const LinkedinAccountQuotaHit = z.object({
  sid: z.string(),
  team_sid: z.string(),
  linkedin_account_sid: z.string(),

  reason: z.enum(['connection_request', 'inmail'])
    .describe('LinkedinAccountQuotaHitReasonEnum: connection_request | inmail (future values may be added per research).'),

  // Activity counters frozen at quota-hit moment
  daily_count: z.number(),
  seven_days_count: z.number(),
  thirty_days_count: z.number(),

  // Lock expiry: mirrored into linkedin-account-smart-limits in the same tx
  linkedin_quota_hit_till: z.string().describe('LinkedIn-side hard-lock expiry (ISO 8601, UTC).'),

  // Snapshot pointer: latest warmup snapshot at quota-hit time
  linkedin_account_snapshot_sid: z.string().nullable(),

  // Account flags frozen at quota-hit moment
  has_premium: z.boolean(),
  has_sn: z.boolean(),
  has_recruiter: z.boolean(),

  // Timestamp: append-only
  created_at: z.string(),
}).passthrough();

const LinkedinAccountQuotaHitCounts = z.object({}).passthrough();

const num = (ops: Parameters<typeof filterOp>[1]) => filterOp(z.number().int(), ops).optional();
const dt = (ops: Parameters<typeof filterOp>[1]) => filterOp(z.string(), ops).optional();

const LinkedinAccountQuotaHitFilter = z.object({
  sid: filterOp(z.string(), ['eq', 'in']).optional(),
  linkedin_account_sid: filterOp(z.string(), ['eq', 'in']).optional(),
  linkedin_account_snapshot_sid: filterOp(z.string(), ['eq', 'in', 'is_null']).optional(),
  reason: filterOp(z.string(), ['eq', 'ne', 'in', 'nin']).optional(),
  has_premium: filterOp(z.boolean(), ['eq']).optional(),
  has_sn: filterOp(z.boolean(), ['eq']).optional(),
  has_recruiter: filterOp(z.boolean(), ['eq']).optional(),
  daily_count: num(['eq', 'gte', 'lte', 'gt', 'lt']),
  seven_days_count: num(['eq', 'gte', 'lte', 'gt', 'lt']),
  thirty_days_count: num(['eq', 'gte', 'lte', 'gt', 'lt']),
  linkedin_quota_hit_till: dt(['gte', 'lte', 'gt', 'lt'])
    .describe('"currently in effect" ⇒ { gt: "<now>" }.'),
  created_at: dt(['gte', 'lte', 'gt', 'lt']),
}).partial();

const LinkedinAccountQuotaHitInclude = z.enum(['linkedin_account', 'linkedin_account_snapshot']);
const LinkedinAccountQuotaHitSortable = z.enum(['created_at', 'linkedin_quota_hit_till']);

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const base = {
  service: 'linkedin',
  entity: 'linkedin_account_quota_hits',
  mount: 'linkedin.account-monitor',
} as const;

export const linkedinAccountQuotaHitsTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_linkedin_account_quota_hits',
    description:
      'List LinkedIn-side block events (weekly connection-request cap, InMail rate-limit, …) for the team: immutable, append-only, one row per (account, reason) per 12h dedup window. ' +
      'Use for: "is this account currently locked" (linkedin_quota_hit_till: { gt: "<now>" }), block-frequency trend, and "at what action volumes do blocks happen" (read the daily_count distribution). include[] linkedin_account / linkedin_account_snapshot correlate the block with account state at hit time. ' +
      'NOT for setting/clearing a lock (that lives on linkedin-account-smart-limits.linkedin_quota_hit_till) or per-target blocks (linkedin-account-block-log). No q. Sort: created_at (default desc) | linkedin_quota_hit_till.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-account-quota-hits/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: McpSearchRequestSchema(LinkedinAccountQuotaHitFilter, LinkedinAccountQuotaHitInclude, LinkedinAccountQuotaHitSortable, 200),
    outputSchema: McpSearchResponse(LinkedinAccountQuotaHit, undefined, LinkedinAccountQuotaHitCounts),
    annotations: { title: 'Search LinkedIn account quota hits', ...RO },
  },
];
