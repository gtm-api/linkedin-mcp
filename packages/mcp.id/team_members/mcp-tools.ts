// Entity: Team Member (gtm.service.id)
// Source of truth: product/research/gtm.service.id/entities/team_members.md
// Format: registry v2. Each tool carries route metadata so the generic
// dispatcher can drive it. 6 tools (the team-members route group), mounted on
// id.identity alongside users / teams / sessions. `create` = invite by email;
// `delete` = remove invite / kick member (owner-protected → 409);
// accept-invitation is public REST (code-bearer) but still a registered tool.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  filterOp,
  usageMetaField,
  AccessIdentityValue,
  McpActionResponse,
  McpCreateResponse,
  McpSearchRequestSchema,
  McpSearchResponse,
  McpSimpleDeleteRequestSchema,
  McpSimpleDeleteResponse,
  McpUpdateResponse,
} from '@gtm/mcp-shared';

const SID = z.string().length(18).startsWith('ts_mb_')
  .describe('Team-member (membership/invite) sid (ts_mb_…).');
const ACCOUNT_SID = z.string().length(18).startsWith('ln_ac_')
  .describe('Connected-account sid (ln_ac_…): a member profile-slice entry.');

const TeamMemberStatus = z.enum(['invited', 'active', 'revoked']);

// Includes on search (see research Includes).
const TeamMemberInclude = z.enum(['user']);

const TeamMemberSortable = z.enum(['created_at', 'updated_at', 'email']);

// Tight item projection: every TeamMemberDomain field enumerated (research
// team_members.md #### Domain). Trailing .passthrough() tolerates additions.
const TeamMember = z.object({
  sid: z.string(),
  team_sid: z.string(),
  user_sid: z.string().nullable(),          // null while invited; bound on accept
  email: z.string(),
  status: TeamMemberStatus,
  permissions: z.array(z.string()),         // Permission[] (unified token list)
  account_sids: z.array(z.string()).nullable(), // ln_ac_* slice; null = all profiles
  created_by: AccessIdentityValue,
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
}).passthrough();

// Counts shape documented in research (§ search: total_count + groups.status).
const TeamMemberCounts = z.object({
  total_count: z.number(),
  groups: z.record(z.unknown()), // dynamic breakdown, object even when empty
}).passthrough();

const TeamMemberFilter = z.object({
  sid: filterOp(z.string(), ['eq', 'in']).optional(),
  user_sid: filterOp(z.string(), ['eq', 'in', 'is_null']).optional()
    .describe('is_null:true = pending invites (not yet accepted).'),
  email: filterOp(z.string(), ['eq', 'in']).optional(),
  status: filterOp(TeamMemberStatus, ['eq', 'ne', 'in', 'nin']).optional(),
  created_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  deleted_at: filterOp(z.string(), ['is_null', 'gte', 'lte']).optional()
    .describe('Default scope is { is_null: true } (live rows).'),
  q: z.string().optional().describe('Full-text LIKE (prefix/infix) over member email.'),
}).partial();

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const ACT = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DANGER = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

const base = {
  service: 'id',
  entity: 'team_members',
  mount: 'id.identity',
} as const;

/**
 * The grantable vocabulary, mirroring `PermissionCatalog::gtmSurface()` (43
 * tokens) plus the wildcard - the backend validates `permissions.*` with
 * Rule::in over exactly this list, and the contract-parity gate holds this
 * enum equal to that rule, so a catalog change fails the build here instead
 * of leaving agents to guess.
 */
const PERMISSION_TOKEN = z.enum([
  'can_view_teams', 'can_manage_teams',
  'can_view_team_members', 'can_manage_team_members',
  'can_view_api_keys', 'can_manage_api_keys',
  'can_view_oauth_clients', 'can_manage_oauth_clients',
  'can_view_sessions', 'can_manage_sessions',
  'can_view_account_shares', 'can_manage_account_shares',
  'can_manage_account_transfers',
  'can_view_billing', 'can_manage_billing',
  'can_view_ssl_certificates', 'can_manage_ssl_certificates',
  'can_view_notifications', 'can_manage_notifications',
  'can_view_support_requests', 'can_manage_support_requests',
  'can_view_linkedin_connections', 'can_act_linkedin_connections',
  'can_view_linkedin_messages', 'can_act_linkedin_messages',
  'can_act_linkedin_engagements',
  'can_view_linkedin_searches', 'can_act_linkedin_searches',
  'can_view_linkedin_enrichment', 'can_act_linkedin_enrichment',
  'can_view_linkedin_accounts',
  'can_update_linkedin_accounts',
  'can_manage_linkedin_accounts',
  'can_open_cloud_browser',
  'can_change_proxy',
  'can_edit_schedule',
  'can_manage_smart_limits',
  'can_manage_cloud_browser_external_links',
  'can_act_linkedin_custom_requests',
  'can_view_mass_actions', 'can_manage_mass_actions',
  'can_view_webhooks', 'can_manage_webhooks',
  // Email-channel tokens (catalog grew with the email account slice, 2026-08-27).
  'can_view_email_accounts', 'can_update_email_accounts', 'can_manage_email_accounts',
  'can_view_email_messages', 'can_act_email_messages',
  'can_view_email_engagements',
  'can_view_email_suppressions', 'can_manage_email_suppressions',
  'can_view_email_tracking_domains', 'can_manage_email_tracking_domains',
  'can_view_email_sending_domains', 'can_manage_email_sending_domains',
  '*',
]);

export const teamMembersTools: ToolDefinition[] = [

  {
    ...base,
    name: 'search_team_members',
    description:
      "List members and pending invites in the caller's team: render the Members tab, find pending invites (filter.user_sid.is_null or filter.status.eq=\"invited\"), or look up a member by email (q). include:[\"user\"] hydrates the resolved profile (absent for pending invites). Returns a counts block. page_size:0 returns counts only.",
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/team-members/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    inputSchema: McpSearchRequestSchema(TeamMemberFilter, TeamMemberInclude, TeamMemberSortable),
    outputSchema: McpSearchResponse(TeamMember, undefined, TeamMemberCounts),
    annotations: { title: 'Search team members', ...RO },
  },
  {
    ...base,
    name: 'resend_team_member_invitation',
    description:
      'Re-roll the one-time code on a pending invite, push its expiry (+7d), and re-send the invite email. Only valid on a status=invited row (else 409 invalid_transition).',
    toolClass: 'trivial',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/team-members/{sid}/resend-invitation', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: SID, ...usageMetaField }),
    outputSchema: McpActionResponse(TeamMember),
    annotations: { title: 'Resend team-member invitation', ...ACT },
  },
  {
    ...base,
    name: 'create_team_member',
    description:
      "Invite a person by email. Born status=invited, user_sid=null, with a one-time code (+7d expiry); dispatches the invite email. permissions is the explicit token list validated against the catalog (403 grant_exceeds_ceiling when it exceeds the CALLER's own grant; '*' is grantable only by the owner or a wildcard holder; can_view_teams is always added - the membership floor). account_sids is the optional profile slice (null/omitted = all team profiles; an explicit empty list is refused, and a sliced caller cannot grant beyond their own slice). Natural key (team, email) over live rows; re-inviting a live member returns already_exists:true.",
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/team-members' },
    operation: 'create',
    envelope: 'create',
    availability: 'ga',
    dangerous: false,
    inputSchema: z.object({
      email: z.string().email().max(255),
      permissions: z.array(PERMISSION_TOKEN).describe('Unified catalog tokens; the can_view_teams floor is always unioned in.'),
      account_sids: z.array(ACCOUNT_SID).min(1).nullable().optional()
        .describe('Profile slice; null/omitted = all team profiles. An empty list is refused (422).'),
      ...usageMetaField,
    }),
    outputSchema: McpCreateResponse(TeamMember),
    annotations: { title: 'Invite team member', ...WRITE },
  },
  {
    ...base,
    name: 'update_team_member',
    description:
      "Re-scope an existing member: replace permissions and/or account_sids. email / status / user_sid / team_sid are read-only (rejected silently). At least one field with an ACTUAL change required (a value-identical PATCH answers 422 nothing_to_update). The change applies immediately: the member's live tokens are invalidated and re-minted with the new grant on their next request (agents re-exchange). Bounded by the caller's own grant (403 grant_exceeds_ceiling); the structural owner's seat is not re-scopable (409 owner_cannot_be_rescoped - move ownership via transfer_team_ownership).",
    toolClass: 'typical',
    route: { service: 'id', method: 'PATCH', pathTemplate: '/api/team-members/{sid}', sidParam: 'sid' },
    operation: 'update',
    envelope: 'update',
    availability: 'ga',
    dangerous: false,
    inputSchema: z.object({
      sid: SID,
      permissions: z.array(PERMISSION_TOKEN).optional()
        .describe('Full replacement; the can_view_teams floor is always unioned in.'),
      account_sids: z.array(ACCOUNT_SID).min(1).nullable().optional()
        .describe('null resets to "all profiles"; an empty list is refused (422).'),
      ...usageMetaField,
    }),
    outputSchema: McpUpdateResponse(TeamMember),
    annotations: { title: 'Update team member', ...WRITE },
  },
  {
    ...base,
    name: 'delete_team_member',
    description:
      'Remove a pending invite OR kick an active member: one tool, soft-delete. DESTRUCTIVE. The structural owner is protected (409 conflict, owner_cannot_be_removed); move ownership via transfer_team_ownership first. Kicking a member revokes their sessions in this team only.',
    toolClass: 'typical',
    route: { service: 'id', method: 'DELETE', pathTemplate: '/api/team-members/{sid}', sidParam: 'sid' },
    operation: 'delete',
    envelope: 'delete_simple',
    availability: 'ga',
    dangerous: true,
    inputSchema: McpSimpleDeleteRequestSchema('ts_mb_'),
    outputSchema: McpSimpleDeleteResponse,
    annotations: { title: 'Remove team member', ...DANGER },
  },
  {
    ...base,
    name: 'accept_team_member_invitation',
    description:
      'Accept a pending invite by its one-time code. Public REST: code-bearer, no team scope. Hashes the code, matches the row it belongs to and branches on that row: invited → flips invited → active, binds the authenticated user_sid, and sets users.default_team_sid if the user had none; already active for the SAME user → 200 already_accepted:true naming that same invite; already redeemed by another account → 409 invitation_already_redeemed; no row (unknown, cancelled, or the membership was removed) → 404. An expired code is 409 invitation_expired, a seatless plan 402.',
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/team-members/accept-invitation' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      code: z.string().min(1).max(255).describe('Raw one-time invite code from the email link.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(TeamMember),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true, title: 'Accept team-member invitation' },
  },
];
