// Entity: LinkedIn Account (gtm.service.linkedin)
// Source of truth: product/research/gtm.service.linkedin/entities/linkedin_accounts.md
// Format: registry v2, where each tool carries route metadata so the generic
// dispatcher can drive it. 17 tools (the linkedin-accounts route group);
// smart-limits (3 more) share the /mcp/linkedin/accounts mount from their own
// entity file.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  AccessIdentityValueActorTypeEnum,
  HandoverRoleEnum,
  filterOp,
  usageMetaField,
  McpActionResponse,
  McpAsyncActionResponse,
  McpGetRequestSchema,
  McpGetResponse,
  McpSearchRequestSchema,
  McpSearchResponse,
} from '@gtm/mcp-shared';

const SID = z.string().length(18).startsWith('ln_ac_')
  .describe('LinkedIn account sid (ln_ac_…).');

// LinkedinAccountStatusEnum, in its PHP order. Named once and reused by the
// item projection and the status filter so the two cannot drift apart.
const LinkedinAccountStatus = z.enum([
  'new',
  'initial_syncing',
  'active',
  'sync_failed',
  'shared_out',
  'subscription_required',
]);

// Target person for outward/probe actions: at least one identifier (backend-validated).
const Target = z.object({
  ln_id: z.string().optional().describe('LinkedIn member id.'),
  sn_id: z.string().optional().describe('Sales Navigator member id.'),
  nickname: z.string().optional().describe('Public profile slug.'),
}).describe('Target person; provide at least one of ln_id / sn_id / nickname.');

// Item projection: mirrors LinkedinAccountDomain (research §Domain) field-by-field.
// Trailing .passthrough() is forward-compat only (backend may add fields).
// Counts stays passthrough: the counts block is an auto-computed .groups
// distribution with no fixed shape documented (research §Groupable fields).
const LinkedinAccount = z.object({
  // PK → tenant → FK
  sid: z.string(),
  team_sid: z.string(),
  antidetect_browser_sid: z.string(),

  // Lifecycle state (LinkedinAccountStatusEnum). It is NOT derivable from the
  // timestamps: shared_out and subscription_required say the account is
  // unusable for reasons no clock records, and new / initial_syncing /
  // sync_failed are the onboarding phases initial_sync_completed_at alone
  // cannot tell apart (null means both "never started" and "failed").
  status: LinkedinAccountStatus,

  // Sharing linkage (sharing rework). Non-null only while the account is inside
  // a share; share_role says which side of it this row is.
  account_share_sid: z.string().nullable(),
  share_role: HandoverRoleEnum.nullable(),

  // Contact identity
  ln_id: z.string().nullable(),
  ln_member_id: z.string().nullable(),
  sn_id: z.string().nullable(),
  nickname: z.string().nullable(),

  // Display essentials
  full_name: z.string().nullable(),
  avatar_url: z.string().nullable(),

  // Premium / Sales-Navigator flags
  has_premium: z.boolean(),
  has_sn: z.boolean(),
  has_recruiter: z.boolean(),
  inmail_credits: z.number().nullable(),
  last_premium_check_at: z.string().nullable(),

  // Per-entity sync clocks
  last_connections_sync_at: z.string().nullable(),
  last_conversations_sync_at: z.string().nullable(),
  last_sales_navigator_conversations_sync_at: z.string().nullable(),
  last_connection_requests_sync_at: z.string().nullable(),
  last_connection_invitations_sync_at: z.string().nullable(),
  last_followers_sync_at: z.string().nullable(),
  last_snapshot_at: z.string().nullable(),

  // Initial-sync gate (one-way latch)
  initial_sync_completed_at: z.string().nullable(),

  // Heartbeat
  last_heartbeat_at: z.string().nullable(),

  // Configuration: shared Value objects, Partial<Record<enum, …>> ⇒ .partial()
  sync_config: z.object({
    entries: z.object({
      connections: z.object({ interval_minutes: z.number() }),
      conversations: z.object({ interval_minutes: z.number() }),
      sales_navigator_conversations: z.object({ interval_minutes: z.number() }),
      connection_requests: z.object({ interval_minutes: z.number() }),
      connection_invitations: z.object({ interval_minutes: z.number() }),
      premium_check: z.object({ interval_minutes: z.number() }),
      snapshot_check: z.object({ interval_minutes: z.number() }),
    }).partial().describe('Per-track sync-interval overrides, keyed by sync track.'),
    timezone: z.string().describe('IANA timezone the window is evaluated in.'),
    window: z.array(z.object({
      day_of_week: z.number().int().min(1).max(7),
      start_minute: z.number().int().min(0).max(1439),
      end_minute: z.number().int().min(1).max(1440),
    })).describe('Weekly sync-activity window blocks; empty = always open.'),
  }).partial().nullable(),
  webhook_config: z.object({
    connections: z.object({ enabled: z.boolean(), since: z.string().nullable() }),
    connection_requests: z.object({ enabled: z.boolean(), since: z.string().nullable() }),
    connection_invitations: z.object({ enabled: z.boolean(), since: z.string().nullable() }),
    conversations: z.object({ enabled: z.boolean(), since: z.string().nullable() }),
    sales_navigator_conversations: z.object({ enabled: z.boolean(), since: z.string().nullable() }),
    messages: z.object({ enabled: z.boolean(), since: z.string().nullable() }),
    followers: z.object({ enabled: z.boolean(), since: z.string().nullable() }),
    snapshot: z.object({ enabled: z.boolean(), since: z.string().nullable() }),
    strike_log: z.object({ enabled: z.boolean(), since: z.string().nullable() }),
    limits: z.object({ enabled: z.boolean(), since: z.string().nullable() }),
  }).partial().nullable(),

  // Audit: AccessIdentityValue (shared)
  created_by: z.object({
    actor_type: AccessIdentityValueActorTypeEnum,
    actor_sid: z.string().nullable(),
    team_sid: z.string(),
    permissions: z.record(z.unknown()),
    request_sid: z.string().nullable().optional(),
    reason: z.string().nullable(),
  }),

  // Timestamps
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
}).passthrough();

const LinkedinAccountCounts = z.object({}).passthrough();

const LinkedinAccountFilter = z.object({
  q: z.string().optional().describe('Full-text LIKE over full_name + nickname. Identity ids (ln_member_id, sn_id) are exact-match fields, not q targets.'),

  // Lifecycle state. This filter (and the item field) used to be absent, under a
  // comment claiming the account carried no status enum and that its state was
  // derived from the timestamps and from the bound browser. That stopped being
  // true when the sharing rework added LinkedinAccountStatusEnum and the column
  // behind it, and LinkedinAccountFilter declares `status`.
  status: filterOp(LinkedinAccountStatus, ['eq', 'ne', 'in', 'nin']).optional()
    .describe('Lifecycle state. active = usable; shared_out = lent to another team; subscription_required = plan lapsed.'),

  // Identity / linkage (exact-match; substring on full_name/nickname is via q).
  sid: filterOp(z.string(), ['eq', 'in']).optional(),
  antidetect_browser_sid: filterOp(z.string(), ['eq', 'in']).optional(),
  account_share_sid: filterOp(z.string(), ['eq', 'in', 'is_null']).optional()
    .describe('is_null:false = the account is currently inside a share.'),
  ln_id: filterOp(z.string(), ['eq', 'ne', 'in', 'nin', 'is_null']).optional(),
  ln_member_id: filterOp(z.string(), ['eq', 'ne', 'in', 'nin', 'is_null']).optional(),
  sn_id: filterOp(z.string(), ['eq', 'ne', 'in', 'nin', 'is_null']).optional(),
  nickname: filterOp(z.string(), ['eq', 'in', 'is_null']).optional(),
  full_name: filterOp(z.string(), ['eq', 'in', 'is_null']).optional(),
  avatar_url: filterOp(z.string(), ['is_null']).optional()
    .describe('Display-completeness predicate only (is_null); the URL value is not a filter axis.'),

  // Premium / Sales-Navigator flags.
  has_premium: filterOp(z.boolean(), ['eq']).optional(),
  has_sn: filterOp(z.boolean(), ['eq']).optional(),
  has_recruiter: filterOp(z.boolean(), ['eq']).optional(),
  inmail_credits: filterOp(z.number().int(), ['eq', 'ne', 'gte', 'lte', 'gt', 'lt', 'is_null']).optional()
    .describe('is_null:true = last parse failed.'),
  last_premium_check_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(),

  // Per-entity sync clocks (staleness / scheduler predicates).
  last_connections_sync_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(),
  last_conversations_sync_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(),
  last_sales_navigator_conversations_sync_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(),
  last_connection_requests_sync_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(),
  last_connection_invitations_sync_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(),
  last_snapshot_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(),

  // Onboarding gate + heartbeat.
  initial_sync_completed_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional()
    .describe('Onboarding gate; is_null:true = still onboarding, is_null:false = ready.'),
  last_heartbeat_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(),

  // Timestamps.
  created_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  updated_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  deleted_at: filterOp(z.string(), ['is_null', 'gte', 'lte']).optional()
    .describe('Default scope is { is_null: true } (live accounts).'),
}).partial();

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const ACT = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DANGER = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

const base = {
  service: 'linkedin',
  entity: 'linkedin_accounts',
  mount: 'linkedin.accounts',
} as const;

// Both closed sets come from the route's own rules(): a 422 on an `in:` rule
// says the value is invalid, never which values are valid, so the tool has to
// carry the list or the agent is guessing.
const LinkedinAccountInclude = z.enum([
  'antidetect_browser',
  'linkedin_account_smart_limits',
  'linkedin_account_snapshot',
  'linkedin_account_quota_hits',
  'linkedin_account_block_log',
  'linkedin_account_block_log_counts',
  'linkedin_connections_counts',
  'linkedin_connection_requests_counts',
  'linkedin_connection_invitations_counts',
]);

const LinkedinAccountSortable = z.enum([
  'created_at',
  'updated_at',
  'last_premium_check_at',
  'last_snapshot_at',
  'last_heartbeat_at',
  'last_connections_sync_at',
  'last_conversations_sync_at',
  'last_sales_navigator_conversations_sync_at',
  'last_connection_requests_sync_at',
  'last_connection_invitations_sync_at',
  'initial_sync_completed_at',
  'inmail_credits',
  'full_name',
]);

export const linkedinAccountsTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_linkedin_accounts',
    description:
      'List LinkedIn accounts on the team with filtering, sorting and cursor pagination. Returns a counts block of predicate tallies. Use this to find an account sid before calling account-scoped tools.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-accounts/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: McpSearchRequestSchema(LinkedinAccountFilter, LinkedinAccountInclude, LinkedinAccountSortable),
    outputSchema: McpSearchResponse(LinkedinAccount, undefined, LinkedinAccountCounts),
    annotations: { title: 'Search LinkedIn accounts', ...RO },
  },
  {
    ...base,
    name: 'get_linkedin_account',
    description: 'Fetch a single LinkedIn account by sid, with optional eager-loaded relations.',
    toolClass: 'trivial',
    route: { service: 'linkedin', method: 'GET', pathTemplate: '/api/linkedin-accounts/{sid}', sidParam: 'sid' },
    operation: 'get',
    envelope: 'get',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: McpGetRequestSchema('ln_ac_', LinkedinAccountInclude),
    outputSchema: McpGetResponse(LinkedinAccount),
    annotations: { title: 'Get LinkedIn account', ...RO },
  },
  {
    ...base,
    name: 'check_linkedin_account_premium_subscription',
    description:
      'Refresh and return the Premium / Sales Navigator / Recruiter subscription state and InMail credit balance for the account (self-probe, no target).',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-accounts/{sid}/check-premium', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: SID, ...usageMetaField }),
    outputSchema: McpActionResponse(LinkedinAccount),
    annotations: { title: 'Check premium subscription', ...RO },
  },
  {
    ...base,
    name: 'check_linkedin_account_recruiter_access',
    description: 'Granular probe: does this account currently have LinkedIn Recruiter access?',
    toolClass: 'trivial',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-accounts/{sid}/check-recruiter', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: SID, ...usageMetaField }),
    outputSchema: McpActionResponse(LinkedinAccount),
    annotations: { title: 'Check Recruiter access', ...RO },
  },
  {
    ...base,
    name: 'check_linkedin_account_sales_nav_access',
    description: 'Granular probe: does this account currently have a Sales Navigator seat?',
    toolClass: 'trivial',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-accounts/{sid}/check-sales-nav', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: SID, ...usageMetaField }),
    outputSchema: McpActionResponse(LinkedinAccount),
    annotations: { title: 'Check Sales Navigator access', ...RO },
  },
  {
    ...base,
    name: 'check_linkedin_account_target_block',
    description:
      'Check whether a target person can be reached from this account (not blocked / out of network). CREDITABLE: may run an infra-pool probe and debit credits, and the response carries a credits block.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-accounts/{sid}/check-target-block', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID,
      target: Target,
      force: z.boolean().optional().describe('Bypass a cached result and re-probe (may cost credits).'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(LinkedinAccount),
    annotations: { title: 'Check target reachability', ...ACT },
  },
  {
    ...base,
    name: 'get_linkedin_account_my_full_profile',
    description: 'Fetch the full self-profile of the connected LinkedIn account.',
    toolClass: 'trivial',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-accounts/{sid}/get-my-full-profile', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: SID, ...usageMetaField }),
    outputSchema: McpActionResponse(LinkedinAccount),
    annotations: { title: 'Get my full profile', ...RO },
  },
  {
    ...base,
    name: 'get_linkedin_account_my_lite_profile',
    description: 'Fetch the lite self-profile (name, headline, avatar) of the connected account.',
    toolClass: 'trivial',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-accounts/{sid}/get-my-lite-profile', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: SID, ...usageMetaField }),
    outputSchema: McpActionResponse(LinkedinAccount),
    annotations: { title: 'Get my lite profile', ...RO },
  },
  {
    ...base,
    name: 'get_linkedin_account_my_sessions',
    description: 'List the active LinkedIn sessions for the connected account.',
    toolClass: 'trivial',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-accounts/{sid}/get-my-sessions', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: SID, ...usageMetaField }),
    outputSchema: McpActionResponse(LinkedinAccount),
    annotations: { title: 'Get my sessions', ...RO },
  },
  {
    ...base,
    name: 'get_linkedin_account_my_credits',
    description: 'Return the InMail / message credit balance for the connected account.',
    toolClass: 'trivial',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-accounts/{sid}/get-my-credits', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: SID, ...usageMetaField }),
    outputSchema: McpActionResponse(LinkedinAccount),
    annotations: { title: 'Get my credits', ...RO },
  },
  {
    ...base,
    name: 'get_linkedin_account_my_following',
    description: 'List who the connected account follows, newest-first: the follow-edge twin of get-my-followers (§5.8 latest-*). A null cursor refreshes then returns the head page; a non-null cursor is a read-only continuation over the already-refreshed head (no limit spend). Cursor-paginated.',
    toolClass: 'trivial',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-accounts/{sid}/get-my-following', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID,
      page_size: z.number().int().min(1).max(100).optional(),
      cursor: z.string().nullable().optional(),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(LinkedinAccount),
    annotations: { title: 'Get my following', ...RO },
  },
  {
    ...base,
    name: 'get_linkedin_account_my_ssi',
    description: '⛔ NOT SHIPPED YET: returns the Social Selling Index. Contract locked, capability not built; calling it returns not_implemented.',
    toolClass: 'trivial',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-accounts/{sid}/get-my-ssi', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'stub_501',
    dangerous: false,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: SID, ...usageMetaField }),
    outputSchema: McpActionResponse(LinkedinAccount),
    annotations: { title: 'Get my SSI (not shipped)', ...RO },
  },
  {
    ...base,
    name: 'get_linkedin_account_my_analytics',
    description: '⛔ NOT SHIPPED YET: returns creator/profile analytics. Contract locked, capability not built; calling it returns not_implemented.',
    toolClass: 'trivial',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-accounts/{sid}/get-my-analytics', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'stub_501',
    dangerous: false,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: SID, ...usageMetaField }),
    outputSchema: McpActionResponse(LinkedinAccount),
    annotations: { title: 'Get my analytics (not shipped)', ...RO },
  },
  {
    ...base,
    name: 'edit_linkedin_account_my_profile',
    description: '⛔ NOT SHIPPED YET: edits the connected account\'s own profile (name/headline/summary). Contract locked, capability not built; calling it returns not_implemented.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'PATCH', pathTemplate: '/api/linkedin-accounts/{sid}/my-profile', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'stub_501',
    dangerous: true,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID,
      first_name: z.string().optional(),
      last_name: z.string().optional(),
      headline: z.string().optional(),
      summary: z.string().optional(),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(LinkedinAccount),
    annotations: { title: 'Edit my profile (not shipped)', ...DANGER },
  },
  {
    ...base,
    name: 'endorse_linkedin_account_skill',
    description:
      'Endorse a target person\'s skills from this account (warm-up / engagement action). Outward action on LinkedIn.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-accounts/{sid}/endorse-skill', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID,
      target: Target,
      skills_count: z.number().int().min(1).max(10).optional().describe('How many skills to endorse (1..10, default 1).'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(LinkedinAccount),
    annotations: { title: 'Endorse skills', ...DANGER },
  },
  {
    ...base,
    name: 'visit_linkedin_account_profile',
    description: 'Visit a target person\'s profile from this account (warm-up / signal action). Outward action on LinkedIn.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-accounts/{sid}/visit-profile', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: SID, target: Target, ...usageMetaField }),
    outputSchema: McpActionResponse(LinkedinAccount),
    annotations: { title: 'Visit profile', ...DANGER },
  },
  {
    ...base,
    name: 'reset_linkedin_account_sync',
    description:
      'Reset one or more sync tracks for the account and re-run them from scratch. ASYNC: returns pending refs to poll; DESTRUCTIVE: discards sync cursors.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-accounts/{sid}/reset-sync', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action_async',
    availability: 'ga',
    dangerous: true,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID,
      types: z.array(z.enum([
        'connections',
        'connection_requests',
        'connection_invitations',
        'conversations',
        'sales_navigator_conversations',
      ])).min(1).describe('Sync tracks to reset (LinkedinAccountResetSyncTypeEnum values).'),
      ...usageMetaField,
    }),
    outputSchema: McpAsyncActionResponse(LinkedinAccount),
    annotations: { title: 'Reset account sync', ...DANGER },
  },
  {
    ...base,
    name: 'update_linkedin_account_sync_config',
    description:
      "Set the account's weekly sync schedule: the timezone, the allowed per-weekday time windows, and per-track cadence entries. Replaces the stored sync_config wholesale (send the full desired config, not a delta). Returns the updated account.",
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-accounts/{sid}/update-sync-config', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID,
      sync_config: z.object({
        timezone: z.string().describe('IANA timezone (e.g. Europe/Amsterdam) the windows/entries are evaluated in.'),
        window: z.array(z.object({
          day_of_week: z.number().int().min(1).max(7).describe('ISO weekday: 1=Mon … 7=Sun.'),
          start_minute: z.number().int().min(0).max(1439).describe('Window start, minutes from local midnight (0..1439).'),
          end_minute: z.number().int().min(1).max(1440).describe('Window end, minutes from local midnight (1..1440); must be after start_minute.'),
        })).optional().describe('Allowed sync hours per weekday; omit to sync around the clock.'),
        entries: z.object({
          connections: z.object({ interval_minutes: z.number().int().min(5) }),
          conversations: z.object({ interval_minutes: z.number().int().min(5) }),
          sales_navigator_conversations: z.object({ interval_minutes: z.number().int().min(5) }),
          connection_requests: z.object({ interval_minutes: z.number().int().min(5) }),
          connection_invitations: z.object({ interval_minutes: z.number().int().min(5) }),
          premium_check: z.object({ interval_minutes: z.number().int().min(5) }),
          snapshot_check: z.object({ interval_minutes: z.number().int().min(5) }),
        }).partial().optional().describe('Per-track cadence overrides (minutes, ≥5), keyed by sync track.'),
      }).describe('Weekly sync schedule for the account (replaces the stored config wholesale).'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(LinkedinAccount),
    annotations: { title: 'Update account sync config', ...ACT },
  },
];
