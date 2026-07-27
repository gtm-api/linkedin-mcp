// Entity: Cloud Browser Session (gtm.service.linkedin)
// Source of truth: product/research/gtm.service.linkedin/entities/cloud_browser_sessions.md
// Format: registry v2, where each tool carries route metadata so the generic
// dispatcher can drive it. 2 tools (the cloud-browser-sessions route group, a
// read-only audit surface), mounted on linkedin.browsers.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  filterOp,
  McpMetricsResponse,
  McpMetricsRequestSchema,
  McpSearchRequestSchema,
  McpSearchResponse,
} from '@gtm/mcp-shared';

// Tight item projection: every CloudBrowserSessionDomain field (research §Domain),
// correct type + nullability. Append-only log: no updated_at / deleted_at columns.
// access_key is masked to null on the public read surface (never exposed as a string).
const CloudBrowserSession = z.object({
  sid: z.string(),
  team_sid: z.string(),
  // Bound assets
  antidetect_browser_sid: z.string(),
  cloud_browser_sid: z.string(),
  linkedin_account_sid: z.string().nullable(),
  // Connecting identity
  connected_user_sid: z.string().nullable(),
  access_key: z.string().nullable(),
  access_type: z.enum(['internal', 'external']),
  // Connecting context
  ip: z.string(),
  ip_country: z.string().nullable(),
  ip_city: z.string().nullable(),
  fingerprint: z.object({
    user_agent: z.string(),
    screen_resolution: z.string(),
    timezone: z.string(),
    language: z.string(),
    platform: z.string(),
  }).nullable(),
  fingerprint_hash: z.string().nullable(),
  referrer: z.string().nullable(),
  // Flow flavor + login outcome
  is_login_case: z.boolean(),
  login_confirmed_at: z.string().nullable(),
  login_result: z.enum(['success', 'cookie_save_failed', 'browser_start_failed', 'abandoned']).nullable(),
  login_error_reason: z.string().nullable(),
  // Session timing
  connected_at: z.string(),
  disconnected_at: z.string().nullable(),
  session_duration_seconds: z.number().nullable(),
  // Disconnect attribution (disconnect_cause enum owned by cloud_browsers)
  disconnect_cause: z.enum([
    'user', 'keep_alive_stale', 'ttl_expired', 'stuck_disconnecting', 'maintenance',
  ]).nullable(),
  disconnect_reason: z.string().nullable(),
  created_at: z.string(),
}).passthrough();

// Metrics block: concrete scalar shape from research (metrics per-tool block).
const CloudBrowserSessionMetrics = z.object({
  avg_session_duration_seconds: z.number().nullable(),
  p95_session_duration_seconds: z.number().nullable(),
  unique_ips_count: z.number(),
  unique_devices_count: z.number(),
  login_success_rate: z.number().nullable(),
}).passthrough();

const CloudBrowserSessionFilter = z.object({
  sid: filterOp(z.string(), ['eq', 'in']).optional(),
  antidetect_browser_sid: filterOp(z.string(), ['eq', 'in']).optional(),
  cloud_browser_sid: filterOp(z.string(), ['eq', 'in']).optional(),
  linkedin_account_sid: filterOp(z.string(), ['eq', 'in', 'is_null']).optional(),
  connected_user_sid: filterOp(z.string(), ['eq', 'in', 'is_null']).optional(),
  access_type: filterOp(z.string(), ['eq', 'ne', 'in', 'nin']).optional(),
  ip: filterOp(z.string(), ['eq', 'in']).optional(),
  ip_country: filterOp(z.string(), ['eq', 'in', 'is_null']).optional(),
  ip_city: filterOp(z.string(), ['eq', 'in', 'is_null']).optional(),
  fingerprint_hash: filterOp(z.string(), ['eq', 'in', 'is_null']).optional(),
  is_login_case: filterOp(z.boolean(), ['eq']).optional(),
  login_result: filterOp(z.string(), ['eq', 'ne', 'in', 'nin', 'is_null']).optional(),
  login_confirmed_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(),
  connected_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  disconnected_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(),
  session_duration_seconds: filterOp(z.number().int(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(),
  disconnect_cause: filterOp(z.string(), ['eq', 'ne', 'in', 'nin', 'is_null']).optional(),
  created_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  updated_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
}).partial();

const CloudBrowserSessionGroupable = z.enum([
  'access_type',
  'login_result',
  'is_login_case',
  'ip_country',
  'antidetect_browser_sid',
  'linkedin_account_sid',
  'connected_user_sid',
  'disconnect_cause',
]);

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const base = {
  service: 'linkedin',
  entity: 'cloud_browser_sessions',
  mount: 'linkedin.browsers',
} as const;

export const cloudBrowserSessionsTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_cloud_browser_sessions',
    description:
      'List cloud-browser sessions on the team with filters, sorting and cursor pagination. This is the audit trail of who connected to which browser, from where, and how each login attempt resolved. The smart-link access_key is masked to null and is not a public filter.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/cloud-browser-sessions/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: McpSearchRequestSchema(CloudBrowserSessionFilter, undefined, undefined, 200)
      // The SearchRequest declares no include rule and the controller builds no
      // included block, so advertising the param would be a silent no-op.
      .omit({ include: true }),
    outputSchema: McpSearchResponse(CloudBrowserSession),
    annotations: { title: 'Search cloud browser sessions', ...RO },
  },
  {
    ...base,
    name: 'get_cloud_browser_sessions_metrics',
    description:
      'Period-bound aggregates over a filtered cloud-browser-session set. Requires period {from,to}. Returns total_count, active_count, avg_session_duration_seconds, login_success_rate, unique_devices_count and unique_ips_count. Optional filter and a single group_by axis (access_type / login_result / ip_country / antidetect_browser_sid / …).',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/cloud-browser-sessions/metrics' },
    operation: 'metrics',
    envelope: 'metrics',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: McpMetricsRequestSchema(CloudBrowserSessionFilter).extend({
      period: z.object({
        from: z.string().describe('ISO 8601 UTC window start (inclusive).'),
        to: z.string().describe('ISO 8601 UTC window end (exclusive); must be after from.'),
      }).describe('Required metrics window [from, to).'),
      group_by: CloudBrowserSessionGroupable.optional().describe('Optional single split axis.'),
    }),
    outputSchema: McpMetricsResponse(CloudBrowserSessionMetrics),
    annotations: { title: 'Cloud browser sessions metrics', ...RO },
  },
];
