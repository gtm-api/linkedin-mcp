// Entity: Webhook (gtm.service.orchestration)
// Source of truth: product/research/gtm.service.orchestration/entities/webhooks.md
// Format: registry v2. Each tool carries route metadata so the generic
// dispatcher can drive it. 6 tools (the webhooks route group), mounted on
// orchestration.webhooks alongside webhook-logs. Routing layer of the
// three-layer webhook architecture (KNOWLEDGE §4.4).
//
// The whole webhook surface moved out of gtm.service.linkedin into
// gtm.service.orchestration (one central emitter for every producer service),
// so these tools are served by the orchestration base URL. The routes
// themselves did not change: verified against
// fixtures/contract-oracle/orchestration.contract.json.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  filterOp,
  usageMetaField,
  AccessIdentityValue,
  McpActionResponse,
  McpCreateResponse,
  McpUpdateResponse,
  McpSimpleDeleteResponse,
  McpSimpleDeleteRequestSchema,
  McpGetRequestSchema,
  McpGetResponse,
  McpSearchRequestSchema,
  McpSearchResponse,
} from '@gtm/mcp-shared';

const SID = z.string().length(18).startsWith('wh_hk_')
  .describe('Webhook sid (wh_hk_…).');

const WebhookStatus = z.enum(['on', 'off', 'failed']);

// The subscribable event vocabulary, verbatim from the create/update rules()
// (WebhookEventTypeEnum, 89 values). It has to be a closed set on this side:
// an in: rule 422s with "invalid", never with the list, and an agent cannot
// subscribe to an event it has to guess the name of.
const WebhookEventType = z.enum([
  'linkedin-accounts.created',
  'linkedin-accounts.restored',
  'linkedin-accounts.deleted',
  'linkedin-accounts.initial-sync-started',
  'linkedin-accounts.initial-sync-done',
  'linkedin-accounts.sync-reset',
  'linkedin-accounts.sync-config-updated',
  'linkedin-accounts.premium-changed',
  'linkedin-accounts.login-succeeded',
  'linkedin-accounts.login-failed',
  'linkedin-accounts.logged-out',
  'linkedin-accounts.heartbeat-stale',
  'linkedin-account-block-log.recorded',
  'linkedin-account-snapshot.captured',
  'linkedin-account-quota-hits.recorded',
  'linkedin-account-smart-limits.limit-reached',
  'linkedin-account-smart-limits.limit-released',
  'linkedin-account-smart-limits.smart-limit-recomputed',
  'linkedin-connection-requests.sent',
  'linkedin-connection-requests.accepted',
  'linkedin-connection-requests.withdrawn',
  'linkedin-connection-requests.expired-detected',
  'linkedin-connection-requests.resend-available',
  'linkedin-connection-requests.sync-completed',
  'linkedin-connection-invitations.received',
  'linkedin-connection-invitations.accepted',
  'linkedin-connection-invitations.ignored',
  'linkedin-connection-invitations.expired-detected',
  'linkedin-connection-invitations.sync-completed',
  'linkedin-connections.added',
  'linkedin-connections.removed',
  'linkedin-connections.sync-completed',
  'linkedin-followers.added',
  'linkedin-messages.received',
  'linkedin-messages.sent',
  'linkedin-messages.send-failed',
  'linkedin-conversations.created',
  'linkedin-conversations.sync-completed',
  'data-requests.completed',
  'data-requests.failed',
  'linkedin-auto-scrape-runs.completed',
  'linkedin-auto-scrape-runs.failed',
  'linkedin-auto-scrapes.paused',
  'antidetect-browsers.logged-in',
  'antidetect-browsers.logged-out',
  'antidetect-browsers.started',
  'antidetect-browsers.stopped',
  'antidetect-browsers.start-failed',
  'antidetect-browsers.running-issue',
  'antidetect-browsers.error-investigation',
  'antidetect-browsers.maintenance',
  'antidetect-browsers.proxy-issue',
  'antidetect-browsers.proxy-back-alive',
  'antidetect-browsers.idle',
  'account-shares.created',
  'account-shares.returned',
  'account-shares.recalled',
  'account-shares.failed',
  'account-transfers.completed',
  'account-transfers.failed',
  'webhooks.failed',
  'email-accounts.connected',
  'email-accounts.reconnect-required',
  'email-accounts.sending-paused',
  'email-accounts.sending-resumed',
  'email-accounts.disconnected',
  'email-accounts.deleted',
  'email-accounts.sync-completed',
  'email-messages.received',
  'email-messages.sent',
  'email-messages.bounced',
  'email-messages.complained',
  'email-messages.failed',
  'email-messages.deleted',
  'email-threads.updated',
  'email-engagements.opened',
  'email-engagements.clicked',
  'email-engagements.unsubscribed',
  'email-account-health.snapshot-captured',
  'email-account-health.score-critical',
  'email-suppressions.created',
  'email-suppressions.deleted',
  'email-tracking-domains.verified',
  'email-tracking-domains.failed',
  'email-sending-domains.verified',
  'email-sending-domains.failed',
  'mass-actions.created',
  'mass-actions.paused',
  'mass-actions.resumed',
  'mass-actions.settled',
]);


// Optional narrowing applied AFTER event_type matches the events array.
// account_sid is deliberately prefix-agnostic (WebhookFiltersValue): the
// registry is platform-wide, so the same key narrows a LinkedIn account, an
// email account, or any future channel sender.
const WebhookFilters = z.object({
  account_sid: z.string().length(18).optional()
    .describe('char(18) account sid (ln_ac_… / em_ac_…): only deliver events for this account.'),
}).passthrough();

// Item schema: full WebhookDomain field set (webhooks.md #### Domain).
// passthrough keeps forward-compat if the backend adds fields. `secret` is
// masked (null) on every read; the 32-hex value is emitted only in the create
// response (see allowSecretFields on create_webhook), so it is optional here.
const Webhook = z.object({
  sid: z.string(),
  team_sid: z.string(),
  name: z.string(),
  target_url: z.string(),
  // WebhookEventTypeEnum[], deliberately NOT the closed WebhookEventType here.
  // The vocabulary is 89 values, ~2.4KB of JSON schema per occurrence, and every
  // occurrence is registration-time context for every agent that loads the
  // server (KNOWLEDGE §4.32). It is worth paying on create and update, where the
  // backend's in: rule 422s on a token the agent had to guess. It is not worth
  // paying on the read path or in the filter: those values come back FROM the
  // backend, a wrong filter value returns no rows rather than an error, and no
  // agent has to author one. Read side stays a string; write side is closed.
  events: z.array(z.string()),
  // WebhookFiltersValue (JSON): a fixed-shape value object, always `{...}`.
  filters: z.record(z.unknown()),
  secret: z.string().nullable().optional(),
  status: WebhookStatus,
  // Failure-tracking (WebhookDomain; emitted on every read via toDomain()).
  consecutive_failed_attempts: z.number(),                // int, >= 0
  last_failure_at: z.string().nullable(),                 // Carbon|null
  created_by: AccessIdentityValue.passthrough(),
  deleted_by: AccessIdentityValue.passthrough().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
}).passthrough();

const WebhookCounts = z.object({}).passthrough();

// Synchronous test-send outcome (does NOT write to webhook_logs).
const WebhookTestResult = z.object({
  http_status: z.number().nullable(),
  response_body: z.string().nullable(),
  duration_ms: z.number(),
  error_kind: z.enum(['none', 'network', 'timeout', 'tls', 'http_error']),
  error_message: z.string().nullable(),
}).passthrough();

const WebhookFilter = z.object({
  status: filterOp(WebhookStatus, ['eq', 'in']).optional(),
  events: filterOp(z.string(), ['eq', 'in']).optional()
    .describe('eq: webhooks subscribed to this event type; in: subscribed to ANY of these (JSON-contains on the events array).'),
  name: z.object({
    eq: z.string().optional(),
  }).partial().optional(),
  q: z.string().optional().describe('Full-text over name / target_url.'),
  consecutive_failed_attempts: filterOp(z.number(), ['eq', 'gte', 'lte', 'gt', 'lt']).optional()
    .describe('Consecutive delivery failures (idx_wh_team_consecutive): the "close to failing" axis.'),
  last_failure_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional()
    .describe('Timestamp of the most recent failed delivery (idx_wh_team_last_failure).'),
  created_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  updated_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  deleted_at: filterOp(z.string(), ['gte', 'lte']).optional(),
  deleted: z.boolean().optional().describe('true = include soft-deleted rows; default excludes them.'),
}).partial();

const WebhookInclude = z.enum(['latest_webhook_logs']);

const WebhookSortable = z.enum(['created_at', 'updated_at', 'name']);

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const DANGER = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const DANGER_IDEM = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

const base = {
  service: 'orchestration',
  entity: 'webhooks',
  mount: 'orchestration.webhooks',
} as const;

export const webhooksTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_webhooks',
    description:
      "List webhook subscriptions owned by the caller's team with filter, sort and cursor pagination. Filter by status, subscribed event types (events.contains / contains_any), account narrowing or name; include=latest_webhook_logs for the recent-delivery view. secret is masked (null) on every read. Use this to find a webhook sid before calling webhook-scoped tools.",
    toolClass: 'typical',
    route: { service: 'orchestration', method: 'POST', pathTemplate: '/api/webhooks/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: McpSearchRequestSchema(WebhookFilter, WebhookInclude, WebhookSortable),
    outputSchema: McpSearchResponse(Webhook, undefined, WebhookCounts),
    annotations: { title: 'Search webhooks', ...RO },
  },
  {
    ...base,
    name: 'test_webhook',
    description:
      'Synchronously POST a synthetic payload to the webhook target_url and return the receiver response (HTTP status, duration, error kind). Verifies endpoint health / signature handling without waiting for a real event; does NOT write to webhook_logs and does NOT affect the consecutive-failure counter. Allowed while status=failed (revival flow); rejected while status=off. Rate-limited to 10 calls/min per webhook. Outward live HTTP probe.',
    toolClass: 'complex',
    route: { service: 'orchestration', method: 'POST', pathTemplate: '/api/webhooks/{sid}/test', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    creditable: false,
    inputSchema: z.object({
      sid: SID,
      override_event_type: z.string().optional()
        .describe('Test with a specific event type payload shape (default: webhooks.test synthetic).'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(Webhook, WebhookTestResult),
    annotations: { title: 'Test webhook', ...DANGER },
  },
  {
    ...base,
    name: 'get_webhook',
    description: 'Fetch a single webhook by sid. Use include=latest_webhook_logs for the recent delivery view. secret is masked (null) on reads.',
    toolClass: 'trivial',
    route: { service: 'orchestration', method: 'GET', pathTemplate: '/api/webhooks/{sid}', sidParam: 'sid' },
    operation: 'get',
    envelope: 'get',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: McpGetRequestSchema('wh_hk_', WebhookInclude),
    outputSchema: McpGetResponse(Webhook),
    annotations: { title: 'Get webhook', ...RO },
  },
  {
    ...base,
    name: 'update_webhook',
    description:
      "Patch a webhook. Editable fields: name, target_url, events, filters, status. status:'on' on a failed webhook resets the consecutive-failure counter and resumes deliveries; status:'failed' cannot be set manually. events and filters are FULL replacements, not merges. secret is NOT writable here (rotation is admin-internal). State-changing.",
    toolClass: 'typical',
    route: { service: 'orchestration', method: 'PATCH', pathTemplate: '/api/webhooks/{sid}', sidParam: 'sid' },
    operation: 'update',
    envelope: 'update',
    availability: 'ga',
    dangerous: true,
    creditable: false,
    inputSchema: z.object({
      sid: SID,
      name: z.string().min(1).max(255).optional(),
      target_url: z.string().max(2048).optional().describe('https:// only, public IP only.'),
      events: z.array(WebhookEventType).min(1).optional()
        .describe('Full replacement; WebhookEventTypeEnum values.'),
      filters: WebhookFilters.optional().describe('Full replacement.'),
      status: z.enum(['on', 'off']).optional().describe("on | off only; 'failed' is platform-set."),
      ...usageMetaField,
    }),
    outputSchema: McpUpdateResponse(Webhook),
    annotations: { title: 'Update webhook', ...DANGER_IDEM },
  },
  {
    ...base,
    name: 'create_webhook',
    description:
      'Create a webhook subscription endpoint. The server generates a 32-char hex secret and returns it ONCE in this response (masked on every subsequent read). Store it client-side for HMAC verification. target_url must be https:// and public (non-RFC1918); each events[] value is validated against WebhookEventTypeEnum; the same target_url cannot be registered twice per team. State-changing.',
    toolClass: 'typical',
    route: { service: 'orchestration', method: 'POST', pathTemplate: '/api/webhooks' },
    operation: 'create',
    envelope: 'create',
    availability: 'ga',
    dangerous: true,
    creditable: false,
    allowSecretFields: ['secret'],
    inputSchema: z.object({
      name: z.string().min(1).max(255),
      target_url: z.string().max(2048).describe('https:// only, public IP only.'),
      events: z.array(WebhookEventType).min(1)
        .describe('At least one WebhookEventTypeEnum value.'),
      filters: WebhookFilters.optional().describe('Optional narrowing (e.g. status, events).'),
      ...usageMetaField,
    }),
    outputSchema: McpCreateResponse(Webhook),
    annotations: { title: 'Create webhook', ...DANGER },
  },
  {
    ...base,
    name: 'delete_webhook',
    description:
      'Soft-delete a webhook (deleted_at set; webhook stops matching new events). Existing webhook_logs remain queryable but un-retryable; pending / retrying deliveries are cancelled. Destructive and one-way (no API undo).',
    toolClass: 'trivial',
    route: { service: 'orchestration', method: 'DELETE', pathTemplate: '/api/webhooks/{sid}', sidParam: 'sid' },
    operation: 'delete',
    envelope: 'delete_simple',
    availability: 'ga',
    dangerous: true,
    creditable: false,
    inputSchema: McpSimpleDeleteRequestSchema('wh_hk_'),
    outputSchema: McpSimpleDeleteResponse,
    annotations: { title: 'Delete webhook', ...DANGER_IDEM },
  },
];
