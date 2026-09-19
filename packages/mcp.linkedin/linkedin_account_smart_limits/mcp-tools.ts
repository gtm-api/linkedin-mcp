// Entity: LinkedIn Account Smart Limit (gtm.service.linkedin)
// Source of truth: product/research/gtm.service.linkedin/entities/linkedin_account_smart_limits.md
// Format: registry v2, where each tool carries route metadata so the generic
// dispatcher can drive it. 3 tools (the linkedin-account-smart-limits route
// group: search + update + reset-hold). These JOIN the accounts mount so the
// per-limit_type policy rows sit alongside their owning account tools.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  filterOp,
  usageMetaField,
  McpActionResponse,
  McpSearchRequestSchema,
  McpSearchResponse,
  McpUpdateResponse,
} from '@gtm/mcp-shared';

const SID = z.string().length(18).startsWith('ln_sm_')
  .describe('Smart-limit row sid (ln_sm_…).');

// The 15 public buckets an account owns, one row each. Also the vocabulary of a
// tool's `pacedBucket` (tests/pacing-parity.test.ts): a call of a paced tool
// spends exactly one of these.
export const SMART_LIMIT_BUCKETS = [
  'send_connection_requests',
  'networking_general',
  'send_messages',
  'send_inmails',
  'messaging_general',
  'comment_posts',
  'react_posts',
  'endorse_skills',
  'visit_profiles',
  'edit_profile',
  'self_account_sync',
  'scraping',
  'enrichment',
  'posting',
  'custom_request',
] as const;

// Item projection: mirrors LinkedinAccountSmartLimitDomain (research §Domain)
// field-by-field. Trailing .passthrough() is forward-compat only (backend may
// add fields). Counts stays passthrough: the counts block is an auto-computed
// .groups distribution with no fixed shape (research §Groupable fields).
const LinkedinAccountSmartLimit = z.object({
  // PK → tenant → FK
  sid: z.string(),
  team_sid: z.string(),
  linkedin_account_sid: z.string(),

  // Identity (composite natural key with linkedin_account_sid)
  limit_type: z.enum([
    ...SMART_LIMIT_BUCKETS,
    // The 16th case. LinkedinAccountSmartLimitTypeEnum calls it the hidden
    // governor and no tool creates one, but the bootstrap job does, so a search
    // over a real account returns rows carrying it and a 15-case enum fails to
    // parse them.
    'data_requests',
  ]),

  // Limits (the policy)
  daily_limit: z.number(),
  smart_limit: z.number().nullable(),
  target_limit: z.number().nullable(),
  // The flat delay between any two dispatches of the bucket (pacing plan §8.3): the
  // "burst N, then hold X" pair left the contract on 2026-09-19.
  delay_in_seconds: z.number(),

  // Counter (today's usage)
  done_today_count: z.number(),
  // include-only read-time aggregate (linkedin_account_smart_limits include);
  // absent on the standalone search/get surface ⇒ .optional()
  done_7d_count: z.number().nullable().optional(),
  last_reset_at: z.string(),

  // No smart toggle on the row since 2026-09-10: whether the warmup governs it
  // is the ACCOUNT's smart_limits_enabled (search_linkedin_accounts), one
  // switch for every bucket, flipped by set_linkedin_account_smart_limits.

  // State (status + independent clocks). No `saturated`: reaching the daily cap
  // latches hold_till = midnight, so a spent daily budget IS `held`.
  status: z.enum(['active', 'held', 'linkedin_blocked']),
  hold_till: z.string().nullable(),
  linkedin_quota_hit_till: z.string().nullable(),
  // No pacing clock on the row: a dispatch reserves its slot before the call
  // leaves (the platform's own last_dispatch_at), so what a caller is told to
  // wait is context.retry_after on the 429, or pacing.next_call_after on a success.

  // Timestamps (no deleted_at on this entity)
  created_at: z.string(),
  updated_at: z.string(),
}).passthrough();

const LinkedinAccountSmartLimitCounts = z.object({}).passthrough();

const num = (ops: Parameters<typeof filterOp>[1]) => filterOp(z.number().int(), ops).optional();
const str = (ops: Parameters<typeof filterOp>[1]) => filterOp(z.string(), ops).optional();

const LinkedinAccountSmartLimitFilter = z.object({
  sid: str(['eq', 'in']),
  linkedin_account_sid: str(['eq', 'in']),
  limit_type: str(['eq', 'ne', 'in', 'nin']),
  daily_limit: num(['eq', 'ne', 'gte', 'lte', 'gt', 'lt']),
  smart_limit: num(['eq', 'ne', 'gte', 'lte', 'gt', 'lt', 'is_null']),
  target_limit: num(['eq', 'ne', 'gte', 'lte', 'gt', 'lt', 'is_null']),
  delay_in_seconds: num(['eq', 'ne', 'gte', 'lte', 'gt', 'lt']),
  learning_enabled: filterOp(z.boolean(), ['eq']).optional()
    .describe('false = the adaptive ceiling is pinned off for this row.'),
  learned_ceiling: num(['eq', 'ne', 'gte', 'lte', 'gt', 'lt', 'is_null'])
    .describe('The cap LinkedIn refusals taught this bucket; is_null:false = every row the learner has lowered.'),
  learned_ceiling_source: str(['eq', 'ne', 'in', 'nin', 'is_null'])
    .describe('backoff (a LinkedIn refusal lowered it) | probe (a clean streak raised it).'),
  learned_ceiling_updated_at: str(['gte', 'lte', 'gt', 'lt', 'is_null']),
  probe_not_before: str(['gte', 'lte', 'gt', 'lt', 'is_null'])
    .describe('When the learner may next try a higher ceiling.'),
  clean_saturation_streak: num(['eq', 'ne', 'gte', 'lte', 'gt', 'lt'])
    .describe('Days in a row the bucket spent its whole budget without a LinkedIn refusal.'),
  done_today_count: num(['eq', 'ne', 'gte', 'lte', 'gt', 'lt']).describe('Live read of today\'s usage.'),
  last_reset_at: str(['gte', 'lte', 'gt', 'lt']),
  status: str(['eq', 'ne', 'in', 'nin']).describe('Primary state filter: active | held | linkedin_blocked (held = daily budget spent OR a live hold, the same thing).'),
  hold_till: str(['gte', 'lte', 'gt', 'lt', 'is_null']).describe('Platform-side pause clock.'),
  linkedin_quota_hit_till: str(['gte', 'lte', 'gt', 'lt', 'is_null']).describe('LinkedIn-block clock.'),
  created_at: str(['gte', 'lte', 'gt', 'lt']),
  updated_at: str(['gte', 'lte', 'gt', 'lt']),
}).partial();

const LinkedinAccountSmartLimitInclude = z.enum([
  'linkedin_account',
  'linkedin_account_quota_hits',
]);
const LinkedinAccountSmartLimitSortable = z.enum([
  'created_at',
  'updated_at',
  'last_reset_at',
  'daily_limit',
  'smart_limit',
  'target_limit',
  'done_today_count',
  'status',
  'hold_till',
  'linkedin_quota_hit_till',
]);

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
// dangerous ⇒ destructiveHint (registry invariant). Both write verbs are idempotent.
const WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

const base = {
  service: 'linkedin',
  entity: 'linkedin_account_smart_limits',
  mount: 'linkedin.accounts',
} as const;

export const linkedinAccountSmartLimitsTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_linkedin_account_smart_limits',
    description:
      'List per-limit_type policy rows (one account owns 15 public buckets: send_connection_requests, send_messages, send_inmails, scraping, enrichment, custom_request, …) with filters, sorting, cursor pagination and a counts block (status / limit_type breakdowns). Whether the warmup governs a row is the ACCOUNT\'s smart_limits_enabled, not a row field. ' +
      'Use for: "which limits are at their daily cap / held / blocked by LinkedIn" (status filter; held means the daily budget is spent), "can account X still send InMails today" (filter linkedin_account_sid + limit_type, read status + daily_limit − done_today_count), fleet capacity, smart-limit adoption rate. ' +
      'Every row also carries recommended_daily_limit / recommended_delay_in_seconds (what the platform would run this bucket at for THIS account) and risk_level (none | elevated | ban_likely) for the values currently set. ' +
      'Single-row case = search(filter:{linkedin_account_sid, limit_type}, page_size:1). No q. include[]: linkedin_account, linkedin_account_quota_hits.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-account-smart-limits/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    inputSchema: McpSearchRequestSchema(LinkedinAccountSmartLimitFilter, LinkedinAccountSmartLimitInclude, LinkedinAccountSmartLimitSortable, 200),
    outputSchema: McpSearchResponse(LinkedinAccountSmartLimit, undefined, LinkedinAccountSmartLimitCounts),
    annotations: { title: 'Search LinkedIn account smart limits', ...RO },
  },
  {
    ...base,
    name: 'update_linkedin_account_smart_limit',
    description:
      'GATE: on a governed account (smart_limits_enabled true, the default) daily_limit / delay_in_seconds belong to the warmup; moving either is 409 smart_limits_governed: never promise a raised cap there. target_limit only BOUNDS (the row follows min(smart_limit, target_limit)): a target above the warmup ceiling changes nothing today; a young or dormant account sits at 1..2 for weeks (see warmup_breakdown). The other way: set_linkedin_account_smart_limits({enabled:false}), said out loud as removing ban protection. ' +
      'One row (daily_limit / target_limit / delay_in_seconds / learning_enabled; one field OR reset_hold:true). ' +
      'Switch off: nothing refused; read the row\'s recommended_* first, 2x (or half the delay) is "elevated", beyond that "ban_likely", warn so. ' +
      'A spent budget is "held": raising daily_limit alone does not clear it, pass reset_hold:true too; it resumes once the cap exceeds done_today_count (governed rows re-hold at once). System fields are rejected; a LinkedIn lock is not resettable.',
    toolClass: 'complex',
    route: { service: 'linkedin', method: 'PATCH', pathTemplate: '/api/linkedin-account-smart-limits/{sid}', sidParam: 'sid' },
    operation: 'update',
    envelope: 'update',
    availability: 'ga',
    dangerous: true,
    inputSchema: z.object({
      sid: SID,
      daily_limit: z.number().int().min(1).max(1000).optional().describe('Active cap (1..1000).'),
      target_limit: z.number().int().min(0).max(1000).nullable().optional().describe('Warm-up ceiling; null clears it.'),
      learning_enabled: z.boolean().optional()
        .describe('Whether the adaptive ceiling keeps moving. false pins learned_ceiling where it stands; the quota-hit block clock still arms either way, so this is a tuning knob, not a safety switch.'),
      delay_in_seconds: z.number().int().min(1).max(3600).optional().describe('The flat delay in seconds between any two calls of the bucket (1..3600), varied by up to 20% per call; nothing fires back-to-back. An undo verb (unreact, delete a comment or post, unendorse, unfollow, withdraw) waits 2 s instead.'),
      reset_hold: z.boolean().optional().describe('Clear the daily-saturation hold in the same call (the atomic "raise the limit AND resume now"). Only resumes if the new daily_limit > done_today_count; otherwise the row re-holds. Never touches a LinkedIn-side lock.'),
      ...usageMetaField,
    }),
    outputSchema: McpUpdateResponse(LinkedinAccountSmartLimit),
    annotations: { title: 'Update LinkedIn account smart limit', ...WRITE },
  },
  {
    ...base,
    name: 'reset_linkedin_account_smart_limit_hold',
    description:
      'Clear OUR platform-side pause (hold_till = null) on one row. On a spent budget (done_today_count >= daily_limit) the saturation latch re-holds at once, so this is a no-op that stays held: the cap has to grow first. On a HAND-MANAGED account (smart_limits_enabled false) prefer update({daily_limit:<higher>, reset_hold:true}), which raises the cap and resumes atomically. On a GOVERNED account (the default) daily_limit is the warmup\'s and cannot be raised by hand: target_limit only bounds the cap, the warmup ceiling grows with account age and sent activity across snapshots, and the ramp lifts the latch by itself once its recomputed cap outgrows done_today_count, so nothing resumes today. This action resumes WITHOUT changing the limit (meaningful only when done_today_count < daily_limit, e.g. a systemic hold). ' +
      'Idempotent. Does NOT touch done_today_count or linkedin_quota_hit_till: a LinkedIn-side hard lock cannot be reset from the public surface (result.new_status stays linkedin_blocked while that clock runs).',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-account-smart-limits/{sid}/reset-hold', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: SID, ...usageMetaField }),
    outputSchema: McpActionResponse(LinkedinAccountSmartLimit),
    annotations: { title: 'Reset LinkedIn account smart-limit hold', ...WRITE },
  },
];
