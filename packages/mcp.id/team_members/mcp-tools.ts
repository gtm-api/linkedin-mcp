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
      'Invite a person by email. Born status=invited, user_sid=null, with a one-time code (+7d expiry); dispatches the invite email. permissions is the explicit token list (expand a UI preset in code first); account_sids is the optional profile slice (null/omitted = all team profiles). Natural key (team, email) over live rows; re-inviting a live member returns already_exists:true.',
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/team-members' },
    operation: 'create',
    envelope: 'create',
    availability: 'ga',
    dangerous: false,
    inputSchema: z.object({
      email: z.string().email().max(255),
      permissions: z.array(z.string().max(128)).describe('Unified permission tokens; [] = membership only.'),
      account_sids: z.array(ACCOUNT_SID).nullable().optional()
        .describe('Profile slice; null/omitted = all team profiles.'),
      ...usageMetaField,
    }),
    outputSchema: McpCreateResponse(TeamMember),
    annotations: { title: 'Invite team member', ...WRITE },
  },
  {
    ...base,
    name: 'update_team_member',
    description:
      "Re-scope an existing member: replace permissions and/or account_sids. email / status / user_sid / team_sid are read-only (rejected silently). At least one field required. Updating the owner's permissions is allowed but cannot strip ownership (use transfer_team_ownership).",
    toolClass: 'typical',
    route: { service: 'id', method: 'PATCH', pathTemplate: '/api/team-members/{sid}', sidParam: 'sid' },
    operation: 'update',
    envelope: 'update',
    availability: 'ga',
    dangerous: false,
    inputSchema: z.object({
      sid: SID,
      permissions: z.array(z.string().max(128)).optional(),
      account_sids: z.array(ACCOUNT_SID).nullable().optional()
        .describe('null resets to "all profiles".'),
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
      'Accept a pending invite by its one-time code. Public REST: code-bearer, no team scope. Hashes the code, matches a live invited row with an unexpired code, flips invited → active, binds the authenticated user_sid, and sets users.default_team_sid if the user had none. Idempotent for the same user (already_accepted:true).',
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
