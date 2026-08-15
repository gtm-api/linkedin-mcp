// Entity: Notification (gtm.service.id)
// Source of truth: product/research/gtm.service.id/entities/notifications.md
// Format: registry v2. Each tool carries route metadata so the generic
// dispatcher can drive it. 4 tools (the notifications route group), mounted on
// id.platform. One row per email notification; born from domain events via the
// internal dispatch path (create/update are `not supported`, so no MCP tool).

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  AccessIdentityValueActorTypeEnum,
  filterOp,
  McpGetRequestSchema,
  McpGetResponse,
  McpMetricsRequestSchema,
  McpMetricsResponse,
  McpSearchRequestSchema,
  McpSearchResponse,
  McpSimpleDeleteRequestSchema,
  McpSimpleDeleteResponse,
} from '@gtm/mcp-shared';

const NotificationStatus = z.enum(['pending', 'delivered', 'failed']);
const NotificationChannel = z.enum(['email', 'in_app']);

// Loose item / counts / metrics schemas: the full field set is tightened by the
// Stage-1 contract tests against live envelopes; passthrough keeps live responses
// valid. `body_html` / `body_text` are dropped from search rows server-side.
const Notification = z.object({
  sid: z.string(),
  team_sid: z.string(),
  user_sid: z.string().nullable(),
  event_name: z.string(),
  event_sid: z.string(),
  entity_sid: z.string().nullable(),
  channel: NotificationChannel,
  status: NotificationStatus,
  subject: z.string(),
  // body_html / body_text are dropped from search rows server-side (present on get).
  body_html: z.string().optional(),
  body_text: z.string().optional(),
  rate_limit_bucket: z.string(),
  scheduled_at: z.string(),
  delivered_at: z.string().nullable(),
  failed_at: z.string().nullable(),
  failure_reason: z.string().nullable(),
  retry_count: z.number(),
  // Shared AccessIdentityValue (general/KNOWLEDGE.md); passthrough tolerates
  // cross-service serialization drift.
  created_by: z.object({
    actor_type: AccessIdentityValueActorTypeEnum,
    actor_sid: z.string(),
    team_sid: z.string(),
    permissions: z.record(z.unknown()),
    request_sid: z.string().nullable().optional(),
    reason: z.string().nullable(),
  }).passthrough(),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
}).passthrough();

const NotificationCounts = z.object({}).passthrough();
const NotificationMetrics = z.object({}).passthrough();

const NotificationFilter = z.object({
  sid: filterOp(z.string(), ['eq', 'in']).optional(),
  team_sid: filterOp(z.string(), ['eq', 'in']).optional()
    .describe('Scoped by JWT; explicit override only for internal-support.'),
  user_sid: filterOp(z.string(), ['eq', 'in']).optional()
    .describe('Recipient: "show me Joe\'s notifications".'),
  event_name: filterOp(z.string(), ['eq', 'in']).optional()
    .describe('e.g. linkedin-accounts.logged-out.'),
  entity_sid: filterOp(z.string(), ['eq', 'in', 'is_null']).optional()
    .describe('The domain entity a notification is about (e.g. a linkedin_account sid).'),
  status: filterOp(NotificationStatus, ['eq', 'in']).optional(),
  channel: filterOp(NotificationChannel, ['eq']).optional(),
  scheduled_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  delivered_at: filterOp(z.string(), ['is_null', 'gte', 'lte']).optional()
    .describe('is_null:true = not yet delivered.'),
  failed_at: filterOp(z.string(), ['is_null', 'gte', 'lte']).optional(),
  created_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  deleted_at: filterOp(z.string(), ['is_null', 'gte', 'lte']).optional()
    .describe('Default scope is { is_null: true } (undismissed rows).'),
}).partial();

const NotificationSortable = z.enum(['created_at', 'scheduled_at', 'delivered_at']);
const NotificationGroupable = z.enum(['event_name', 'status', 'channel']);

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const DANGER = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

const base = {
  service: 'id',
  entity: 'notifications',
  mount: 'id.platform',
} as const;

export const notificationsTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_notifications',
    description:
      'List notifications (email and in_app channels) for the team/user with filtering, sorting and cursor pagination: the user inbox ("what was sent to me?"), admin audit ("what did the system email Jane about?"), or failure triage (status:failed in the last 24h). No full-text search. Returns a counts block of predicate tallies (by status / event_name / channel). Bodies are omitted from list rows; call get_notification for the rendered body.',
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/notifications/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    inputSchema: McpSearchRequestSchema(NotificationFilter, undefined, NotificationSortable)
      // The SearchRequest declares no include rule and the controller builds no
      // included block, so advertising the param would be a silent no-op.
      .omit({ include: true }),
    outputSchema: McpSearchResponse(Notification, undefined, NotificationCounts),
    annotations: { title: 'Search notifications', ...RO },
  },
  {
    ...base,
    name: 'get_notifications_metrics',
    description:
      'Period-bound delivery-health aggregates over a filtered notification set: how many notifications were delivered, failed, and rate-limited in the window. Requires period {from,to}. Optional filter and a single group_by axis (event_name / status / channel).',
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/notifications/metrics' },
    operation: 'metrics',
    envelope: 'metrics',
    availability: 'ga',
    dangerous: false,
    inputSchema: McpMetricsRequestSchema(NotificationFilter).extend({
      period: z.object({
        from: z.string().describe('ISO 8601 UTC window start (inclusive).'),
        to: z.string().describe('ISO 8601 UTC window end (exclusive); must be after from.'),
      }).describe('Required metrics window [from, to).'),
      group_by: NotificationGroupable.optional().describe('Optional single split axis.'),
    }),
    outputSchema: McpMetricsResponse(NotificationMetrics),
    annotations: { title: 'Notifications metrics', ...RO },
  },
  {
    ...base,
    name: 'get_notification',
    description:
      'Fetch a single notification by sid: the rendered subject / body, delivery state, and failure reason if any. Useful in post-call analysis: follow a notification\'s event_sid back through observability to explain "why did I get this email".',
    toolClass: 'trivial',
    route: { service: 'id', method: 'GET', pathTemplate: '/api/notifications/{sid}', sidParam: 'sid' },
    operation: 'get',
    envelope: 'get',
    availability: 'ga',
    dangerous: false,
    inputSchema: McpGetRequestSchema('id_nt_'),
    outputSchema: McpGetResponse(Notification),
    annotations: { title: 'Get notification', ...RO },
  },
  {
    ...base,
    name: 'delete_notification',
    description:
      'Dismiss a notification from the inbox: a soft-delete that sets deleted_at. DESTRUCTIVE (removes the row from inbox lists). It does NOT cancel in-flight delivery: if the delivery worker already picked the row up, the email still goes out. The audit row is retained (recoverable via deleted_at filters).',
    toolClass: 'trivial',
    route: { service: 'id', method: 'DELETE', pathTemplate: '/api/notifications/{sid}', sidParam: 'sid' },
    operation: 'delete',
    envelope: 'delete_simple',
    availability: 'ga',
    dangerous: true,
    inputSchema: McpSimpleDeleteRequestSchema('id_nt_'),
    outputSchema: McpSimpleDeleteResponse,
    annotations: { title: 'Dismiss notification', ...DANGER },
  },
];
