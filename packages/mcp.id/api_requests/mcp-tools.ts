// Entity: ApiRequest (gtm.service.id)
// Source of truth: product/research/gtm.service.id/entities/api_requests.md
// Format: registry v2. Each tool carries route metadata so the generic
// dispatcher can drive it. 2 tools (the api-requests route group), mounted
// on id.platform. The team's own log of external API traffic (api keys and
// OAuth clients, the agent's own calls included), merged by id across the
// services that answered. Read-only: rows are written by the request
// chokepoint and expire with the retention sweep (no get/create/update/delete).

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  filterOp,
  McpMetricsRequestSchema,
  McpMetricsResponse,
  McpSearchRequestSchema,
  McpSearchResponse,
} from '@gtm/mcp-shared';

const ApiRequestService = z.enum(['id', 'linkedin', 'orchestration']);
const ApiRequestSurface = z.enum(['api_key', 'agent', 'oauth_other']);
const ApiRequestCredentialKind = z.enum(['api_key', 'oauth']);
const ApiRequestOperation = z.enum(['get', 'search', 'metrics', 'group_by', 'create', 'update', 'delete', 'action']);
const ApiRequestStatusFamily = z.enum(['2xx', '3xx', '4xx', '5xx']);
const ApiRequestSourceState = z.enum(['ok', 'error', 'unconfigured']);

// Loose item / counts schemas: the full field set is tightened by the Stage-1
// contract tests against live envelopes; passthrough keeps live responses valid.
const ApiRequest = z.object({
  sid: z.string(),
  team_sid: z.string(),
  service: ApiRequestService,
  occurred_at: z.string(),
  surface: ApiRequestSurface,
  credential_kind: ApiRequestCredentialKind,
  client_sid: z.string(),
  client_name: z.string().nullable(),
  actor_sid: z.string().nullable(),
  method: z.string(),
  route: z.string(),
  entity: z.string(),
  operation: ApiRequestOperation,
  action_name: z.string().nullable(),
  account_sid: z.string().nullable(),
  status: z.number().int(),
  status_family: ApiRequestStatusFamily,
  error_code: z.string().nullable(),
  error_reason: z.string().nullable(),
  error_cause: z.string().nullable(),
  duration_ms: z.number().int().nullable(),
  trace_id: z.string().nullable(),
}).passthrough();

const ApiRequestCounts = z.object({
  total_count: z.number().int(),
  sources: z.record(ApiRequestSourceState)
    .describe('Which services this answer counts: ok / error (did not answer, contributes nothing) / unconfigured. A service the `service` filter excludes is absent.'),
}).passthrough();

const ApiRequestMetrics = z.object({
  error_rate: z.number().nullable().describe('(4xx + 5xx) / total over the merged sources, 0..1; null when total is 0.'),
  avg_duration_ms: z.number().int().nullable().describe('Mean wall time of the rows that carry a duration; null when none.'),
  first_occurred_at: z.string().nullable().describe('Earliest request in the window, ISO 8601 UTC.'),
  last_occurred_at: z.string().nullable().describe('Latest request in the window: "when did my agent last call".'),
}).passthrough();

const ApiRequestFilter = z.object({
  sid: filterOp(z.string(), ['eq', 'in']).optional(),
  service: filterOp(ApiRequestService, ['eq', 'ne', 'in', 'nin']).optional()
    .describe('Which answering service: id (keys, teams, billing), linkedin (the channel), orchestration (mass actions, webhooks). Excluded services are not asked.'),
  surface: filterOp(ApiRequestSurface, ['eq', 'ne', 'in', 'nin']).optional()
    .describe('api_key = bearer keys (scripts, n8n); agent = OAuth clients of kind agent (Claude, Cursor); oauth_other = other OAuth clients.'),
  credential_kind: filterOp(ApiRequestCredentialKind, ['eq', 'ne', 'in', 'nin']).optional(),
  client_sid: filterOp(z.string(), ['eq', 'ne', 'in', 'nin']).optional()
    .describe('The credential: an api key sid (id_ak_*) or an OAuth client sid (id_oc_*). "What did Claude do" = that client\'s sid.'),
  actor_sid: filterOp(z.string(), ['eq', 'in', 'is_null']).optional()
    .describe('The member an OAuth client delegates for (us_mb_*); is_null:true = api-key traffic.'),
  entity: filterOp(z.string(), ['eq', 'ne', 'in', 'nin']).optional()
    .describe('The entity the route names, snake singular: linkedin_conversation, linkedin_message, mass_action, api_key.'),
  operation: filterOp(ApiRequestOperation, ['eq', 'ne', 'in', 'nin']).optional(),
  action_name: filterOp(z.string(), ['eq', 'in', 'is_null']).optional()
    .describe('The verb of an action route (send, run_now); is_null:true = the six canonical operations.'),
  route: filterOp(z.string(), ['eq', 'ne', 'in', 'nin']).optional()
    .describe('The route key, exact: "POST api/linkedin-conversations/search".'),
  account_sid: filterOp(z.string(), ['eq', 'ne', 'in', 'nin', 'is_null']).optional()
    .describe('The account the request named (ln_ac_*, em_ac_*): "everything that was refused on this sender". is_null:true = calls that named no account.'),
  status: filterOp(z.number().int(), ['eq', 'ne', 'in', 'nin', 'gte', 'lte', 'gt', 'lt']).optional(),
  status_family: filterOp(ApiRequestStatusFamily, ['eq', 'ne', 'in', 'nin']).optional()
    .describe('4xx and 5xx together are the errors every dashboard number counts.'),
  error_code: filterOp(z.string(), ['eq', 'ne', 'in', 'nin', 'is_null']).optional()
    .describe('The typed error code of the envelope that was returned (rate_limited, validation_failed, not_found); is_null:true = the calls that succeeded.'),
  error_reason: filterOp(z.string(), ['eq', 'ne', 'in', 'nin', 'is_null']).optional()
    .describe('The sub-code inside error.context (bucket_saturated, account_rate_exceeded, not_connected): what a status alone cannot say.'),
  error_cause: filterOp(z.string(), ['eq', 'ne', 'in', 'nin', 'is_null']).optional()
    .describe('The specific trigger a layered gate adds (held, daily_saturation, delay_not_elapsed, linkedin_quota_hit): held means a person paused the account, daily_saturation means the limit is spent, and a 429 does not tell them apart.'),
  occurred_at: filterOp(z.string(), ['eq', 'gte', 'lte', 'gt', 'lt']).optional()
    .describe('ISO 8601 UTC. The only time axis on search; ignored on metrics, where period is the window.'),
  trace_id: filterOp(z.string(), ['eq', 'in', 'is_null']).optional()
    .describe('All the calls of one MCP turn share a trace id.'),
}).partial();

const ApiRequestBucket = z.enum(['hour', 'day']);

// One point of the time axis: the bucket's own counts and, when group_by was
// passed, the split's counts for that bucket only.
const ApiRequestSeriesPoint = z.object({
  start: z.string().describe('The bucket start, ISO 8601 UTC.'),
  counts: z.object({
    total_count: z.number().int(),
    error_count: z.number().int(),
    groups: z.object({ status_family: z.record(z.number().int()) }).passthrough(),
  }).passthrough(),
  groups: z.record(z.object({ total_count: z.number().int(), error_count: z.number().int() }))
    .describe('Per group_by key, this bucket only; empty when no group_by was passed.'),
}).passthrough();

const ApiRequestSortable = z.enum(['occurred_at']);
const ApiRequestGroupBy = z.enum(['service', 'surface', 'credential_kind', 'client_sid', 'entity', 'operation', 'route', 'status_family', 'occurred_day', 'occurred_hour']);

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const base = {
  service: 'id',
  entity: 'api_requests',
  mount: 'id.platform',
} as const;

export const apiRequestsTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_api_requests',
    description:
      'List the team\'s external API requests newest first: every call made with an api key or an OAuth client (your own calls included), as logged by the service that answered it, merged across id, linkedin and orchestration. One row per request: the client (key or OAuth client, with its name), the route and entity, the HTTP status and its family, the typed error it failed with (error_code, error_reason, error_cause), the account it named, the duration, the trace id. Use for "what did our agents do", "show the failing requests since noon" (filter status_family in [4xx,5xx]), "why are these all 429" (filter error_cause: a paused account is not a spent daily limit), "what did the n8n client call" (filter client_sid), or one MCP turn (filter trace_id). page_size 0 counts only; the cursor is a keyset merged across services. counts.sources says which services answered; a service marked error contributed nothing. Not LinkedIn activity (that is the account activity log) and not a quota: the log counts, it never limits.',
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/api-requests/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    inputSchema: McpSearchRequestSchema(ApiRequestFilter, undefined, ApiRequestSortable, 200)
      // No relation to load: client_name and actor_sid are on the row, and the
      // controller builds no included block.
      .omit({ include: true }),
    outputSchema: McpSearchResponse(ApiRequest, undefined, ApiRequestCounts),
    annotations: { title: 'Search API requests', ...RO },
  },
  {
    ...base,
    name: 'get_api_request_metrics',
    description:
      'Period-bound totals of the team\'s external API requests, merged across the answering services: total_count, error_count and the 2xx/3xx/4xx/5xx split in aggregated.counts; error_rate, avg_duration_ms, first/last_occurred_at in aggregated.metrics. Requires period {from, to} (ISO 8601 UTC, half-open, at most 92 days). Optional group_by splits the same numbers per key: client_sid ("how much does each agent call", groups carry the client name), route or entity ("which tools"), status_family, service, surface (occurred_hour / occurred_day exist too but bucket is the better time axis). Optional bucket (hour | day) cuts the window into consecutive UTC buckets, series.points[] one per bucket over the whole window with zeros filled, each carrying its own counts and its own group_by split: "requests per day by type" is group_by entity + bucket day in one call. Use to answer "how many calls this week and how many failed" in one round-trip instead of paging the log. aggregated.counts.sources says which services answered.',
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/api-requests/metrics' },
    operation: 'metrics',
    envelope: 'metrics',
    availability: 'ga',
    dangerous: false,
    inputSchema: McpMetricsRequestSchema(ApiRequestFilter).extend({
      period: z.object({
        from: z.string().describe('ISO 8601 UTC window start (inclusive).'),
        to: z.string().describe('ISO 8601 UTC window end (exclusive); at most 92 days after from.'),
      }).describe('Required metrics window [from, to). Operators on occurred_at inside filter are ignored.'),
      group_by: ApiRequestGroupBy.nullable().optional()
        .describe('Split the aggregate per key: client_sid / route / entity / status_family / service / surface = breakdowns (occurred_hour / occurred_day = a legacy time split; prefer bucket). Cap 500 groups.'),
      bucket: ApiRequestBucket.nullable().optional()
        .describe('The time axis, independent of group_by: hour or day (UTC). Answers series.points[], one per bucket over the whole window, zeros filled, each with its own counts and group_by split.'),
    }),
    outputSchema: McpMetricsResponse(ApiRequestMetrics).extend({
      metrics: z.object({
        period: z.object({ from: z.string(), to: z.string() }).passthrough().optional(),
        aggregated: z.object({
          counts: z.record(z.unknown()).optional(),
          metrics: ApiRequestMetrics.optional(),
        }).passthrough().optional(),
        groups: z.array(z.object({
          key: z.string(),
          // A split by client_sid names its groups: the api key's name (revoked
          // keys included) or the OAuth client's, and which of the two it is.
          // Absent on every other split and on a sid neither registry knows.
          label: z.string().optional(),
          credential_kind: z.enum(['api_key', 'oauth']).optional(),
          counts: z.record(z.unknown()),
          metrics: ApiRequestMetrics,
        }).passthrough()).optional(),
        series: z.object({ bucket: ApiRequestBucket, points: z.array(ApiRequestSeriesPoint) }).optional()
          .describe('Present only when bucket was passed.'),
      }).passthrough(),
    }),
    annotations: { title: 'API request metrics', ...RO },
  },
];
