// Entity: Observability Request (gtm.service.id)
// Source of truth: product/research/gtm.service.id/entities/observability_requests.md
// Format: registry v2. Each tool carries route metadata so the generic
// dispatcher can drive it. 2 tools (the observability route group), mounted on
// id.platform. VIRTUAL Tempo/Loki facade: no DB, no {sid}. Read-only debugging
// instrument: fetch a past request by trace_id or an agent session by
// agent_session_id. Both are POST custom actions (bodies can be 64 KB+).

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  AccessIdentityValueActorTypeEnum,
  usageMetaField,
  McpGetResponse,
} from '@gtm/mcp-shared';

// Loose item schemas: the full field set (span_tree, db_queries, errors,
// events_emitted, permission_decisions, turns …) is tightened by the Stage-1
// contract tests against live envelopes; passthrough keeps live responses valid.
// sid is not a prefixed 18-char sid here; it is the underlying UUID v7.
// Shared AccessIdentityValue (general/KNOWLEDGE.md); passthrough tolerates
// cross-service serialization drift.
const AccessIdentity = z.object({
  actor_type: AccessIdentityValueActorTypeEnum,
  actor_sid: z.string(),
  team_sid: z.string(),
  permissions: z.record(z.unknown()),
  request_sid: z.string().nullable().optional(),
  reason: z.string().nullable(),
}).passthrough();

// Recursive span tree (ObservabilitySpanNodeValue).
const ObservabilitySpanNode: z.ZodType<unknown> = z.lazy(() => z.object({
  span_id: z.string(),
  parent_span_id: z.string().nullable(),
  name: z.string(),
  kind: z.enum(['server', 'client', 'producer', 'consumer', 'internal']),
  started_at: z.string(),
  duration_ms: z.number(),
  status: z.enum(['ok', 'error', 'unset']),
  attributes: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
  events: z.array(z.object({
    name: z.string(),
    at: z.string(),
    attributes: z.record(z.unknown()),
  })),
  children: z.array(ObservabilitySpanNode),
}));

const ObservabilityRequest = z.object({
  sid: z.string(),
  trace_id: z.string(),
  agent_session_id: z.string().nullable(),
  agent_turn_id: z.string().nullable(),
  tool: z.string(),
  actor: AccessIdentity.nullable(),
  team_sid: z.string(),
  status: z.enum(['ok', 'error']),
  started_at: z.string(),
  duration_ms: z.number(),
  input: z.record(z.unknown()),
  output: z.record(z.unknown()),
  errors: z.array(z.object({
    code: z.string(),
    message: z.string(),
    path: z.array(z.string()).nullable(),
    span_id: z.string(),
  })),
  events_emitted: z.array(z.object({
    event_sid: z.string(),
    name: z.string(),
    payload_size: z.number(),
    emitted_at: z.string(),
  })),
  permission_decisions: z.array(z.object({
    policy: z.string(),
    decision: z.enum(['allow', 'deny']),
    reason: z.string(),
  })),
  child_calls: z.array(z.object({
    trace_id: z.string(),
    tool: z.string(),
    duration_ms: z.number(),
    status: z.enum(['ok', 'error']),
  })),
  db_queries: z.array(z.object({
    sql_fingerprint: z.string(),
    duration_ms: z.number(),
    rows: z.number(),
    table: z.string().nullable(),
    operation: z.enum(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'OTHER']),
  })),
  span_tree: ObservabilitySpanNode,
  debug_url: z.string(),
}).passthrough();

const ObservabilitySession = z.object({
  sid: z.string(),
  agent_session_id: z.string(),
  started_at: z.string(),
  last_activity_at: z.string(),
  duration_ms: z.number(),
  total_turns: z.number(),
  total_tool_calls: z.number(),
  actor: AccessIdentity.nullable(),
  team_sid: z.string().nullable(),
  turns: z.array(z.object({
    agent_turn_id: z.string(),
    started_at: z.string(),
    duration_ms: z.number(),
    tool_calls: z.array(z.object({
      trace_id: z.string(),
      tool: z.string(),
      started_at: z.string(),
      duration_ms: z.number(),
      status: z.enum(['ok', 'error']),
    })),
  })),
  debug_url: z.string(),
}).passthrough();

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const base = {
  service: 'id',
  entity: 'observability_requests',
  mount: 'id.platform',
} as const;

export const observabilityTools: ToolDefinition[] = [
  {
    ...base,
    name: 'get_observability_request',
    description:
      'Fetch the full execution of one past MCP request by trace_id: spans, timings, status, the redacted input/output bodies, errors, emitted events, permission decisions, DB queries and the span tree. Read-only debugging instrument (Tempo + Loki facade, no local storage). Use when a user pastes a trace_id and asks "what happened / why did this fail", or to introspect a past tool call. Returns not_found when the trace was sampled out or is past retention; 403 (not 404) when the trace belongs to another actor/team.',
    toolClass: 'complex',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/observability/get-request' },
    operation: 'get',
    envelope: 'get',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: z.object({
      trace_id: z.string().describe('The request trace_id (UUID v7, 36 chars).'),
      ...usageMetaField,
    }),
    outputSchema: McpGetResponse(ObservabilityRequest),
    annotations: { title: 'Get observability request', ...RO },
  },
  {
    ...base,
    name: 'get_observability_session',
    description:
      'Fetch the full tool-call history of one agent session by agent_session_id: total turns, total tool calls, and the per-turn tool-call breakdown. Read-only (Tempo + Loki facade). Use for post-mortems ("explain what my agent did / why it gave up") or handoff between agents. Returns not_found past retention; 403 when the session belongs to another actor/team.',
    toolClass: 'complex',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/observability/get-session' },
    operation: 'get',
    envelope: 'get',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: z.object({
      agent_session_id: z.string().describe('The agent session id (UUID v7, 36 chars).'),
      ...usageMetaField,
    }),
    outputSchema: McpGetResponse(ObservabilitySession),
    annotations: { title: 'Get observability session', ...RO },
  },
];
