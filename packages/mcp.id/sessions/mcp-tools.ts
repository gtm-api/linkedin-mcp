// Entity: Session (gtm.service.id)
// Source of truth: product/research/gtm.service.id/entities/sessions.md
// Format: registry v2. Each tool carries route metadata so the generic
// dispatcher can drive it. 2 tools (the sessions route group), mounted on
// id.identity. sessions is a token WHITELIST: no CRUD create/get/update/delete
// (minted by public-REST auth / OAuth flows); only search + the custom revoke
// verb, which is the canonical "end a session" for this entity.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  filterOp,
  usageMetaField,
  McpActionResponse,
  McpSearchRequestSchema,
  McpSearchResponse,
} from '@gtm/mcp-shared';

const SID = z.string().length(18).startsWith('id_se_')
  .describe('Session sid (id_se_…).');

const SessionStatus = z.enum(['active', 'revoked', 'expired']);
const SessionKind = z.enum(['login', 'oauth']);

const SessionSortable = z.enum(['last_active_at', 'created_at', 'expires_at']);

// Tight item projection: every SessionDomain field enumerated (research
// sessions.md #### Domain; no deleted_at, since sessions is a whitelist). Trailing
// .passthrough() tolerates forward-compatible additions.
const Session = z.object({
  sid: z.string(),
  team_sid: z.string(),
  user_sid: z.string(),
  status: SessionStatus,
  kind: SessionKind,
  oauth_client_sid: z.string().nullable(),        // populated iff kind='oauth'
  oauth_authorization_sid: z.string().nullable(), // the grant a kind='oauth' token was minted from
  device: z.string().nullable(),
  ip_hash: z.string().nullable(),
  last_active_at: z.string(),
  expires_at: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  is_current: z.boolean(),                        // derived per-request
}).passthrough();

// Counts shape documented in research (§ search: total_count + groups.{status,kind}).
const SessionCounts = z.object({
  total_count: z.number(),
  groups: z.record(z.unknown()), // dynamic breakdown, object even when empty
}).passthrough();

const SessionFilter = z.object({
  sid: filterOp(z.string(), ['eq', 'in']).optional(),
  user_sid: filterOp(z.string(), ['eq', 'in']).optional()
    .describe('Own sessions by default; other users require admin (sessions.view).'),
  team_sid: filterOp(z.string(), ['eq', 'in']).optional(),
  status: filterOp(SessionStatus, ['eq', 'ne', 'in', 'nin']).optional()
    .describe('Default scope = { eq: "active" }; pass explicitly for revoked/expired history.'),
  kind: filterOp(SessionKind, ['eq', 'in']).optional()
    .describe('kind:{eq:"oauth"} = "Connected agents".'),
  oauth_client_sid: filterOp(z.string(), ['eq', 'in', 'is_null']).optional()
    .describe('is_null:true = login sessions only.'),
  last_active_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  expires_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  created_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
}).partial();

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const DANGER = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

const base = {
  service: 'id',
  entity: 'sessions',
  mount: 'id.identity',
} as const;

export const sessionsTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_sessions',
    description:
      'List sessions. Default scope is the caller\'s own active sessions ("Active sessions"); pass kind:{eq:"oauth"} for "Connected agents", or status to see revoked/expired history. Each row carries the derived is_current flag (true for the caller\'s own request) so "log out everywhere except this device" can skip it. Returns a counts block. page_size:0 returns counts only.',
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/sessions/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: McpSearchRequestSchema(SessionFilter, undefined, SessionSortable)
      // The SearchRequest declares no include rule and the controller builds no
      // included block, so advertising the param would be a silent no-op.
      .omit({ include: true }),
    outputSchema: McpSearchResponse(Session, undefined, SessionCounts),
    annotations: { title: 'Search sessions', ...RO },
  },
  {
    ...base,
    name: 'revoke_session',
    description:
      'End a session immediately: status active → revoked. The token is rejected from the next request (verifier cache flushed within 30-60s). This is the canonical "delete" for this entity; there is no delete tool. Idempotent: revoking an already revoked/expired session returns the row with result.already_revoked:true.',
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/sessions/{sid}/revoke', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: SID, ...usageMetaField }),
    outputSchema: McpActionResponse(Session, z.object({
      already_revoked: z.boolean(),
      revoked_at: z.string().nullable(),
    })),
    annotations: { title: 'Revoke session', ...DANGER },
  },
];
