// Entity: LinkedIn Follower (gtm.service.linkedin)
// Source of truth: product/research/gtm.service.linkedin/entities/linkedin_followers.md
// Format: registry v2, where each tool carries route metadata so the generic
// dispatcher can drive it. 3 tools (the linkedin-followers route group: read +
// §5.8 head refresh; no get/create/update/delete, no outward actions),
// mounted on linkedin.network.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  filterOp,
  usageMetaField,
  McpMetricsResponse,
  McpMetricsRequestSchema,
  McpSearchRequestSchema,
  McpSearchResponse,
} from '@gtm/mcp-shared';

const ACCOUNT_SID = z.string().length(18).startsWith('ln_ac_')
  .describe('LinkedIn account sid (ln_ac_…) of the account being followed.');

// Item projection: every field of LinkedinFollowerDomain (research §Domain).
// Base scalar columns are always serialized (present keys; only nullable when the
// Domain type is `| null`); .passthrough() keeps forward-compat keys valid
// (get-my-latest also appends a `refresh` block; include[] eager-loads).
const LinkedinFollower = z.object({
  sid: z.string(),
  team_sid: z.string(),
  linkedin_account_sid: z.string(),
  ln_member_id: z.string(),
  ln_id: z.string().nullable(),
  sn_id: z.string().nullable(),
  nickname: z.string().nullable(),
  full_name: z.string().nullable(),
  last_check_at: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
}).passthrough();

// Counts: concrete shape per research §search Counts. passthrough for forward-compat.
const LinkedinFollowerCounts = z.object({
  total_count: z.number(),
  groups: z.record(z.unknown()), // dynamic breakdown, object even when empty
}).passthrough();

// Metrics: concrete shape per research §metrics. passthrough for forward-compat.
const LinkedinFollowerMetrics = z.object({
  followers_growth: z.number(),
  follower_to_connection_conversions: z.number(),
  connected_follower_share: z.number(),
}).passthrough();

// §5.8 head-refresh telemetry: appended to the get-my-latest search envelope by
// the AppendsLatestRefresh trait. Always present: on a read-only cursor
// continuation performed=false, stats zero out and stop_reason is null; on the
// first page (cursor null) performed=true and stop_reason is one of the engine's
// four terminal reasons (LatestFetchEngine).
const LinkedinFollowerRefresh = z.object({
  performed: z.boolean(),
  pages_fetched: z.number(),
  items_seen: z.number(),
  items_upserted: z.number(),
  stop_reason: z.enum(['overlap', 'covered', 'page_cap', 'exhausted']).nullable(),
});

const LinkedinFollowerFilter = z.object({
  sid: filterOp(z.string(), ['eq', 'in']).optional(),
  linkedin_account_sid: filterOp(z.string(), ['eq', 'in']).optional(),
  ln_id: filterOp(z.string(), ['eq', 'ne', 'in', 'nin', 'is_null']).optional(),
  ln_member_id: filterOp(z.string(), ['eq', 'ne', 'in', 'nin']).optional(),
  sn_id: filterOp(z.string(), ['eq', 'ne', 'in', 'nin', 'is_null']).optional(),
  nickname: filterOp(z.string(), ['eq', 'in', 'is_null']).optional(),
  q: z.string().optional().describe('Full-text LIKE over the follower display name (full_name).'),
  last_check_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  created_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  updated_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  deleted_at: filterOp(z.string(), ['is_null', 'gte', 'lte']).optional(),
}).partial();

const LinkedinFollowerInclude = z.enum([
  'linkedin_account',
  'linkedin_connection',
  'linkedin_connection_request',
]);

const LinkedinFollowerSortable = z.enum(['created_at', 'last_check_at', 'updated_at']);

const LinkedinFollowerGroupable = z.enum(['linkedin_account_sid']);

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const base = {
  service: 'linkedin',
  entity: 'linkedin_followers',
  mount: 'linkedin.network',
} as const;

export const linkedinFollowersTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_linkedin_followers',
    description:
      'List stored followers of team accounts with filters, sorting, cursor pagination and full-text q over the follower name. Returns a counts block. include[] can eager-load linkedin_account plus the funnel probes linkedin_connection / linkedin_connection_request; both absent means a warm, untouched prospect.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-followers/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    inputSchema: McpSearchRequestSchema(LinkedinFollowerFilter, LinkedinFollowerInclude, LinkedinFollowerSortable, 200),
    outputSchema: McpSearchResponse(LinkedinFollower, undefined, LinkedinFollowerCounts),
    annotations: { title: 'Search LinkedIn followers', ...RO },
  },
  {
    ...base,
    name: 'get_linkedin_followers_metrics',
    description:
      'Period-bound audience aggregates over a filtered follower set. Requires period {from,to}. Returns followers_growth, follower_to_connection_conversions and connected_follower_share. Optional filter and a single group_by axis (linkedin_account_sid).',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-followers/metrics' },
    operation: 'metrics',
    envelope: 'metrics',
    availability: 'ga',
    dangerous: false,
    inputSchema: McpMetricsRequestSchema(LinkedinFollowerFilter).extend({
      period: z.object({
        from: z.string().describe('ISO 8601 UTC window start (inclusive).'),
        to: z.string().describe('ISO 8601 UTC window end (exclusive); must be after from.'),
      }).describe('Required metrics window [from, to).'),
      group_by: LinkedinFollowerGroupable.optional().describe('Optional single split axis.'),
    }),
    outputSchema: McpMetricsResponse(LinkedinFollowerMetrics),
    annotations: { title: 'LinkedIn followers metrics', ...RO },
  },
  {
    ...base,
    name: 'get_my_latest_linkedin_followers',
    description:
      'Always-fresh head read of the followers list: refresh the newest from LinkedIn in-request (§5.8), then return the last N (created_at DESC) with a counts block. The first page (cursor null) triggers the refresh; continuation pages read the already-refreshed DB. Account-scoped.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-followers/get-my-latest' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    inputSchema: z.object({
      linkedin_account_sid: ACCOUNT_SID,
      page_size: z.number().int().min(1).max(100).optional()
        .describe('Freshest rows to return / refresh coverage target (1..100, default 50).'),
      cursor: z.string().nullable().optional()
        .describe('Opaque forward cursor; the LinkedIn-side refresh runs only on the first page (cursor null).'),
      ...usageMetaField,
    }),
    outputSchema: McpSearchResponse(LinkedinFollower, undefined, LinkedinFollowerCounts)
      .extend({ refresh: LinkedinFollowerRefresh }),
    annotations: { title: 'Get my latest followers', ...RO },
  },
];
