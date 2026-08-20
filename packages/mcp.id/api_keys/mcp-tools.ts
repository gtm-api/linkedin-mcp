// Entity: API Key (gtm.service.id)
// Source of truth: product/research/gtm.service.id/entities/api_keys.md
// Format: registry v2. Each tool carries route metadata so the generic
// dispatcher can drive it. 7 tools (the api-keys route group), mounted on
// id.access alongside oauth-clients / oauth-authorizations.

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
  McpMetricsResponse,
  McpMetricsRequestSchema,
  McpGetRequestSchema,
  McpGetResponse,
  McpSimpleDeleteRequestSchema,
  McpSearchRequestSchema,
  McpSearchResponse,
} from '@gtm/mcp-shared';

const SID = z.string().length(18).startsWith('id_ak_')
  .describe('API key sid (id_ak_…).');

const ApiKeyStatus = z.enum(['active', 'revoked', 'expired']);

// Tight item projection: every ApiKeyDomain field enumerated (research
// api_keys.md #### Domain). token_prefix / token_last4 are the masked display
// fields (NOT NULL, always present), NOT the secret. Trailing .passthrough().
const ApiKey = z.object({
  sid: z.string(),
  team_sid: z.string(),
  name: z.string(),
  token_prefix: z.string(),
  token_last4: z.string(),
  permissions: z.array(z.string()),         // Permission[] (unified token list)
  status: ApiKeyStatus,
  expires_at: z.string().nullable(),        // null = perpetual
  last_used_at: z.string().nullable(),
  created_by: AccessIdentityValue,
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
  // One-time secret: surfaced ONLY in the create envelope extra and the
  // rotate result; every read masks it to token_prefix / token_last4.
  // NEVER required on search/get; always .nullable().optional().
  plaintext_token: z.string().nullable().optional(),
}).passthrough();

// Counts shape documented in research (§ search: total_count + groups.status).
const ApiKeyCounts = z.object({
  total_count: z.number(),
  groups: z.record(z.unknown()), // dynamic breakdown, object even when empty
}).passthrough();

// Metrics shape documented in research (§ metrics: ApiKeyMetrics).
// The metrics leaf holds only period-scoped computed fields; status tallies
// (active/revoked/expired) live in counts.groups.status, not here.
const ApiKeyMetrics = z.object({
  created_in_period: z.number(),
  expired_in_period: z.number(),
  last_used_at: z.string().nullable(),
}).passthrough();

const ApiKeyFilter = z.object({
  sid: filterOp(z.string(), ['eq', 'in']).optional(),
  status: filterOp(ApiKeyStatus, ['eq', 'ne', 'in', 'nin']).optional(),
  name: filterOp(z.string(), ['eq']).optional()
    .describe('Match on the human-readable key name.'),
  created_by_actor_sid: filterOp(z.string(), ['eq', 'in']).optional()
    .describe('Issuer slice: keys created by this teammate (us_mb_) or parent key (id_ak_); offboarding.'),
  expires_at: filterOp(z.string(), ['is_null', 'gte', 'lte', 'gt', 'lt']).optional()
    .describe('is_null:true = perpetual keys; range = expiring-between.'),
  last_used_at: filterOp(z.string(), ['is_null', 'gte', 'lte', 'gt', 'lt']).optional()
    .describe('is_null:true = never used; lt = stale keys.'),
  created_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  deleted_at: filterOp(z.string(), ['is_null', 'gte', 'lte']).optional()
    .describe('Default scope is { is_null: true } (live rows).'),
}).partial();

const ApiKeyInclude = z.enum(['metrics']);

const ApiKeySortable = z.enum(['created_at', 'last_used_at', 'expires_at', 'name']);

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
// Destructive but idempotent (delete = revoke; create dedups by natural key).
const DANGER = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
// Destructive and NOT idempotent (rotate mints a brand-new secret each call).
const DANGER_ONCE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

const base = {
  service: 'id',
  entity: 'api_keys',
  mount: 'id.access',
} as const;

export const apiKeysTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_api_keys',
    description:
      "List the team's API keys for an access audit: which keys exist, what each can do (permissions), their status, when each was last_used_at and when each expires. Filter by status for live vs dead keys, by last_used_at.lt for stale keys to revoke at offboarding, or by expires_at for keys expiring soon. The secret is never returned (only token_prefix + token_last4). include:[\"metrics\"] attaches per-key counts; page_size:0 returns counts only.",
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/api-keys/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    inputSchema: McpSearchRequestSchema(ApiKeyFilter, ApiKeyInclude, ApiKeySortable),
    outputSchema: McpSearchResponse(ApiKey, undefined, ApiKeyCounts),
    annotations: { title: 'Search API keys', ...RO },
  },
  {
    ...base,
    name: 'get_api_key',
    description:
      'Fetch a single API key by sid, with optional metrics include. Returns token_prefix + token_last4 for display; the secret is unrecoverable (use rotate_api_key to mint a new one).',
    toolClass: 'trivial',
    route: { service: 'id', method: 'GET', pathTemplate: '/api/api-keys/{sid}', sidParam: 'sid' },
    operation: 'get',
    envelope: 'get',
    availability: 'ga',
    dangerous: false,
    inputSchema: McpGetRequestSchema('id_ak_', ApiKeyInclude),
    outputSchema: McpGetResponse(ApiKey),
    annotations: { title: 'Get API key', ...RO },
  },
  {
    ...base,
    name: 'create_api_key',
    description:
      'Issue a new API key and return the full secret in the create envelope\'s plaintext_token EXACTLY ONCE. It is unrecoverable, so hand it to the user immediately and never log or echo it; if lost, rotate. Callable by a human (api_keys.manage) or by a parent api_key, in which case the issued permissions MUST be a subset of the parent\'s (downscoping only; escalation → 403). Default expires_at = now + 3 years; pass null for a perpetual key. Natural key (team_sid, name) among non-revoked keys → a duplicate returns already_exists with the existing key (and NO secret).',
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/api-keys' },
    operation: 'create',
    envelope: 'create',
    availability: 'ga',
    dangerous: true,
    allowSecretFields: ['plaintext_token'],
    inputSchema: z.object({
      name: z.string().min(1).max(255).describe('Human-readable key name; unique among the team\'s non-revoked keys.'),
      permissions: z.array(z.string().max(128))
        .describe('Unified permission list; must be ⊆ the parent key on delegation.'),
      expires_at: z.string().nullable().optional()
        .describe('ISO 8601 UTC; omit = now + 3 years; null = perpetual.'),
      ...usageMetaField,
    }),
    outputSchema: McpCreateResponse(ApiKey),
    annotations: { title: 'Create API key', ...DANGER },
  },
  {
    ...base,
    name: 'update_api_key',
    description:
      'Partial update of name / permissions only (the key\'s identity and secret are untouched; use rotate_api_key to change the secret). permissions is a FULL replacement. When the caller is a parent api_key, the new permissions must still be a subset of the parent\'s (→ 403). At least one field is required.',
    toolClass: 'typical',
    route: { service: 'id', method: 'PATCH', pathTemplate: '/api/api-keys/{sid}', sidParam: 'sid' },
    operation: 'update',
    envelope: 'update',
    availability: 'ga',
    dangerous: false,
    inputSchema: z.object({
      sid: SID,
      name: z.string().min(1).max(255).optional(),
      permissions: z.array(z.string().max(128)).optional()
        .describe('FULL replacement of the key\'s permission list.'),
      ...usageMetaField,
    }),
    outputSchema: McpUpdateResponse(ApiKey),
    annotations: { title: 'Update API key', ...WRITE },
  },
  {
    ...base,
    name: 'delete_api_key',
    description:
      'Revoke a key (simple soft-delete): status=revoked, deleted_at set. Verify rejects it from the next request (cache invalidated). Irreversible: a revoked key never re-activates; issue a fresh one. Idempotent: re-deleting → already_deleted.',
    toolClass: 'trivial',
    route: { service: 'id', method: 'DELETE', pathTemplate: '/api/api-keys/{sid}', sidParam: 'sid' },
    operation: 'delete',
    envelope: 'delete_simple',
    availability: 'ga',
    dangerous: true,
    inputSchema: McpSimpleDeleteRequestSchema('id_ak_'),
    outputSchema: McpSimpleDeleteResponse,
    annotations: { title: 'Revoke API key', ...DANGER },
  },
  {
    ...base,
    name: 'get_api_keys_metrics',
    description:
      "Period-bound counts of the team's keys by status, plus issuance / expiry tallies inside the window (created_in_period, expired_in_period). Requires period {from, to}. Optional filter. Counts key rows, not key traffic; for per-key request usage use observability.",
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/api-keys/metrics' },
    operation: 'metrics',
    envelope: 'metrics',
    availability: 'ga',
    dangerous: false,
    inputSchema: McpMetricsRequestSchema(ApiKeyFilter).extend({
      period: z.object({
        from: z.string().describe('ISO 8601 UTC window start (inclusive).'),
        to: z.string().describe('ISO 8601 UTC window end; must be at or after from.'),
      }).describe('Required metrics window [from, to).'),
      group_by: z.enum(['status']).nullable().optional()
        .describe('Split the aggregate by key status instead of returning one total.'),
    }),
    outputSchema: McpMetricsResponse(ApiKeyMetrics),
    annotations: { title: 'API key metrics', ...RO },
  },
  {
    ...base,
    name: 'rotate_api_key',
    description:
      'Swap the key\'s secret IN PLACE and return the new plaintext in result.plaintext_token EXACTLY ONCE: hand it to the user, never log it, unrecoverable. The key\'s sid / name / permissions / expires_at are unchanged. The previous secret stays valid until result.previous_token_expires_at (now + grace_seconds, default 24h) so the agent can update config without downtime. Use when a secret leaks or before offboarding. NOT idempotent: each call mints a brand-new secret. Rotating a revoked/expired key → 409.',
    toolClass: 'complex',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/api-keys/{sid}/rotate', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    massAction: false,
    scheduleRequired: false,
    allowSecretFields: ['plaintext_token'],
    inputSchema: z.object({
      sid: SID,
      grace_seconds: z.number().int().min(0).max(604800).optional()
        .describe('0..604800 (≤7d); omit = 24h default; 0 = immediate cutover.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(ApiKey),
    annotations: { title: 'Rotate API key', ...DANGER_ONCE },
  },
];
