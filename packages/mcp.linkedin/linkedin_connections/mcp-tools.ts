// Entity: LinkedIn Connection (gtm.service.linkedin)
// Source of truth: product/research/gtm.service.linkedin/entities/linkedin_connections.md
// Format: registry v2, where each tool carries route metadata so the generic
// dispatcher can drive it. 6 tools (the linkedin-connections route group),
// mounted on linkedin.network alongside connection-requests / invitations /
// followers.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  filterOp,
  usageMetaField,
  McpActionResponse,
  McpAsyncActionResponse,
  McpMetricsResponse,
  McpMetricsRequestSchema,
  McpSearchRequestSchema,
  McpSearchResponse,
} from '@gtm/mcp-shared';

// Entity sid (path {sid}); account sid (body linkedin_account_sid).
const SID = z.string().length(18).startsWith('ln_cn_')
  .describe('LinkedIn connection sid (ln_cn_…).');
const ACCOUNT_SID = z.string().length(18).startsWith('ln_ac_')
  .describe('LinkedIn account sid (ln_ac_…) whose network is acted on.');

// Target person for check-degree: exactly one identifier (backend-validated).
const Target = z.object({
  ln_id: z.string().max(128).optional().describe('Regular-profile URN (ACoAA…).'),
  sn_id: z.string().max(64).optional().describe('Sales Navigator URN (ACwAA…).'),
  nickname: z.string().max(100).optional().describe('Public profile slug.'),
}).describe('Target person; supply exactly one of ln_id / sn_id / nickname.');

const LinkedinConnectionRemovalKind = z.enum(['removed', 'blocked']);

// Item projection: every field of LinkedinConnectionDomain (research §Domain).
// Base scalar columns are always serialized (present keys; only nullable when the
// Domain type is `| null`); .passthrough() keeps forward-compat keys valid
// (get-my-latest also appends a `refresh` block; include[] eager-loads).
const LinkedinConnection = z.object({
  sid: z.string(),
  team_sid: z.string(),
  linkedin_account_sid: z.string(),
  ln_member_id: z.string(),
  ln_id: z.string().nullable(),
  sn_id: z.string().nullable(),
  nickname: z.string().nullable(),
  full_name: z.string().nullable(),
  connected_at: z.string().nullable(),
  linkedin_connection_request_sid: z.string().nullable(),
  linkedin_connection_invitation_sid: z.string().nullable(),
  last_check_at: z.string().nullable(),
  removal_kind: LinkedinConnectionRemovalKind.nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
}).passthrough();

// Counts: concrete shape per research §search Counts. passthrough for forward-compat.
const LinkedinConnectionCounts = z.object({
  total_count: z.number(),
  live_count: z.number(),
  removed_count: z.number(),
  blocked_count: z.number(),
  from_request_count: z.number(),
  from_invitation_count: z.number(),
  sync_only_count: z.number(),
  groups: z.record(z.unknown()), // dynamic breakdown, object even when empty
}).passthrough();

// Metrics: concrete shape per research §metrics. passthrough for forward-compat.
const LinkedinConnectionMetrics = z.object({
  connections_growth: z.number(),
  connections_removed: z.number(),
  net_growth: z.number(),
  reply_rate_within_connections: z.number(),
  dormant_connections: z.number(),
  avg_time_to_first_message: z.number().nullable(),
}).passthrough();

const LinkedinConnectionFilter = z.object({
  sid: filterOp(z.string(), ['eq', 'in']).optional(),
  linkedin_account_sid: filterOp(z.string(), ['eq', 'in']).optional(),
  ln_id: filterOp(z.string(), ['eq', 'ne', 'in', 'nin', 'is_null']).optional(),
  ln_member_id: filterOp(z.string(), ['eq', 'ne', 'in', 'nin', 'is_null']).optional(),
  sn_id: filterOp(z.string(), ['eq', 'ne', 'in', 'nin', 'is_null']).optional(),
  nickname: filterOp(z.string(), ['eq', 'in', 'is_null']).optional(),
  q: z.string().optional().describe('Full-text LIKE over the contact display name (full_name).'),
  connected_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  last_check_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(),
  linkedin_connection_request_sid: filterOp(z.string(), ['eq', 'in', 'is_null']).optional()
    .describe('is_null:false ⇒ born from one of our outbound requests.'),
  linkedin_connection_invitation_sid: filterOp(z.string(), ['eq', 'in', 'is_null']).optional()
    .describe('is_null:false ⇒ born from an inbound invitation we accepted.'),
  removal_kind: filterOp(LinkedinConnectionRemovalKind, ['eq', 'ne', 'in', 'nin', 'is_null']).optional()
    .describe('is_null:true = live row; is_null:false = all churn; eq to split by reason.'),
  created_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  updated_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  deleted_at: filterOp(z.string(), ['is_null', 'gte', 'lte']).optional()
    .describe('Default scope is { is_null: true } (live rows).'),
}).partial();

const LinkedinConnectionInclude = z.enum([
  'linkedin_account',
  'linkedin_connection_request',
  'linkedin_connection_invitation',
  'conversations',
  'last_messages',
]);

const LinkedinConnectionSortable = z.enum([
  'connected_at', 'last_check_at', 'created_at', 'updated_at', 'deleted_at',
]);

const LinkedinConnectionGroupable = z.enum([
  'linkedin_account_sid',
  'removal_kind',
  'linkedin_connection_request_sid_present',
  'linkedin_connection_invitation_sid_present',
]);

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const SYNC = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const DANGER = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

const base = {
  service: 'linkedin',
  entity: 'linkedin_connections',
  mount: 'linkedin.network',
} as const;

export const linkedinConnectionsTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_linkedin_connections',
    description:
      "List an account's 1st-degree LinkedIn connections with filters, sorting, cursor pagination and full-text q over the contact name. Live rows by default (deleted_at.is_null:true); pass is_null:false for churn analysis. Returns a counts block of predicate tallies; include[] can eager-load linkedin_account, the source request/invitation, conversations and last_messages.",
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-connections/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    inputSchema: McpSearchRequestSchema(LinkedinConnectionFilter, LinkedinConnectionInclude, LinkedinConnectionSortable, 200),
    outputSchema: McpSearchResponse(LinkedinConnection, undefined, LinkedinConnectionCounts),
    annotations: { title: 'Search LinkedIn connections', ...RO },
  },
  {
    ...base,
    name: 'get_linkedin_connections_metrics',
    description:
      'Period-bound aggregates over a filtered connection set. Requires period {from,to} (≤ 90 days). Returns connections_growth, connections_removed, net_growth, reply_rate_within_connections, dormant_connections and avg_time_to_first_message. Optional filter and a single group_by axis.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-connections/metrics' },
    operation: 'metrics',
    envelope: 'metrics',
    availability: 'ga',
    dangerous: false,
    inputSchema: McpMetricsRequestSchema(LinkedinConnectionFilter).extend({
      period: z.object({
        from: z.string().describe('ISO 8601 UTC window start (inclusive).'),
        to: z.string().describe('ISO 8601 UTC window end (exclusive); must be after from.'),
      }).describe('Required metrics window [from, to).'),
      group_by: LinkedinConnectionGroupable.optional().describe('Optional single split axis.'),
    }),
    outputSchema: McpMetricsResponse(LinkedinConnectionMetrics),
    annotations: { title: 'LinkedIn connections metrics', ...RO },
  },
  {
    ...base,
    name: 'sync_my_linkedin_connections',
    description:
      'Kick off a full background connections sync for one account by inserting a sync_run (upsert-only: new/updated rows only, no removal detection). ASYNC: returns pending refs to poll or await the linkedin-connections.sync-completed webhook. For an in-request head refresh use get_my_latest_linkedin_connections instead.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-connections/sync-my-linkedin-connections' },
    operation: 'action',
    envelope: 'action_async',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ linkedin_account_sid: ACCOUNT_SID, ...usageMetaField }),
    outputSchema: McpAsyncActionResponse(LinkedinConnection),
    annotations: { title: 'Sync my connections', ...SYNC },
  },
  {
    ...base,
    name: 'get_my_latest_linkedin_connections',
    description:
      'Always-fresh head read: refresh the newest connections from LinkedIn in-request (§5.8), then return the last N (connected_at DESC) with a counts block. The first page (cursor null) triggers the refresh; continuation pages read the already-refreshed DB. Account-scoped. For richer slicing call search_linkedin_connections right after.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-connections/get-my-latest' },
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
    outputSchema: McpSearchResponse(LinkedinConnection, undefined, LinkedinConnectionCounts).extend({
      // §5.8 envelope-level refresh block, always present; first page (cursor
      // null) runs the LinkedIn-side refresh (performed:true + real stats),
      // continuation pages zero out (performed:false, stop_reason null).
      refresh: z.object({
        performed: z.boolean(),
        pages_fetched: z.number().int(),
        items_seen: z.number().int(),
        items_upserted: z.number().int(),
        stop_reason: z.enum(['overlap', 'covered', 'page_cap', 'exhausted']).nullable(),
      }),
    }),
    annotations: { title: 'Get my latest connections', ...RO },
  },
  {
    ...base,
    name: 'check_linkedin_connection_degree',
    description:
      "Probe one contact's current connection degree (1st / 2nd / 3rd / 4_plus) from a managed account, and actualize a stale stored row: a live connection whose degree is no longer 1st is soft-deleted (removal_kind=removed) in the same call. Reuses the get-lite-profile getter (owner-only: it runs on the account you name). Supply exactly one target identifier.",
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-connections/check-degree' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      linkedin_account_sid: ACCOUNT_SID,
      target: Target,
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(LinkedinConnection),
    annotations: { title: 'Check connection degree', ...SYNC },
  },
  {
    ...base,
    name: 'remove_linkedin_connection',
    description:
      'Disconnect a 1st-degree connection on LinkedIn (outward, destructive). Dispatches the remove-connection browser verb (networking_general bucket); on terminal success the local row is soft-deleted (removal_kind=removed) and linkedin-connections.removed is emitted. Identify the connection by its ln_cn_ sid.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-connections/{sid}/remove', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID,
      reason: z.string().max(255).nullable().optional()
        .describe('Free-form note on why the connection was removed; context for whoever reads the row later, never sent to LinkedIn.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(LinkedinConnection),
    annotations: { title: 'Remove connection', ...DANGER },
  },
];
