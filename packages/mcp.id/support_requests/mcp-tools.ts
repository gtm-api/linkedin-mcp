// Entity: SupportRequest (gtm.service.id)
// Source of truth: product/research/gtm.service.id/entities/support_requests.md
// Format: registry v2. Each tool carries route metadata so the generic
// dispatcher can drive it. 3 tools (the support-requests route group), mounted
// on id.platform. One row per escalation to a human; the write tool is named
// for the LLM's intent (escalate_to_human), not the CRUD verb. Rows are
// immutable after creation (no update/delete: audit trail).

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  AccessIdentityValueActorTypeEnum,
  filterOp,
  usageMetaField,
  McpCreateResponse,
  McpGetRequestSchema,
  McpGetResponse,
  McpSearchRequestSchema,
  McpSearchResponse,
} from '@gtm/mcp-shared';

const SupportRequestStatus = z.enum(['received', 'handed_off', 'handoff_failed']);
const SupportRequestSource = z.enum(['copilot', 'app']);
const SupportRequestReason = z.enum(['user_requested', 'copilot_unable', 'other']);

// Loose item / counts schemas: the full field set is tightened by the Stage-1
// contract tests against live envelopes; passthrough keeps live responses valid.
const SupportRequest = z.object({
  sid: z.string(),
  team_sid: z.string(),
  user_sid: z.string(),
  contact_email: z.string(),
  source: SupportRequestSource,
  reason: SupportRequestReason,
  subject: z.string(),
  // body is dropped from search rows server-side (present on get).
  body: z.string().optional(),
  copilot_session_sid: z.string().nullable(),
  status: SupportRequestStatus,
  intercom_ticket_id: z.string().nullable(),
  handed_off_at: z.string().nullable(),
  last_error: z.string().nullable(),
  created_by: z.object({
    actor_type: AccessIdentityValueActorTypeEnum,
    actor_sid: z.string(),
    team_sid: z.string(),
    permissions: z.record(z.unknown()),
    reason: z.string().nullable(),
  }).passthrough(),
  created_at: z.string(),
  updated_at: z.string(),
}).passthrough();

const SupportRequestCounts = z.object({}).passthrough();

const SupportRequestFilter = z.object({
  sid: filterOp(z.string(), ['eq', 'in']).optional(),
  team_sid: filterOp(z.string(), ['eq', 'in']).optional()
    .describe('Scoped by JWT; explicit override only for internal-support.'),
  user_sid: filterOp(z.string(), ['eq', 'in']).optional()
    .describe('The requester: "what did Jane escalate?".'),
  source: filterOp(SupportRequestSource, ['eq', 'in']).optional(),
  reason: filterOp(SupportRequestReason, ['eq', 'in']).optional(),
  status: filterOp(SupportRequestStatus, ['eq', 'in']).optional()
    .describe('received / handoff_failed = not yet in the support inbox.'),
  copilot_session_sid: filterOp(z.string(), ['eq', 'in', 'is_null']).optional()
    .describe('The copilot session an escalation came from.'),
  created_at: filterOp(z.string(), ['eq', 'gte', 'lte', 'gt', 'lt']).optional(),
  handed_off_at: filterOp(z.string(), ['eq', 'gte', 'lte', 'gt', 'lt', 'is_null']).optional(),
}).partial();

const SupportRequestSortable = z.enum(['created_at', 'handed_off_at', 'status']);

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const base = {
  service: 'id',
  entity: 'support_requests',
  mount: 'id.platform',
} as const;

export const supportRequestsTools: ToolDefinition[] = [
  {
    ...base,
    name: 'escalate_to_human',
    description:
      'Hand the current issue to the human support team. Records a durable support request and opens a ticket in the support inbox; the team replies to the user\'s account email. Use when the user explicitly asks for a human, or when you are confident you cannot resolve the issue (missing capability, repeated failed attempts), and only AFTER giving your best available answer. The response item\'s status says what happened: handed_off (in the support inbox), received (recorded; delivery pending configuration), handoff_failed (recorded; delivery will be re-driven by ops; do not tell the user it failed, the record exists either way). Compose `body` so the team can act WITHOUT the chat transcript: the user\'s ask in their own words, the concrete entities involved (sids/names), and what was already checked or tried. Retry-safe: the same subject from the same copilot session within 15 minutes returns the existing request (already_exists:true).',
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/support-requests' },
    operation: 'create',
    envelope: 'create',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: z.object({
      subject: z.string().min(3).max(255)
        .describe('One-line issue title, in the user\'s language.'),
      body: z.string().min(10).max(16000)
        .describe('The escalation the team will read: user\'s ask in their words + entities involved + what was tried. User\'s language for their words; English for the context block.'),
      reason: SupportRequestReason.optional()
        .describe('Default user_requested. Use copilot_unable when escalating on your own judgment.'),
      copilot_session_sid: z.string().length(18).startsWith('cp_ss_').optional()
        .describe('The current copilot session sid; pass it when escalating from a session (enables retry-dedup).'),
      ...usageMetaField,
    }),
    outputSchema: McpCreateResponse(SupportRequest),
    annotations: { title: 'Escalate to a human', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    ...base,
    name: 'search_support_requests',
    description:
      'List the team\'s support escalations with filtering, sorting and cursor pagination: the ops view ("what escalations are open?", "did this session already escalate?"). Returns a counts block of predicate tallies (by status / reason). Bodies are omitted from list rows; call get_support_request for the full text. No full-text search.',
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/support-requests/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: McpSearchRequestSchema(SupportRequestFilter, undefined, SupportRequestSortable)
      // The SearchRequest declares no include rule and the controller builds no
      // included block, so advertising the param would be a silent no-op.
      .omit({ include: true }),
    outputSchema: McpSearchResponse(SupportRequest, undefined, SupportRequestCounts),
    annotations: { title: 'Search support requests', ...RO },
  },
  {
    ...base,
    name: 'get_support_request',
    description:
      'Fetch a single support escalation by sid: the full body the team received, handoff state (intercom_ticket_id, handed_off_at) and the redacted delivery error if the handoff failed.',
    toolClass: 'trivial',
    route: { service: 'id', method: 'GET', pathTemplate: '/api/support-requests/{sid}', sidParam: 'sid' },
    operation: 'get',
    envelope: 'get',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: McpGetRequestSchema('id_sr_'),
    outputSchema: McpGetResponse(SupportRequest),
    annotations: { title: 'Get support request', ...RO },
  },
];
