// Entity: Antidetect Browser Proxy (gtm.service.linkedin)
// Source of truth: product/research/gtm.service.linkedin/entities/antidetect_browser_proxies.md
// Format: registry v2, where each tool carries route metadata so the generic
// dispatcher can drive it. 3 tools (the antidetect-browser-proxies route group,
// a platform-wide read/probe surface), mounted on linkedin.browsers.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  filterOp,
  usageMetaField,
  McpActionResponse,
  McpSearchRequestSchema,
  McpSearchResponse,
} from '@gtm/mcp-shared';

const SID = z.string().length(18).startsWith('ab_px_')
  .describe('Antidetect browser proxy sid (ab_px_…).');

// Tight item projection: every AntidetectBrowserProxyDomain field (research §Domain),
// correct type + nullability. Credentials (ip / port / username / password) are masked
// to null on the public read, and the Domain types them `| null`, so nullable here.
const AntidetectBrowserProxy = z.object({
  sid: z.string(),
  // Identity / classification
  type: z.enum(['residential', 'datacenter']),
  country_code: z.string(),
  vendor_zone: z.string().nullable(),
  // Credentials: masked to null on public /api/ reads
  ip: z.string().nullable(),
  port: z.number().nullable(),
  username: z.string().nullable(),
  password: z.string().nullable(),
  // Operational state
  status: z.enum(['active', 'no_connect', 'country_mismatch', 'fraud_flagged', 'replaced']),
  last_health_check_at: z.string().nullable(),
  avg_connection_time_ms: z.number().nullable(),
  // Timestamps
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
}).passthrough();

const AntidetectBrowserProxyFilter = z.object({
  sid: filterOp(z.string(), ['eq', 'in']).optional(),
  type: filterOp(z.string(), ['eq', 'in']).optional(),
  country_code: filterOp(z.string(), ['eq', 'in']).optional(),
  vendor_zone: filterOp(z.string(), ['eq', 'in', 'is_null']).optional(),
  status: filterOp(z.string(), ['eq', 'in']).optional(),
  last_health_check_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(),
  avg_connection_time_ms: filterOp(z.number(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(),
  created_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  updated_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  deleted_at: filterOp(z.string(), ['is_null', 'gte', 'lte']).optional()
    .describe('Default scope is { is_null: true } (live proxies).'),
}).partial();

// Free-form probe result: the backend appends total_matched / successful /
// truncated (and, for connectivity, per-proxy errors[]); passthrough keeps it valid.
const ProxyCheckResult = z.object({
  total_matched: z.number().int().describe('True count of matched proxies (before the inline cap).'),
  truncated: z.boolean().optional().describe('true when total_matched exceeded the inline check cap.'),
}).passthrough();

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
// The two probes mutate no row, but they are ACTION verbs the backend declares
// mass_action: true (a fan-out over filter, one outbound network probe per
// matched proxy), and the registry forbids a read-only tool from being a
// massAction. Repeating a probe is safe, so idempotentHint stays true.
const PROBE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const base = {
  service: 'linkedin',
  entity: 'antidetect_browser_proxies',
  mount: 'linkedin.browsers',
} as const;

export const antidetectBrowserProxiesTools: ToolDefinition[] = [
  {
    ...base,
    name: 'check_antidetect_browser_proxy_connectivity',
    description:
      'Probe connectivity + latency for one or many proxies. Target EXACTLY ONE of sid (ab_px_) or filter; filter mode checks up to an inline cap and reports total_matched (truncated:true when the cap was hit). Read-only probe, no row mutation.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/antidetect-browser-proxies/check-proxy-connectivity' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    massAction: true,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID.optional(),
      filter: AntidetectBrowserProxyFilter.optional(),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), ProxyCheckResult),
    annotations: { title: 'Check proxy connectivity', ...PROBE },
  },
  {
    ...base,
    name: 'check_antidetect_browser_proxy_location',
    description:
      'Run a multi-vendor geo + fraud check on one or many proxies. Target EXACTLY ONE of sid (ab_px_) or filter; filter mode checks up to an inline cap and reports total_matched (truncated:true when the cap was hit). Read-only probe, no row mutation.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/antidetect-browser-proxies/check-proxy-location' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    massAction: true,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID.optional(),
      filter: AntidetectBrowserProxyFilter.optional(),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), ProxyCheckResult),
    annotations: { title: 'Check proxy location', ...PROBE },
  },
  {
    ...base,
    name: 'search_antidetect_browser_proxies',
    description:
      'List antidetect browser proxies (platform-wide pool) with filters, sorting and cursor pagination. Live proxies by default (deleted_at.is_null:true). Credentials (ip / port / username / password) are masked to null on this public read surface.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/antidetect-browser-proxies/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: McpSearchRequestSchema(AntidetectBrowserProxyFilter, undefined, undefined, 200)
      // The SearchRequest declares no include rule and the controller builds no
      // included block, so advertising the param would be a silent no-op.
      .omit({ include: true }),
    outputSchema: McpSearchResponse(AntidetectBrowserProxy),
    annotations: { title: 'Search antidetect browser proxies', ...RO },
  },
];
