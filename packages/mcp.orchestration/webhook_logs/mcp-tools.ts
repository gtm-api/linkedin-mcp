// Entity: Webhook Log (gtm.service.orchestration)
// Source of truth: product/research/gtm.service.orchestration/entities/webhook_logs.md
// Format: registry v2. Each tool carries route metadata so the generic
// dispatcher can drive it. 4 tools (the webhook-logs route group), mounted on
// orchestration.webhooks alongside webhooks. Execution layer of the three-layer
// webhook architecture (KNOWLEDGE §4.4): one row = one (webhook × event)
// delivery; retries UPDATE the same row.
//
// Moved with the webhook surface from gtm.service.linkedin to
// gtm.service.orchestration; the routes are unchanged (verified against
// fixtures/contract-oracle/orchestration.contract.json).

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  filterOp,
  usageMetaField,
  McpActionResponse,
  McpMetricsResponse,
  McpMetricsRequestSchema,
  McpSearchRequestSchema,
  McpSearchResponse,
} from '@gtm/mcp-shared';

const SID = z.string().length(18).startsWith('wh_lg_')
  .describe('Webhook log (delivery) sid (wh_lg_…).');

const WebhookLogStatus = z.enum([
  'pending', 'in_progress', 'retrying', 'success', 'failed', 'cancelled',
]);
const WebhookLogCancelReason = z.enum(['manual', 'webhook_deleted', 'webhook_disabled']);

// Item schema: full WebhookLogDomain field set (webhook_logs.md #### Domain).
// Append-only log: no deleted_at. passthrough keeps forward-compat.
const WebhookLog = z.object({
  sid: z.string(),
  team_sid: z.string(),
  webhook_sid: z.string(),
  // Prefix-agnostic account scope (ln_ac_… / em_ac_… / any future channel);
  // null for team-wide events. Renamed from linkedin_account_sid when the
  // surface moved to the platform-wide orchestration service.
  account_sid: z.string().nullable(),
  source_service: z.string().nullable(),                  // emitting service ('linkedin', 'email', …)
  event_type: z.string(),                                 // WebhookEventTypeEnum (kebab-plural)
  event_source_sid: z.string().nullable(),                // null for events without a primary entity
  status: WebhookLogStatus,
  retry_count: z.number(),
  cancel_reason: WebhookLogCancelReason.nullable(),       // set only when status='cancelled'
  request_method: z.string(),                             // WebhookLogRequestMethodEnum: 'POST' in v1
  request_url: z.string(),                                // snapshot of target_url at insert
  request_headers: z.record(z.string()),                  // X-Webhook-* / X-Trace-Id headers as sent
  request_payload: z.record(z.unknown()),                 // WebhookDeliveryEnvelopeValue
  response_code: z.number().nullable(),                   // null on network/timeout/TLS errors
  error_message: z.string().nullable(),
  duration_ms: z.number().nullable(),                     // null while no attempt has executed
  scheduled_at: z.string(),
  executed_at: z.string().nullable(),                     // null while pending / cancelled-without-attempt
  created_at: z.string(),
  updated_at: z.string(),
}).passthrough();

// Counts block. Mirrors WebhookLogMetricsService::countsFor(): total_count
// plus a groups map keyed by the 5 group axes, each a {key → count} tally.
// Every level is an object, empty or not: the envelope normalizes the counts
// block on its way out (Core/Support/JsonShape.php).
const WebhookLogCountTally = z.record(z.number());
const WebhookLogCounts = z.object({
  total_count: z.number(),
  groups: z.object({
    status: WebhookLogCountTally,
    event_type: WebhookLogCountTally,
    response_code: WebhookLogCountTally,
    webhook_sid: WebhookLogCountTally,
    account_sid: WebhookLogCountTally,
  }).passthrough(),
}).passthrough();

// Period-bound metrics leaf. Mirrors WebhookLogMetricsService::metricsFor()
// (research §metrics). All 9 fields are always emitted; passthrough keeps
// forward-compat. total_retries is a SUM (never null); rates + percentiles are
// null when their denominator / row-set is empty.
const WebhookLogMetrics = z.object({
  success_rate: z.number().nullable(),                    // 0..1, null when denominator = 0
  failure_rate: z.number().nullable(),                    // 0..1, mirror of success_rate
  avg_duration_ms: z.number().nullable(),                 // int >=0, null when no timed rows
  p50_duration_ms: z.number().nullable(),                 // int >=0, null when no terminal rows
  p95_duration_ms: z.number().nullable(),
  p99_duration_ms: z.number().nullable(),
  total_retries: z.number(),                              // int >=0, SUM(retry_count)
  last_success_at: z.string().nullable(),                 // MAX(executed_at) where status='success'
  last_failure_at: z.string().nullable(),                 // MAX(executed_at) where status='failed'
}).passthrough();

const WebhookLogRetryResult = z.object({
  previous_status: WebhookLogStatus,
  scheduled_at: z.string(),
  retry_count: z.number(),
}).passthrough();

const WebhookLogCancelResult = z.object({
  previous_status: WebhookLogStatus,
  cancel_reason: WebhookLogCancelReason,
  cancelled_at: z.string(),
  in_flight_attempt_pending: z.boolean(),
}).passthrough();

const WebhookLogFilter = z.object({
  sid: filterOp(z.string(), ['eq', 'in']).optional(),
  webhook_sid: filterOp(z.string(), ['eq', 'in']).optional(),
  account_sid: filterOp(z.string(), ['eq', 'in', 'is_null']).optional()
    .describe('Account the event belongs to, any channel (ln_ac_… / em_ac_…). is_null:true selects team-wide events (benchmarks, webhooks-meta).'),
  source_service: filterOp(z.string(), ['eq', 'in']).optional()
    .describe("Emitting service, e.g. 'linkedin' or 'email'."),
  event_type: filterOp(z.string(), ['eq', 'ne', 'in', 'nin']).optional(),
  event_source_sid: filterOp(z.string(), ['eq', 'in']).optional(),
  status: filterOp(WebhookLogStatus, ['eq', 'ne', 'in', 'nin']).optional()
    .describe("in:['pending','retrying'] = still in flight."),
  cancel_reason: filterOp(WebhookLogCancelReason, ['eq', 'in', 'is_null']).optional(),
  retry_count: filterOp(z.number(), ['eq', 'ne', 'gte', 'lte', 'gt', 'lt']).optional(),
  response_code: filterOp(z.number(), ['eq', 'ne', 'gte', 'lte', 'gt', 'lt', 'is_null']).optional()
    .describe('is_null:true = network / timeout / TLS error (no HTTP response).'),
  duration_ms: filterOp(z.number(), ['eq', 'ne', 'gte', 'lte', 'gt', 'lt', 'is_null']).optional(),
  scheduled_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  executed_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(),
  created_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
}).partial();

// Only 'webhook' is accepted by WebhookLogSearchRequest: the log lives in
// orchestration and cannot join another service's account table.
const WebhookLogInclude = z.enum(['webhook']);

const WebhookLogSortable = z.enum(['created_at', 'scheduled_at', 'executed_at', 'duration_ms']);

const WebhookLogGroupable = z.enum([
  'status', 'event_type', 'response_code', 'webhook_sid', 'account_sid',
]);

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const DANGER = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

const base = {
  service: 'orchestration',
  entity: 'webhook_logs',
  mount: 'orchestration.webhooks',
} as const;

export const webhookLogsTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_webhook_logs',
    description:
      "List webhook delivery rows for the caller's team with filter, sort, include and group-counts. Deliveries from every producer service (LinkedIn, email, …) land in this one log; filter per webhook, per account_sid, per source_service, per event type, per HTTP code or status; include=webhook. Returns a counts block (groups by status / event_type / response_code / webhook_sid / account_sid). Use for delivery auditing and integrator-outage debugging. For period-bound success rates use get_webhook_logs_metrics; single-row lookup is a filter on sid.",
    toolClass: 'typical',
    route: { service: 'orchestration', method: 'POST', pathTemplate: '/api/webhook-logs/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: McpSearchRequestSchema(WebhookLogFilter, WebhookLogInclude, WebhookLogSortable),
    outputSchema: McpSearchResponse(WebhookLog, undefined, WebhookLogCounts),
    annotations: { title: 'Search webhook logs', ...RO },
  },
  {
    ...base,
    name: 'get_webhook_logs_metrics',
    description:
      'Period-bound aggregates over webhook deliveries: success_rate, failure_rate, p50/p95/p99 latency, total_retries, last_success_at / last_failure_at. Requires period {from,to} (≤ 90 days). Optional filter scopes the row set (created_at operators inside filter are ignored; period is the only time window) and an optional single group_by axis (status, event_type, response_code, webhook_sid, account_sid).',
    toolClass: 'typical',
    route: { service: 'orchestration', method: 'POST', pathTemplate: '/api/webhook-logs/metrics' },
    operation: 'metrics',
    envelope: 'metrics',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: McpMetricsRequestSchema(WebhookLogFilter).extend({
      period: z.object({
        from: z.string().describe('ISO 8601 UTC window start (inclusive).'),
        to: z.string().describe('ISO 8601 UTC window end (exclusive); must be after from.'),
      }).describe('Required metrics window [from, to), max 90 days.'),
      group_by: WebhookLogGroupable.optional().describe('Optional single split axis.'),
    }),
    outputSchema: McpMetricsResponse(WebhookLogMetrics),
    annotations: { title: 'Webhook logs metrics', ...RO },
  },
  {
    ...base,
    name: 'retry_webhook_log',
    description:
      'Manually re-arm a webhook delivery row: flips status to pending, sets scheduled_at=now(), increments retry_count. error_message is preserved (cleared only on the next successful terminal outcome). Allowed from pending / retrying / failed / success; rejected on cancelled (422), on a soft-deleted / disabled parent webhook (422), and while the worker holds the row (409 lease_in_progress). Pass expected_status for a CAS write (409 on mismatch). Re-delivers to the integrator; state-changing.',
    toolClass: 'complex',
    route: { service: 'orchestration', method: 'POST', pathTemplate: '/api/webhook-logs/{sid}/retry', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    creditable: false,
    inputSchema: z.object({
      sid: SID,
      expected_status: WebhookLogStatus.optional()
        .describe('Optional CAS guard; retry only succeeds when current status equals this (else 409 precondition_failed).'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(WebhookLog, WebhookLogRetryResult),
    annotations: { title: 'Retry webhook delivery', ...DANGER },
  },
  {
    ...base,
    name: 'cancel_webhook_log',
    description:
      'Cancel a webhook delivery (status → cancelled); no further retries. Allowed from pending / retrying / in_progress; terminal rows → 422 cannot_cancel_terminal. Cancelling an in_progress row may still flip back to success if the worker in-flight attempt returns 2xx (re-read the row; result.in_flight_attempt_pending signals this). Pass expected_status for a CAS write (409 on mismatch). Aborts a pending delivery; state-changing.',
    toolClass: 'typical',
    route: { service: 'orchestration', method: 'POST', pathTemplate: '/api/webhook-logs/{sid}/cancel', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    creditable: false,
    inputSchema: z.object({
      sid: SID,
      expected_status: WebhookLogStatus.optional()
        .describe('Optional CAS guard; rejected with 409 precondition_failed when current status differs.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(WebhookLog, WebhookLogCancelResult),
    annotations: { title: 'Cancel webhook delivery', ...DANGER },
  },
];
