// Entity: LinkedIn Connection Request (gtm.service.linkedin)
// Source of truth: product/research/gtm.service.linkedin/entities/linkedin_connection_requests.md
// Format: registry v2, where each tool carries route metadata so the generic
// dispatcher can drive it. 6 tools (the linkedin-connection-requests route
// group), mounted on linkedin.network.

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

const SID = z.string().length(18).startsWith('ln_cr_')
  .describe('LinkedIn connection-request sid (ln_cr_…).');
const ACCOUNT_SID = z.string().length(18).startsWith('ln_ac_')
  .describe('LinkedIn account sid (ln_ac_…) of the sending account.');

const LinkedinConnectionRequestRemovalKind = z.enum(['accepted', 'withdrawn', 'expired']);

// Item projection: every field of LinkedinConnectionRequestDomain (research §Domain).
// Base scalar columns are always serialized (present keys; only nullable when the
// Domain type is `| null`); .passthrough() keeps forward-compat keys valid.
const LinkedinConnectionRequest = z.object({
  sid: z.string(),
  team_sid: z.string(),
  linkedin_account_sid: z.string(),
  ln_member_id: z.string(),
  ln_id: z.string().nullable(),
  sn_id: z.string().nullable(),
  nickname: z.string().nullable(),
  note: z.string().nullable(),
  sent_at: z.string().nullable(), // NULL = send time unknown (sync-picked-up UI invitations; LinkedIn omits the send time)
  invitation_id: z.string().nullable(),
  resend_available_at: z.string().nullable(),
  last_check_at: z.string().nullable(),
  removal_kind: LinkedinConnectionRequestRemovalKind.nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
}).passthrough();

// Metrics: concrete shape per research §metrics. passthrough for forward-compat.
const LinkedinConnectionRequestMetrics = z.object({
  avg_note_length_of_accepted: z.number().nullable(),
  avg_time_to_accept_seconds: z.number().nullable(),
}).passthrough();

const LinkedinConnectionRequestFilter = z.object({
  sid: filterOp(z.string(), ['eq', 'in']).optional(),
  linkedin_account_sid: filterOp(z.string(), ['eq', 'in']).optional(),
  // ln_id / sn_id are URN-decoded to a ln_member_id match by the Service's
  // applyFieldFilter override, which only reads .eq / .in; ne/nin/is_null on
  // these two columns would silently return UNFILTERED, so they are not offered.
  ln_id: filterOp(z.string(), ['eq', 'in']).optional(),
  ln_member_id: filterOp(z.string(), ['eq', 'ne', 'in', 'nin', 'is_null']).optional(),
  sn_id: filterOp(z.string(), ['eq', 'in']).optional(),
  nickname: filterOp(z.string(), ['eq', 'in', 'is_null']).optional(),
  removal_kind: filterOp(LinkedinConnectionRequestRemovalKind, ['eq', 'ne', 'in', 'nin', 'is_null']).optional()
    .describe('is_null:true = pending; eq to split accepted / withdrawn / expired.'),
  sent_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(), // nullable: sync rows with unknown send time
  resend_available_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(),
  created_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  updated_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  deleted_at: filterOp(z.string(), ['is_null', 'gte', 'lte']).optional()
    .describe('Default scope is { is_null: true } (pending rows).'),
}).partial();

// METRICS takes ONE axis, and that narrowness is the contract rather than an
// oversight. LinkedinConnectionRequestService::metrics() builds no
// LinkedinConnectionRequestFilter: it reads filter.linkedin_account_sid off the
// input, bounds created_at by the period and aggregates. Any other axis offered
// here would be accepted and then dropped by the aggregation, so the agent would
// read unfiltered numbers as the answer to a filtered question and have no way
// to tell. Slice the other dimensions with search instead.
const LinkedinConnectionRequestMetricsFilter = LinkedinConnectionRequestFilter
  .pick({ linkedin_account_sid: true });

const LinkedinConnectionRequestInclude = z.enum(['linkedin_account']);

const LinkedinConnectionRequestSortable = z.enum([
  'sent_at', 'resend_available_at', 'deleted_at', 'created_at',
]);

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const SYNC = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const DANGER = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
const DANGER_ONCE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

const base = {
  service: 'linkedin',
  entity: 'linkedin_connection_requests',
  mount: 'linkedin.network',
} as const;

export const linkedinConnectionRequestsTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_linkedin_connection_requests',
    description:
      'List outbound LinkedIn connection requests (invitations we sent) with filters, sorting, cursor pagination and full-text q over the note. Pending rows have removal_kind IS NULL; terminal rows are accepted / withdrawn / expired (deleted_at set). include[] can eager-load linkedin_account.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-connection-requests/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    inputSchema: McpSearchRequestSchema(LinkedinConnectionRequestFilter, LinkedinConnectionRequestInclude, LinkedinConnectionRequestSortable, 200),
    outputSchema: McpSearchResponse(LinkedinConnectionRequest),
    annotations: { title: 'Search connection requests', ...RO },
  },
  {
    ...base,
    name: 'get_linkedin_connection_requests_metrics',
    description:
      'Period-bound aggregates over one account\'s sent requests. Requires period {from,to} and filter.linkedin_account_sid (.eq or .in) - that is the ONLY filter axis the aggregation applies, unlike search. Returns avg_note_length_of_accepted and avg_time_to_accept_seconds; acceptance / withdraw / expiry rates are derived client-side from the counts block.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-connection-requests/metrics' },
    operation: 'metrics',
    envelope: 'metrics',
    availability: 'ga',
    dangerous: false,
    inputSchema: McpMetricsRequestSchema(LinkedinConnectionRequestMetricsFilter).extend({
      period: z.object({
        from: z.string().describe('ISO 8601 UTC window start (inclusive).'),
        to: z.string().describe('ISO 8601 UTC window end (exclusive); must be after from.'),
      }).describe('Required metrics window [from, to).'),
    }),
    outputSchema: McpMetricsResponse(LinkedinConnectionRequestMetrics),
    annotations: { title: 'Connection requests metrics', ...RO },
  },
  {
    ...base,
    name: 'send_linkedin_connection_request',
    description:
      'Send one outbound LinkedIn connection request (outward action). profile_id is the target URN (ln_id OR sn_id). Server-side checks run first: the daily send limit, the premium-aware note cap (200 free / 300 premium), and the 21-day resend cooldown. Fire-on-success: a row is created only when LinkedIn confirms the send. NOT idempotent: a second send while a request is pending 409s (already_pending).',
    toolClass: 'complex',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-connection-requests/send' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    massAction: false,
    stepEligible: true,
    scheduleRequired: false,
    inputSchema: z.object({
      linkedin_account_sid: ACCOUNT_SID,
      profile_id: z.string().describe('Target URN: ln_id (ACoAA…) OR sn_id (ACwAA…); both accepted as profile_id.'),
      note: z.string().max(300).nullable().optional()
        .describe('Invitation note; server caps at 200 chars when the sender is not premium. Over the cap it is 422 unless allow_no_note_fallback is set.'),
      allow_no_note_fallback: z.boolean().optional()
        .describe("Default false. When the note is longer than the sender's cap (200 free / 300 premium), send the invite WITHOUT it instead of refusing 422, for campaigns where reaching the person beats personalizing. The response says which happened in result.note_fallback_used, and the stored row carries note=null, so a follow-up does not assume a note the prospect never saw. Scope, stated plainly: this covers the length cap, which the server evaluates itself. LinkedIn's own monthly with-note quota is only visible at send time and arrives untyped, so a refusal there still fails the call rather than being retried blind (a retry after an ambiguous send can invite the person twice)."),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(LinkedinConnectionRequest),
    annotations: { title: 'Send connection request', ...DANGER_ONCE },
  },
  {
    ...base,
    name: 'sync_linkedin_connection_requests',
    description:
      'Refresh the outbound sent-invitations snapshot for one account by inserting a sync_run (upsert-only). ASYNC: returns pending refs to poll or await the linkedin-connection-requests.sync-completed webhook.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-connection-requests/sync-linkedin-connection-requests' },
    operation: 'action',
    envelope: 'action_async',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ linkedin_account_sid: ACCOUNT_SID, ...usageMetaField }),
    outputSchema: McpAsyncActionResponse(LinkedinConnectionRequest),
    annotations: { title: 'Sync connection requests', ...SYNC },
  },
  {
    ...base,
    name: 'get_my_latest_linkedin_connection_requests',
    description:
      'Always-fresh head read of pending outbound requests: refresh the newest from LinkedIn in-request (§5.8), then return the last N (sent_at DESC). The first page (cursor null) triggers the refresh; continuation pages read the already-refreshed DB. Account-scoped.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-connection-requests/get-my-latest' },
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
    outputSchema: McpSearchResponse(LinkedinConnectionRequest),
    annotations: { title: 'Get my latest connection requests', ...RO },
  },
  {
    ...base,
    name: 'withdraw_linkedin_connection_request',
    description:
      'Withdraw a pending outbound connection request (outward, destructive). Dispatches the withdraw-invitation browser verb (networking_general bucket); on terminal success the row is soft-deleted (removal_kind=withdrawn) and a 21-day resend cooldown begins. Identify the request by its ln_cr_ sid.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-connection-requests/{sid}/withdraw', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: SID, ...usageMetaField }),
    outputSchema: McpActionResponse(LinkedinConnectionRequest),
    annotations: { title: 'Withdraw connection request', ...DANGER },
  },
];
