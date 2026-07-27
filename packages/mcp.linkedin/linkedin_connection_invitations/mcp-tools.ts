// Entity: LinkedIn Connection Invitation (gtm.service.linkedin)
// Source of truth: product/research/gtm.service.linkedin/entities/linkedin_connection_invitations.md
// Format: registry v2, where each tool carries route metadata so the generic
// dispatcher can drive it. 6 tools (the linkedin-connection-invitations route
// group, the inbound side), mounted on linkedin.network.

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

const SID = z.string().length(18).startsWith('ln_ci_')
  .describe('LinkedIn connection-invitation sid (ln_ci_…).');
const ACCOUNT_SID = z.string().length(18).startsWith('ln_ac_')
  .describe('LinkedIn account sid (ln_ac_…) of the receiving account.');

const LinkedinConnectionInvitationRemovalKind = z.enum(['accepted', 'ignored', 'expired']);

// Item projection: every field of LinkedinConnectionInvitationDomain (research §Domain).
// Base scalar columns are always serialized (present keys; only nullable when the
// Domain type is `| null`); .passthrough() keeps forward-compat keys valid.
// `shared_secret` is masked by the backend on /api reads (still a present key).
const LinkedinConnectionInvitation = z.object({
  sid: z.string(),
  team_sid: z.string(),
  linkedin_account_sid: z.string(),
  ln_member_id: z.string(),
  ln_id: z.string().nullable(),
  sn_id: z.string().nullable(),
  nickname: z.string().nullable(),
  note: z.string().nullable(),
  linkedin_invitation_id: z.string().nullable(),
  shared_secret: z.string().nullable(),
  received_at: z.string(),
  last_check_at: z.string().nullable(),
  removal_kind: LinkedinConnectionInvitationRemovalKind.nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
}).passthrough();

// Metrics: concrete shape per research §metrics. passthrough for forward-compat.
const LinkedinConnectionInvitationMetrics = z.object({
  avg_time_to_triage_seconds: z.number().nullable(),
}).passthrough();

const LinkedinConnectionInvitationFilter = z.object({
  sid: filterOp(z.string(), ['eq', 'in']).optional(),
  linkedin_account_sid: filterOp(z.string(), ['eq', 'in']).optional(),
  ln_id: filterOp(z.string(), ['eq', 'ne', 'in', 'nin', 'is_null']).optional(),
  ln_member_id: filterOp(z.string(), ['eq', 'ne', 'in', 'nin', 'is_null']).optional(),
  sn_id: filterOp(z.string(), ['eq', 'ne', 'in', 'nin', 'is_null']).optional(),
  nickname: filterOp(z.string(), ['eq', 'in', 'is_null']).optional(),
  note: filterOp(z.string(), ['eq', 'in', 'is_null']).optional()
    .describe('Exact-match on the accompanying note (is_null:false = invitation carries a note). There is no free-text q on this entity.'),
  removal_kind: filterOp(LinkedinConnectionInvitationRemovalKind, ['eq', 'ne', 'in', 'nin', 'is_null']).optional()
    .describe('is_null:true = pending; eq to split accepted / ignored / expired.'),
  received_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  last_check_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(),
  created_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  updated_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  deleted_at: filterOp(z.string(), ['is_null', 'gte', 'lte']).optional()
    .describe('Default scope is { is_null: true } (pending rows).'),
}).partial();

const LinkedinConnectionInvitationInclude = z.enum(['linkedin_account']);

const LinkedinConnectionInvitationSortable = z.enum([
  'received_at', 'last_check_at', 'created_at', 'updated_at', 'deleted_at',
]);

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const SYNC = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const DANGER = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

const base = {
  service: 'linkedin',
  entity: 'linkedin_connection_invitations',
  mount: 'linkedin.network',
} as const;

export const linkedinConnectionInvitationsTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_linkedin_connection_invitations',
    description:
      'List inbound LinkedIn connection invitations we received, with filters (including an exact-match note filter; there is no free-text q on this entity), sorting and cursor pagination. Pending rows have removal_kind IS NULL; terminal rows are accepted / ignored / expired (deleted_at set). include[] can eager-load linkedin_account.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-connection-invitations/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: McpSearchRequestSchema(LinkedinConnectionInvitationFilter, LinkedinConnectionInvitationInclude, LinkedinConnectionInvitationSortable, 200),
    outputSchema: McpSearchResponse(LinkedinConnectionInvitation),
    annotations: { title: 'Search connection invitations', ...RO },
  },
  {
    ...base,
    name: 'get_linkedin_connection_invitations_metrics',
    description:
      'Period-bound aggregates over a filtered invitation set (filter must scope an account). Requires period {from,to}. Returns avg_time_to_triage_seconds; acceptance / ignore rates are derived client-side from the counts block.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-connection-invitations/metrics' },
    operation: 'metrics',
    envelope: 'metrics',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: McpMetricsRequestSchema(LinkedinConnectionInvitationFilter).extend({
      period: z.object({
        from: z.string().describe('ISO 8601 UTC window start (inclusive).'),
        to: z.string().describe('ISO 8601 UTC window end (exclusive); must be after from.'),
      }).describe('Required metrics window [from, to).'),
    }),
    outputSchema: McpMetricsResponse(LinkedinConnectionInvitationMetrics),
    annotations: { title: 'Connection invitations metrics', ...RO },
  },
  {
    ...base,
    name: 'sync_my_linkedin_connection_invitations',
    description:
      'Kick off a fresh inbound-invitations sync for one account by inserting a sync_run. ASYNC: returns pending refs to poll or await the linkedin-connection-invitations.sync-completed webhook.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-connection-invitations/sync-my-linkedin-connection-invitations' },
    operation: 'action',
    envelope: 'action_async',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ linkedin_account_sid: ACCOUNT_SID, ...usageMetaField }),
    outputSchema: McpAsyncActionResponse(LinkedinConnectionInvitation),
    annotations: { title: 'Sync connection invitations', ...SYNC },
  },
  {
    ...base,
    name: 'get_my_latest_linkedin_connection_invitations',
    description:
      'Always-fresh head read of pending inbound invitations: refresh the newest from LinkedIn in-request (§5.8), then return the last N (received_at DESC). The first page (cursor null) triggers the refresh; continuation pages read the already-refreshed DB. Account-scoped, non-creditable.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-connection-invitations/get-my-latest' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: z.object({
      linkedin_account_sid: ACCOUNT_SID,
      page_size: z.number().int().min(1).max(100).optional()
        .describe('Freshest rows to return / refresh coverage target (1..100, default 50).'),
      cursor: z.string().nullable().optional()
        .describe('Opaque forward cursor; the LinkedIn-side refresh runs only on the first page (cursor null).'),
      ...usageMetaField,
    }),
    // §5.8 head-refresh stats appended top-level by AppendsLatestRefresh.
    // performed=false on cursor-continuation pages (stats zero out, stop_reason null).
    outputSchema: McpSearchResponse(LinkedinConnectionInvitation).extend({
      refresh: z.object({
        performed: z.boolean(),
        pages_fetched: z.number().int(),
        items_seen: z.number().int(),
        items_upserted: z.number().int(),
        stop_reason: z.string().nullable(),
      }).describe('§5.8 in-request refresh outcome (first page runs the LinkedIn refresh; continuation pages report performed=false).'),
    }),
    annotations: { title: 'Get my latest connection invitations', ...RO },
  },
  {
    ...base,
    name: 'accept_linkedin_connection_invitation',
    description:
      'Accept one inbound connection invitation (outward action). On terminal success the invitation row is soft-deleted (removal_kind=accepted) and a linkedin-connections row is created for the new 1st-degree edge. Identify the invitation by its ln_ci_ sid.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-connection-invitations/{sid}/accept', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: SID, ...usageMetaField }),
    outputSchema: McpActionResponse(LinkedinConnectionInvitation),
    annotations: { title: 'Accept connection invitation', ...DANGER },
  },
  {
    ...base,
    name: 'ignore_linkedin_connection_invitation',
    description:
      'Ignore one inbound connection invitation (outward action). On terminal success the invitation row is soft-deleted (removal_kind=ignored); no connection is created. Identify the invitation by its ln_ci_ sid.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-connection-invitations/{sid}/ignore', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: SID, ...usageMetaField }),
    outputSchema: McpActionResponse(LinkedinConnectionInvitation),
    annotations: { title: 'Ignore connection invitation', ...DANGER },
  },
];
