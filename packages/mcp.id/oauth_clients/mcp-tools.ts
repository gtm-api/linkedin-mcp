// Entity: OAuth Client (gtm.service.id)
// Source of truth: product/research/gtm.service.id/entities/oauth_clients.md
// Format: registry v2. Each tool carries route metadata so the generic
// dispatcher can drive it. 5 tools (the oauth-clients route group), mounted on
// id.access alongside api-keys / oauth-authorizations.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  filterOp,
  usageMetaField,
  AccessIdentityValue,
  McpCreateResponse,
  McpUpdateResponse,
  McpSimpleDeleteResponse,
  McpGetRequestSchema,
  McpGetResponse,
  McpSimpleDeleteRequestSchema,
  McpSearchRequestSchema,
  McpSearchResponse,
} from '@gtm/mcp-shared';

const SID = z.string().length(18).startsWith('id_oc_')
  .describe('OAuth client sid (id_oc_…).');

const OauthClientStatus = z.enum(['active', 'disabled']);
const OauthGrantType = z.enum(['authorization_code', 'refresh_token']);
const OauthRegistrationKind = z.enum(['manual', 'dynamic']);

// Tight item projection: every OauthClientDomain field enumerated (research
// oauth_clients.md #### Domain). Trailing .passthrough() tolerates additions.
const OauthClient = z.object({
  sid: z.string(),
  team_sid: z.string().nullable(),          // null = platform/public client
  name: z.string(),
  client_id: z.string(),
  redirect_uris: z.array(z.string()),
  grant_types: z.array(OauthGrantType),
  permissions: z.array(z.string()),         // Permission[] ceiling (unified token list)
  is_confidential: z.boolean(),
  registration_kind: OauthRegistrationKind,
  status: OauthClientStatus,
  created_by: AccessIdentityValue,
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
  // One-time secret: surfaced ONLY in the create envelope for a confidential
  // client (is_confidential=true, fast-follow); NULL / absent for public/PKCE
  // (v1). Never returned on any read. NEVER required, so .nullable().optional().
  client_secret: z.string().nullable().optional(),
}).passthrough();

// Counts shape documented in research (§ search: total_count + groups.{status,
// registration_kind,is_confidential}).
const OauthClientCounts = z.object({
  total_count: z.number(),
  groups: z.record(z.unknown()), // dynamic breakdown, object even when empty
}).passthrough();

const OauthClientFilter = z.object({
  sid: filterOp(z.string(), ['eq', 'in']).optional(),
  team_sid: filterOp(z.string(), ['eq', 'in', 'is_null']).optional()
    .describe('is_null:true = platform clients (owned by no team).'),
  client_id: filterOp(z.string(), ['eq', 'in']).optional()
    .describe('Exact public identifier lookup.'),
  name: filterOp(z.string(), ['eq']).optional()
    .describe('Match on the human-readable client name.'),
  status: filterOp(OauthClientStatus, ['eq', 'in']).optional(),
  is_confidential: filterOp(z.boolean(), ['eq']).optional()
    .describe('public/PKCE (false) vs confidential (true).'),
  registration_kind: filterOp(OauthRegistrationKind, ['eq', 'in']).optional(),
  created_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  deleted_at: filterOp(z.string(), ['is_null', 'gte', 'lte']).optional()
    .describe('Default scope is { is_null: true } (live rows).'),
}).partial();

const OauthClientInclude = z.enum(['active_sessions']);

const OauthClientSortable = z.enum(['created_at', 'name']);

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
// Destructive but idempotent (delete = soft-delete + cascade-revoke, re-run → already_deleted).
const DANGER = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
// Destructive and NOT idempotent (create mints a fresh client_id each call).
const DANGER_ONCE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

const base = {
  service: 'id',
  entity: 'oauth_clients',
  mount: 'id.access',
} as const;

export const oauthClientsTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_oauth_clients',
    description:
      "List registered OAuth applications for the caller's team (plus platform clients when team_sid.is_null). Filter by status, client_id, registration_kind, is_confidential; include:[\"active_sessions\"] to see the agents connected through each app (requires sessions.view). No full-text: filter by name / client_id. page_size:0 returns counts only.",
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/oauth-clients/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: McpSearchRequestSchema(OauthClientFilter, OauthClientInclude, OauthClientSortable),
    outputSchema: McpSearchResponse(OauthClient, undefined, OauthClientCounts),
    annotations: { title: 'Search OAuth clients', ...RO },
  },
  {
    ...base,
    name: 'get_oauth_client',
    description:
      'Fetch one OAuth client by sid. include:["active_sessions"] lists agents connected through it (requires sessions.view). client_secret is never returned on a read.',
    toolClass: 'trivial',
    route: { service: 'id', method: 'GET', pathTemplate: '/api/oauth-clients/{sid}', sidParam: 'sid' },
    operation: 'get',
    envelope: 'get',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: McpGetRequestSchema('id_oc_', OauthClientInclude),
    outputSchema: McpGetResponse(OauthClient),
    annotations: { title: 'Get OAuth client', ...RO },
  },
  {
    ...base,
    name: 'create_oauth_client',
    description:
      'Register a new OAuth application; the server generates client_id. v1 clients are public/PKCE (no secret). A confidential client (fast-follow) returns client_secret in the create envelope ONCE. Tell the user to store it; it is unrecoverable and must never be logged. permissions is the ceiling the client may request; redirect_uris is an exact-match https allow-list (closes open-redirect). Dedup (team_sid, name) → already_exists. Set platform:true (admin only) to register a platform client with no owning team.',
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/oauth-clients' },
    operation: 'create',
    envelope: 'create',
    availability: 'ga',
    dangerous: true,
    creditable: false,
    allowSecretFields: ['client_secret'],
    inputSchema: z.object({
      name: z.string().min(1).max(255),
      redirect_uris: z.array(z.string().url().startsWith('https://').max(2048)).min(1)
        .describe('Exact-match https allow-list (at least one entry).'),
      permissions: z.array(z.string().max(128))
        .describe('Unified permission ceiling the client may request.'),
      grant_types: z.array(OauthGrantType).min(1).optional()
        .describe('Default: [authorization_code, refresh_token].'),
      platform: z.boolean().optional()
        .describe('Admin only: register a platform client (team_sid = null) instead of a team client.'),
      ...usageMetaField,
    }),
    outputSchema: McpCreateResponse(OauthClient),
    annotations: { title: 'Create OAuth client', ...DANGER_ONCE },
  },
  {
    ...base,
    name: 'update_oauth_client',
    description:
      'Partial update. Editable: name, redirect_uris, permissions, grant_types, status (redirect_uris / permissions full-replace). status:"disabled" cascade-revokes the client\'s oauth grants and issued tokens. Tightening permissions affects only future mints: live tokens keep their frozen set; use disabled / delete for an immediate cut. client_id / is_confidential / registration_kind are not editable. At least one field required.',
    toolClass: 'typical',
    route: { service: 'id', method: 'PATCH', pathTemplate: '/api/oauth-clients/{sid}', sidParam: 'sid' },
    operation: 'update',
    envelope: 'update',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: z.object({
      sid: SID,
      name: z.string().min(1).max(255).optional(),
      redirect_uris: z.array(z.string().url().startsWith('https://').max(2048)).min(1).optional()
        .describe('FULL replacement of the exact-match https allow-list.'),
      permissions: z.array(z.string().max(128)).optional()
        .describe('FULL replacement of the permission ceiling.'),
      grant_types: z.array(OauthGrantType).min(1).optional(),
      status: OauthClientStatus.optional()
        .describe('disabled cascade-revokes the client\'s grants + issued tokens.'),
      ...usageMetaField,
    }),
    outputSchema: McpUpdateResponse(OauthClient),
    annotations: { title: 'Update OAuth client', ...WRITE },
  },
  {
    ...base,
    name: 'delete_oauth_client',
    description:
      "Destructive. Soft-delete the client (sets deleted_at) and cascade-revoke every issued oauth session and grant, disconnecting all agents connected through this app immediately. The public OAuth flow rejects a soft-deleted client. Idempotent: re-deleting → already_deleted. The client's sessions survive as revoked-not-deleted (retained).",
    toolClass: 'typical',
    route: { service: 'id', method: 'DELETE', pathTemplate: '/api/oauth-clients/{sid}', sidParam: 'sid' },
    operation: 'delete',
    envelope: 'delete_simple',
    availability: 'ga',
    dangerous: true,
    creditable: false,
    inputSchema: McpSimpleDeleteRequestSchema('id_oc_'),
    outputSchema: McpSimpleDeleteResponse,
    annotations: { title: 'Delete OAuth client', ...DANGER },
  },
];
