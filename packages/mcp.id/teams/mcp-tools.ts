// Entity: Team (gtm.service.id)
// Source of truth: product/research/gtm.service.id/entities/teams.md
// Format: registry v2. Each tool carries route metadata so the generic
// dispatcher can drive it. 6 tools (the teams route group), mounted on
// id.identity alongside users / team-members / sessions.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  filterOp,
  usageMetaField,
  AccessIdentityValue,
  McpActionResponse,
  McpCascadeDeleteRequestSchema,
  McpCascadeDeleteResponse,
  McpCreateResponse,
  McpGetRequestSchema,
  McpGetResponse,
  McpSearchRequestSchema,
  McpSearchResponse,
  McpUpdateResponse,
} from '@gtm/mcp-shared';

const SID = z.string().length(18).startsWith('ts_tm_')
  .describe('Team sid (ts_tm_…).');
const USER_SID = z.string().length(18).startsWith('us_mb_')
  .describe('User sid (us_mb_…); must be an active member of this team.');

const TeamStatus = z.enum(['active', 'suspended']);

// Workspace settings (create / update body).
const TeamConfig = z.object({
  timezone: z.string().nullable().optional().describe('IANA tz for team-scoped scheduling defaults.'),
}).passthrough();

// Includes on search / get (see research Includes).
const TeamInclude = z.enum(['subscription', 'owner', 'members_counts']);

const TeamSortable = z.enum(['created_at', 'updated_at', 'name']);

// Tight item projection: every TeamDomain field enumerated (research teams.md
// #### Domain). Trailing .passthrough() tolerates forward-compatible additions.
const Team = z.object({
  sid: z.string(),
  owner_user_sid: z.string(),
  subscription_sid: z.string().nullable(),
  name: z.string(),
  status: TeamStatus,
  limits: z.object({                        // TeamLimitsValue (cache snapshot, NOT NULL)
    accounts: z.number(),
    cloud_browser: z.number(),
    webhooks: z.number(),
  }).passthrough(),                         // limit keys mirror billing-product limits (extensible)
  config: TeamConfig.nullable(),            // TeamConfigValue | null (Value schema above)
  created_by: AccessIdentityValue,
  created_at: z.string(),
  updated_at: z.string(),
  data_deletion_at: z.string().nullable(),
  deletion_warned_at: z.string().nullable(),
  deleted_at: z.string().nullable(),
}).passthrough();

// Counts shape documented in research (§ search: total_count + groups.status).
const TeamCounts = z.object({
  total_count: z.number(),
  groups: z.record(z.unknown()), // dynamic breakdown, object even when empty
}).passthrough();

const TeamFilter = z.object({
  sid: filterOp(z.string(), ['eq', 'in']).optional(),
  owner_user_sid: filterOp(z.string(), ['eq', 'in']).optional().describe('"teams I own".'),
  subscription_sid: filterOp(z.string(), ['eq', 'in', 'is_null']).optional()
    .describe('is_null:true = teams with no applied subscription.'),
  status: filterOp(TeamStatus, ['eq', 'ne', 'in']).optional(),
  q: z.string().optional().describe('Full-text LIKE (prefix/infix) over team name.'),
  created_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  deleted_at: filterOp(z.string(), ['is_null', 'gte', 'lte']).optional()
    .describe('Default scope is { is_null: true } (live rows).'),
}).partial();

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const DANGER = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

const base = {
  service: 'id',
  entity: 'teams',
  mount: 'id.identity',
} as const;

export const teamsTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_teams',
    description:
      'List the caller\'s teams ("my workspaces"): teams they are a member of, plus teams they own. Filter by status to find suspended workspaces, or by subscription_sid.is_null for teams with no capacity. q does an infix match on name. include[] hydrates subscription / owner / member counts. Returns a counts block. page_size:0 returns counts only.',
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/teams/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    inputSchema: McpSearchRequestSchema(TeamFilter, TeamInclude, TeamSortable),
    outputSchema: McpSearchResponse(Team, undefined, TeamCounts),
    annotations: { title: 'Search teams', ...RO },
  },
  {
    ...base,
    name: 'get_team',
    description: 'Fetch a single team by sid, with optional includes (applied subscription, owner, member counts).',
    toolClass: 'trivial',
    route: { service: 'id', method: 'GET', pathTemplate: '/api/teams/{sid}', sidParam: 'sid' },
    operation: 'get',
    envelope: 'get',
    availability: 'ga',
    dangerous: false,
    inputSchema: McpGetRequestSchema('ts_tm_', TeamInclude),
    outputSchema: McpGetResponse(Team),
    annotations: { title: 'Get team', ...RO },
  },
  {
    ...base,
    name: 'create_team',
    description:
      'Create a new workspace. The caller becomes the owner AND the first member; the free "Sandbox" plan (forever free, 1 account slot, no card) is applied automatically where the owner does not already run a free workspace. Names are not unique: every call creates a new team (no dedup).',
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/teams' },
    operation: 'create',
    envelope: 'create',
    availability: 'ga',
    dangerous: false,
    inputSchema: z.object({
      name: z.string().min(1).max(255),
      config: TeamConfig.nullable().optional().describe('Optional workspace settings; default null.'),
      ...usageMetaField,
    }),
    outputSchema: McpCreateResponse(Team),
    annotations: { title: 'Create team', ...CREATE },
  },
  {
    ...base,
    name: 'update_team',
    description:
      'Rename a team or edit its config. Only name / config are mutable; owner_user_sid (transfer-ownership), status (derived), subscription_sid (apply/unapply) and limits (system) are read-only and silently rejected. At least one field required.',
    toolClass: 'typical',
    route: { service: 'id', method: 'PATCH', pathTemplate: '/api/teams/{sid}', sidParam: 'sid' },
    operation: 'update',
    envelope: 'update',
    availability: 'ga',
    dangerous: false,
    inputSchema: z.object({
      sid: SID,
      name: z.string().min(1).max(255).optional(),
      config: TeamConfig.nullable().optional(),
      ...usageMetaField,
    }),
    outputSchema: McpUpdateResponse(Team),
    annotations: { title: 'Update team', ...WRITE },
  },
  {
    ...base,
    name: 'delete_team',
    description:
      'Cascade soft-delete a workspace and its owned rows (members, keys, sessions, oauth clients, certs). Owner-only. DESTRUCTIVE. Blocked (409 delete_blocked) while a paid applied subscription is live. Unapply/cancel it first; clear soft blockers (active keys / members) with acknowledge[]. Deleting the owner\'s LAST workspace is allowed and leaves their ACCOUNT untouched: they are left with no workspace until their next sign-in provisions a replacement. Erasing an account is a separate deliberate act, never a side effect of this tool.',
    toolClass: 'typical',
    route: { service: 'id', method: 'DELETE', pathTemplate: '/api/teams/{sid}', sidParam: 'sid' },
    operation: 'delete',
    envelope: 'delete_cascade',
    availability: 'ga',
    dangerous: true,
    inputSchema: McpCascadeDeleteRequestSchema('ts_tm_', z.enum(['revoke_keys', 'remove_members'])).extend({
      next_default_team_sid: z.string().length(18).startsWith('ts_tm_').optional()
        .describe('Which of the caller\'s other live memberships becomes their working team afterwards; default is the oldest one. 422 if it is not an active membership of theirs in another live team.'),
    }),
    outputSchema: McpCascadeDeleteResponse,
    annotations: { title: 'Delete team', ...DANGER },
  },
  {
    ...base,
    name: 'transfer_team_ownership',
    description:
      'Move structural ownership of the team to another active member. Owner-only (an admin cannot transfer). Transferring to the current owner is a no-op. This is the only way to change owner_user_sid, and the prerequisite for the current owner to leave the team.',
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/teams/{sid}/transfer-ownership', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID,
      new_owner_user_sid: USER_SID,
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(Team),
    annotations: { title: 'Transfer team ownership', ...DANGER },
  },
];
