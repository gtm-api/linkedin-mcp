// Entity: Antidetect Browser Log (gtm.service.linkedin)
// Source of truth: product/research/gtm.service.linkedin/entities/antidetect_browser_logs.md
// Format: registry v2, where each tool carries route metadata so the generic
// dispatcher can drive it. 1 tool (the antidetect-browser-logs route group, a
// read-only runtime-log surface), mounted on linkedin.browsers.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  filterOp,
  McpSearchRequestSchema,
  McpSearchResponse,
} from '@gtm/mcp-shared';

// Tight item projection: every AntidetectBrowserLogDomain field (research §Domain),
// correct type + nullability. Append-only log: no updated_at / deleted_at columns.
// `body` is genuinely free-form (shape varies by event_type), so it is typed as the
// documented object|string union, nullable. passthrough tolerates future additions.
const AntidetectBrowserLog = z.object({
  sid: z.string(),
  team_sid: z.string(),
  antidetect_browser_sid: z.string(),
  automation_server_sid: z.string().nullable(),
  level: z.enum(['info', 'error']),
  event_type: z.enum([
    // Lifecycle (6)
    'started_on_schedule', 'stopped_on_schedule', 'started_by_user', 'stopped_by_user',
    'started_after_maintenance', 'stopped_before_delete',
    // Error (7)
    'start_failure', 'proxy_error', 'login_issue', 'runtime_error',
    'started_after_error', 'server_unreachable', 'error_escalation',
    // Ops (1)
    'proxy_replaced',
  ]),
  code: z.number().nullable(),
  body: z.union([z.record(z.unknown()), z.string()]).nullable(),
  created_at: z.string(),
}).passthrough();

// Counts block: concrete shape from research (search per-tool block).
const AntidetectBrowserLogCounts = z.object({
  total_count: z.number(),
  groups: z.record(z.unknown()), // dynamic breakdown, object even when empty
}).passthrough();

const AntidetectBrowserLogFilter = z.object({
  sid: filterOp(z.string(), ['eq', 'in']).optional(),
  antidetect_browser_sid: filterOp(z.string(), ['eq', 'in']).optional(),
  automation_server_sid: filterOp(z.string(), ['eq', 'in', 'is_null']).optional(),
  level: filterOp(z.string(), ['eq', 'ne', 'in', 'nin']).optional(),
  event_type: filterOp(z.string(), ['eq', 'ne', 'in', 'nin']).optional(),
  code: filterOp(z.number().int(), ['eq', 'ne', 'in', 'nin', 'is_null']).optional(),
  created_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
}).partial();

const AntidetectBrowserLogInclude = z.enum(['antidetect_browser']);

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const base = {
  service: 'linkedin',
  entity: 'antidetect_browser_logs',
  mount: 'linkedin.browsers',
} as const;

export const antidetectBrowserLogsTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_antidetect_browser_logs',
    description:
      "List antidetect-browser runtime log rows for the team with filters, sorting and cursor pagination. This is the operational trail behind a browser's status (start/stop, runtime errors, proxy issues, logouts). Returns a counts block of predicate tallies; include[] can eager-load the antidetect_browser. Scope to one browser with antidetect_browser_sid.",
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/antidetect-browser-logs/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: McpSearchRequestSchema(AntidetectBrowserLogFilter, AntidetectBrowserLogInclude, undefined, 200),
    outputSchema: McpSearchResponse(AntidetectBrowserLog, undefined, AntidetectBrowserLogCounts),
    annotations: { title: 'Search antidetect browser logs', ...RO },
  },
];
