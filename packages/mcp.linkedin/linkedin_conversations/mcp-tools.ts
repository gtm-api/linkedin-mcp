// Entity: LinkedIn Conversation (gtm.service.linkedin)
// Source of truth: product/research/gtm.service.linkedin/entities/linkedin_conversations.md
// Format: registry v2, where each tool carries route metadata so the generic
// dispatcher can drive it. 10 tools (the linkedin-conversations route group);
// they share the /mcp/linkedin/messaging mount with linkedin-messages.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  filterOp,
  usageMetaField,
  McpActionResponse,
  McpAsyncActionResponse,
  McpGetRequestSchema,
  McpGetResponse,
  McpMetricsResponse,
  McpSearchRequestSchema,
  McpSearchResponse,
} from '@gtm/mcp-shared';

const SID = z.string().length(18).startsWith('ln_cv_')
  .describe('LinkedIn conversation sid (ln_cv_…).');
const ACCOUNT_SID = z.string().length(18).startsWith('ln_ac_')
  .describe('LinkedIn account sid (ln_ac_…).');

const MessengerType = z.enum(['linkedin', 'sales_navigator'])
  .describe('Messenger surface: basic LinkedIn messenger or Sales Navigator.');

// Metrics window: required half-open [from, to), ≤ 90 days.
const Period = z.object({
  from: z.string().datetime().describe('ISO 8601 UTC start (inclusive).'),
  to: z.string().datetime().describe('ISO 8601 UTC end (exclusive); must be after from; window ≤ 90 days.'),
}).describe('Metrics time window.');

// Item projection: every field of LinkedinConversationDomain (research §Domain).
// Base scalar/JSON columns are always serialized (present keys; only nullable when
// the Domain type is `| null`); .passthrough() keeps forward-compat keys valid.
const LinkedinConversation = z.object({
  sid: z.string(),
  team_sid: z.string(),
  linkedin_account_sid: z.string(),
  conversation_hash: z.string(),
  messenger_type: MessengerType,
  ln_member_id: z.string().nullable(),
  ln_id: z.string().nullable(),
  sn_id: z.string().nullable(),
  nickname: z.string().nullable(),
  // Denormalized attendee list (JSON [ro]); NULL for group/system threads never populated.
  // Each participant field is documented optional; kept nullable+optional for live JSON.
  participants: z.array(z.object({
    ln_member_id: z.string().nullable().optional(),
    ln_id: z.string().nullable().optional(),
    sn_id: z.string().nullable().optional(),
    nickname: z.string().nullable().optional(),
    full_name: z.string().nullable().optional(),
    headline: z.string().nullable().optional(),
    picture_url: z.string().nullable().optional(),
  }).passthrough()).nullable(),
  // [ro]: notifications muted on LinkedIn (raw notificationStatus === "MUTE"); synced from the
  // basic get-conversations wire and optimistically mirrored by the mute verb. NULL = unknown /
  // never synced (Sales Navigator threads never carry it).
  is_muted: z.boolean().nullable(),
  event_count: z.number(),
  last_activity_at: z.string().nullable(),
  last_stored_message_at: z.string().nullable(),
  last_message_sync_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
}).passthrough();

// Period-bound metrics (declared in research §metrics; both always present, int >= 0).
const LinkedinConversationMetrics = z.object({
  new_conversations_count: z.number().int(),
  active_count: z.number().int(),
}).passthrough();

const LinkedinConversationIncludeEnum = z.enum(['linkedin_account', 'last_messages']);
const LinkedinConversationSortableFieldEnum = z.enum([
  'last_activity_at',
  'event_count',
  'last_message_sync_at',
]);
const LinkedinConversationGroupableFields = z.enum([
  'messenger_type',
  'linkedin_account_sid',
]).describe('Field to group metrics by. One field per request.');

const LinkedinConversationFilter = z.object({
  q: z.string().describe('Full-text LIKE over nickname (the only free-text column).'),
  sid: filterOp(z.string(), ['eq', 'in']),
  linkedin_account_sid: filterOp(z.string(), ['eq', 'in']),
  messenger_type: filterOp(MessengerType, ['eq', 'ne', 'in', 'nin']),
  conversation_hash: filterOp(z.string(), ['eq', 'in']),
  ln_id: filterOp(z.string(), ['eq', 'ne', 'in', 'nin', 'is_null']),
  ln_member_id: filterOp(z.string(), ['eq', 'ne', 'in', 'nin', 'is_null']),
  sn_id: filterOp(z.string(), ['eq', 'ne', 'in', 'nin', 'is_null']),
  nickname: filterOp(z.string(), ['eq', 'in', 'is_null']),
  is_muted: filterOp(z.boolean(), ['eq', 'ne', 'is_null']),
  event_count: filterOp(z.number().int(), ['eq', 'ne', 'gte', 'lte', 'gt', 'lt']),
  last_activity_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']),
  last_stored_message_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']),
  last_message_sync_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']),
  created_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']),
  updated_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']),
  deleted_at: filterOp(z.string(), ['is_null', 'gte', 'lte']),
}).partial();

// METRICS takes ONE axis, and that narrowness is the contract rather than an
// oversight. LinkedinConversationService::metrics() builds no
// LinkedinConversationFilter: it reads filter.linkedin_account_sid off the
// input, bounds created_at by the period and aggregates. Any other axis offered
// here would be accepted and then dropped by the aggregation, so the agent would
// read unfiltered numbers as the answer to a filtered question and have no way
// to tell. Slice the other dimensions with search instead.
const LinkedinConversationMetricsFilter = LinkedinConversationFilter
  .pick({ linkedin_account_sid: true });

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const ACT = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DANGER = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

const base = {
  service: 'linkedin',
  entity: 'linkedin_conversations',
  mount: 'linkedin.messaging',
} as const;

export const linkedinConversationsTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_linkedin_conversations',
    description:
      'List LinkedIn message threads for the team across both messenger surfaces (basic LinkedIn + Sales Navigator) with operator-object filters (account, contact ids, messenger_type, event-count, activity / message-sync clock ranges), sort, cursor pagination, and include[] for the parent account and the last 50 messages. Live rows by default; page_size:0 for count-only.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-conversations/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: McpSearchRequestSchema(LinkedinConversationFilter, LinkedinConversationIncludeEnum, LinkedinConversationSortableFieldEnum, 200),
    outputSchema: McpSearchResponse(LinkedinConversation),
    annotations: { title: 'Search LinkedIn conversations', ...RO },
  },
  {
    ...base,
    name: 'get_linkedin_conversation',
    description:
      'Fetch one conversation by sid: the stored row including the denormalized participants list. Stored-DB read: no plugin call, no limit spend.',
    toolClass: 'trivial',
    route: { service: 'linkedin', method: 'GET', pathTemplate: '/api/linkedin-conversations/{sid}', sidParam: 'sid' },
    operation: 'get',
    envelope: 'get',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: McpGetRequestSchema('ln_cv_', LinkedinConversationIncludeEnum),
    outputSchema: McpGetResponse(LinkedinConversation),
    annotations: { title: 'Get LinkedIn conversation', ...RO },
  },
  {
    ...base,
    name: 'get_linkedin_conversations_metrics',
    description:
      'Period-bound conversation aggregates for one account (new_conversations_count, active_count) with an optional group_by axis. Requires period {from,to} (≤ 90 days) and filter.linkedin_account_sid - that is the ONLY filter axis the aggregation applies, unlike search. Returns the counts block alongside.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-conversations/metrics' },
    operation: 'metrics',
    envelope: 'metrics',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: z.object({
      filter: LinkedinConversationMetricsFilter.describe('Row scope; linkedin_account_sid is REQUIRED (422 without it).'),
      period: Period,
      group_by: LinkedinConversationGroupableFields.optional().describe('Optional single split axis.'),
      ...usageMetaField,
    }),
    outputSchema: McpMetricsResponse(LinkedinConversationMetrics),
    annotations: { title: 'Get LinkedIn conversations metrics', ...RO },
  },
  {
    ...base,
    name: 'sync_my_linkedin_conversations',
    description:
      'Start a background sync run that reconciles the full basic-LinkedIn-messenger thread directory for one account. ASYNC: returns a pending ref (sync_run_sid) to poll; changed threads have their messages pulled inline. Use for initial backfill / full reconciliation; for a fresh inbox head use get_my_latest_linkedin_conversations.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-conversations/sync-my-linkedin-conversations' },
    operation: 'action',
    envelope: 'action_async',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ linkedin_account_sid: ACCOUNT_SID, ...usageMetaField }),
    outputSchema: McpAsyncActionResponse(LinkedinConversation),
    annotations: { title: 'Sync my LinkedIn conversations', ...ACT },
  },
  {
    ...base,
    name: 'sync_my_sales_navigator_conversations',
    description:
      'Start a background sync run that reconciles the full Sales Navigator thread directory for one account. ASYNC: returns a pending ref to poll. Separate sync_type and cadence from the basic-LinkedIn sync so SN-only lanes never touch basic-messenger rate limits.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-conversations/sync-my-sales-navigator-conversations' },
    operation: 'action',
    envelope: 'action_async',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ linkedin_account_sid: ACCOUNT_SID, ...usageMetaField }),
    outputSchema: McpAsyncActionResponse(LinkedinConversation),
    annotations: { title: 'Sync my Sales Navigator conversations', ...ACT },
  },
  {
    ...base,
    name: 'get_my_latest_linkedin_conversations',
    description:
      "Always-fresh head read of the basic-LinkedIn-messenger thread list for one account (§5.8 foreground refresh, then the last N threads from the refreshed DB, last_activity_at DESC). Never serves stale data: it 429s with bucket_saturated / sync_in_progress instead. Use before an inbox decision; use sync_my_linkedin_conversations for full backfill.",
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-conversations/get-my-latest' },
    operation: 'action',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      linkedin_account_sid: ACCOUNT_SID,
      page_size: z.number().int().min(1).max(100).optional().describe('N returned, 1..100, default 50.'),
      cursor: z.string().nullable().optional().describe('Opaque; pagination over the refreshed head.'),
      ...usageMetaField,
    }),
    outputSchema: McpSearchResponse(LinkedinConversation),
    annotations: { title: 'Get my latest LinkedIn conversations', ...ACT },
  },
  {
    ...base,
    name: 'get_my_latest_linkedin_conversations_sales_nav',
    description:
      "Sales Navigator variant of get_my_latest_linkedin_conversations: always-fresh head read of the SN thread list for one account (§5.8 refresh-then-return). Same hard-429 guards; returns messenger_type='sales_navigator' rows.",
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-conversations/get-my-latest-sales-nav' },
    operation: 'action',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      linkedin_account_sid: ACCOUNT_SID,
      page_size: z.number().int().min(1).max(100).optional().describe('N returned, 1..100, default 50.'),
      cursor: z.string().nullable().optional().describe('Opaque; pagination over the refreshed head.'),
      ...usageMetaField,
    }),
    outputSchema: McpSearchResponse(LinkedinConversation),
    annotations: { title: 'Get my latest Sales Navigator conversations', ...ACT },
  },
  {
    ...base,
    name: 'mark_linkedin_conversation_read',
    description:
      "Mark a conversation thread as read on LinkedIn's side (outward action). LinkedIn-side effect only, no stored read-state changes; the audit rides an activity-log row. Idempotent; safe to retry.",
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-conversations/{sid}/mark-read', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: SID, ...usageMetaField }),
    outputSchema: McpActionResponse(LinkedinConversation),
    annotations: { title: 'Mark conversation read', ...DANGER },
  },
  {
    ...base,
    name: 'mark_linkedin_conversation_unread',
    description:
      "Mark a conversation thread as unread on LinkedIn's side (outward action), the hand-back-to-human signal after an agent triaged a thread. LinkedIn-side effect only; no stored read-state changes.",
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-conversations/{sid}/mark-unread', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: SID, ...usageMetaField }),
    outputSchema: McpActionResponse(LinkedinConversation),
    annotations: { title: 'Mark conversation unread', ...DANGER },
  },
  {
    ...base,
    name: 'mute_linkedin_conversation',
    description:
      "Mute or unmute one thread's notifications on LinkedIn (outward action). Pass the conversation sid + mute (true = mute, default; false = unmute); the change is dispatched to LinkedIn and mirrored on the stored row.",
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-conversations/{sid}/mute', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID,
      mute: z.boolean().optional().describe('true = mute (default), false = unmute.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(LinkedinConversation),
    annotations: { title: 'Mute conversation', ...DANGER },
  },
  {
    ...base,
    name: 'add_linkedin_conversation_participants',
    description:
      'Add one or more members to an existing thread on LinkedIn (outward action). Pass the conversation sid + participant_ln_ids (1..20 member URNs); a 1:1 thread is promoted to a group. Returns the updated conversation.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-conversations/{sid}/add-participants', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID,
      participant_ln_ids: z.array(z.string().min(1).max(64)).min(1).max(20).describe('Member URNs to add (1..20).'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(LinkedinConversation),
    annotations: { title: 'Add conversation participants', ...DANGER },
  },
  {
    ...base,
    name: 'remove_linkedin_conversation_participants',
    description:
      'Remove one or more members from a group thread on LinkedIn (outward action). Pass the conversation sid + participant_ln_ids (1..20 member URNs to remove). Returns the updated conversation.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-conversations/{sid}/remove-participants', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID,
      participant_ln_ids: z.array(z.string().min(1).max(64)).min(1).max(20).describe('Member URNs to remove (1..20).'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(LinkedinConversation),
    annotations: { title: 'Remove conversation participants', ...DANGER },
  },
  {
    ...base,
    name: 'rename_linkedin_conversation',
    description:
      'Rename a group thread on LinkedIn (outward action). Pass the conversation sid + the new title (1..256 chars). Returns the updated conversation.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-conversations/{sid}/rename', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID,
      title: z.string().min(1).max(256).describe('New group thread title (1..256 chars).'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(LinkedinConversation),
    annotations: { title: 'Rename conversation', ...DANGER },
  },
];
