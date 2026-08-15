// Entity: OAuth Authorization (gtm.service.id)
// Source of truth: product/research/gtm.service.id/entities/oauth_authorizations.md
// Format: registry v2. Each tool carries route metadata so the generic
// dispatcher can drive it. 3 tools (the oauth-authorizations route group),
// mounted on id.access alongside api-keys / oauth-clients. User self-service:
// every read/write is implicitly scoped to the caller's own grants.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  filterOp,
  usageMetaField,
  McpActionResponse,
  McpUpdateResponse,
  McpSearchRequestSchema,
  McpSearchResponse,
} from '@gtm/mcp-shared';

const SID = z.string().length(18).startsWith('id_oa_')
  .describe('OAuth authorization (grant) sid (id_oa_…).');

const OauthAuthorizationStatus = z.enum(['active', 'revoked']);
const OauthTeamScopeMode = z.enum(['selected', 'all_my_teams']);

// Tight item projection: every OauthAuthorizationDomain field enumerated
// (research oauth_authorizations.md #### Domain; no created_by, no deleted_at,
// since the terminal state is status='revoked'). Trailing .passthrough() tolerates additions.
const OauthAuthorization = z.object({
  sid: z.string(),
  user_sid: z.string(),
  oauth_client_sid: z.string(),
  team_scope_mode: OauthTeamScopeMode,
  consented_team_sids: z.array(z.string()), // ts_tm_*; [] when all_my_teams
  permissions: z.array(z.string()),         // Permission[] subset of the client ceiling
  status: OauthAuthorizationStatus,
  last_used_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
}).passthrough();

// Counts shape documented in research (§ search: total_count + groups.status).
const OauthAuthorizationCounts = z.object({
  total_count: z.number(),
  groups: z.record(z.unknown()), // dynamic breakdown, object even when empty
}).passthrough();

const OauthAuthorizationFilter = z.object({
  oauth_client_sid: filterOp(z.string(), ['eq', 'in']).optional()
    .describe('Filter to one connected client.'),
  status: filterOp(OauthAuthorizationStatus, ['eq', 'in']).optional()
    .describe('active vs revoked (history).'),
  team_scope_mode: filterOp(OauthTeamScopeMode, ['eq']).optional()
    .describe('Which grants are all_my_teams vs selected.'),
  created_at: filterOp(z.string(), ['gte', 'lte']).optional()
    .describe('Connected-since window.'),
  last_used_at: filterOp(z.string(), ['gte', 'lte', 'is_null']).optional()
    .describe('is_null:true = never used; range = recently active.'),
}).partial();

const OauthAuthorizationInclude = z.enum(['client', 'teams', 'active_sessions']);

const OauthAuthorizationSortable = z.enum(['created_at', 'last_used_at']);

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
// Destructive but idempotent (already-revoked → revoked_sessions: 0).
const DANGER = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

const base = {
  service: 'id',
  entity: 'oauth_authorizations',
  mount: 'id.access',
} as const;

export const oauthAuthorizationsTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_oauth_authorizations',
    description:
      "List the caller's connected apps (standing OAuth consent grants). Always scoped to the caller's own grants, never cross-user. Filter by status (active vs revoked history), oauth_client_sid, or team_scope_mode; include client (name + ceiling), teams (in-scope team names), and active_sessions (live installation tokens). This is the user's view of who has access to their workspaces. page_size:0 returns counts only.",
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/oauth-authorizations/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    inputSchema: McpSearchRequestSchema(OauthAuthorizationFilter, OauthAuthorizationInclude, OauthAuthorizationSortable),
    outputSchema: McpSearchResponse(OauthAuthorization, undefined, OauthAuthorizationCounts),
    annotations: { title: 'Search connected apps', ...RO },
  },
  {
    ...base,
    name: 'revoke_oauth_authorization',
    description:
      'Disconnect an app: flip the grant to status=revoked, clear its refresh credential, and cascade-revoke every installation token (all teams) in one transaction, so the agent is cut off immediately. The envelope item is the post-action grant (it persists, revoked); result.revoked_sessions is the count cut. Idempotent (already-revoked → 0). 404 if the sid is not the caller\'s own grant.',
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/oauth-authorizations/{sid}/revoke', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: SID, ...usageMetaField }),
    outputSchema: McpActionResponse(OauthAuthorization),
    annotations: { title: 'Disconnect app (revoke grant)', ...DANGER },
  },
  {
    ...base,
    name: 'update_oauth_authorization',
    description:
      "Partial self-service edit of the grant's mutable fields WITHOUT re-running the browser consent: team_scope_mode, consented_team_sids (full-replace, non-empty when mode=selected), and permissions (full-replace, must stay ⊆ the client ceiling). Each submitted team is re-checked against live membership (403 if not a member). Narrowing is security-positive; you can never exceed the ceiling via update. Changes are frozen-at-mint, so live tokens keep their claims until their short TTL; use revoke for an immediate cut. At least one field required. 404 if not the caller's own grant.",
    toolClass: 'typical',
    route: { service: 'id', method: 'PATCH', pathTemplate: '/api/oauth-authorizations/{sid}', sidParam: 'sid' },
    operation: 'update',
    envelope: 'update',
    availability: 'ga',
    dangerous: false,
    inputSchema: z.object({
      sid: SID,
      team_scope_mode: OauthTeamScopeMode.optional(),
      consented_team_sids: z.array(z.string().length(18).startsWith('ts_tm_')).optional()
        .describe('FULL replacement; required + non-empty when the effective mode is selected; ignored for all_my_teams.'),
      permissions: z.array(z.string().max(128)).optional()
        .describe('FULL replacement; MUST be ⊆ the client\'s permission ceiling.'),
      ...usageMetaField,
    }),
    outputSchema: McpUpdateResponse(OauthAuthorization),
    annotations: { title: 'Edit connected app', ...WRITE },
  },
];
