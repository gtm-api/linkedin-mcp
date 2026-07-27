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
  delay_in_seconds: z.number(),
  batch_size: z.number(),

  // Counter (today's usage)
  done_today_count: z.number(),
  // include-only read-time aggregate (linkedin_account_smart_limits include);
  // absent on the standalone search/get surface ⇒ .optional()
  done_7d_count: z.number().nullable().optional(),
  last_reset_at: z.string(),

  // Smart toggle
  smart_limits_enabled: z.boolean(),

  // State (status + independent clocks). No `saturated`: reaching the daily cap
  // latches hold_till = midnight, so a spent daily budget IS `held`.
  status: z.enum(['active', 'held', 'linkedin_blocked']),
  hold_till: z.string().nullable(),
  linkedin_quota_hit_till: z.string().nullable(),
  // Delay-gate clock (v5.1 §9): when this bucket last counted a successful
  // action; next dispatch allowed at + delay_in_seconds. Null until first count.
  last_counted_at: z.string().nullable(),

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
  done_today_count: num(['eq', 'ne', 'gte', 'lte', 'gt', 'lt']).describe('Live read of today\'s usage.'),
  last_reset_at: str(['gte', 'lte', 'gt', 'lt']),
  smart_limits_enabled: filterOp(z.boolean(), ['eq']).optional(),
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
      'List per-limit_type policy rows (one account owns 15 public buckets: send_connection_requests, send_messages, send_inmails, scraping, enrichment, custom_request, …) with filters, sorting, cursor pagination and a counts block (status / limit_type / smart_limits_enabled breakdowns). ' +
      'Use for: "which limits are at their daily cap / held / blocked by LinkedIn" (status filter; held means the daily budget is spent), "can account X still send InMails today" (filter linkedin_account_sid + limit_type, read status + daily_limit − done_today_count), fleet capacity, smart-limit adoption rate. ' +
      'Single-row case = search(filter:{linkedin_account_sid, limit_type}, page_size:1). No q. include[]: linkedin_account, linkedin_account_quota_hits.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-account-smart-limits/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: McpSearchRequestSchema(LinkedinAccountSmartLimitFilter, LinkedinAccountSmartLimitInclude, LinkedinAccountSmartLimitSortable, 200),
    outputSchema: McpSearchResponse(LinkedinAccountSmartLimit, undefined, LinkedinAccountSmartLimitCounts),
    annotations: { title: 'Search LinkedIn account smart limits', ...RO },
  },
  {
    ...base,
    name: 'update_linkedin_account_smart_limit',
    description:
      'Patch the operator-tunable policy of one limit row (daily_limit / target_limit / delay_in_seconds / smart_limits_enabled; at least one field OR reset_hold:true required). status is recomputed atomically. ' +
      'A spent daily budget shows as status "held" (there is no "saturated" status). Raising daily_limit does NOT by itself clear that hold. Pass reset_hold:true IN THE SAME CALL to raise the cap AND resume now (the atomic "raise + resume"). The hold only actually clears if the new daily_limit is above done_today_count; otherwise the saturation-latch immediately re-holds it. ' +
      'On a smart-managed row the persistent lever is target_limit (a manual daily_limit below smart_limit is only transient until the next snapshot). System-managed fields (done_today_count, smart_limit, hold_till, linkedin_quota_hit_till, status, …) are rejected as fields. Use reset_hold to clear the hold. A LinkedIn-side lock (linkedin_quota_hit_till) is never resettable.',
    toolClass: 'complex',
    route: { service: 'linkedin', method: 'PATCH', pathTemplate: '/api/linkedin-account-smart-limits/{sid}', sidParam: 'sid' },
    operation: 'update',
    envelope: 'update',
    availability: 'ga',
    dangerous: true,
    creditable: false,
    inputSchema: z.object({
      sid: SID,
      daily_limit: z.number().int().min(1).max(1000).optional().describe('Active cap (1..1000).'),
      target_limit: z.number().int().min(0).max(1000).nullable().optional().describe('Warm-up ceiling; null clears it.'),
      delay_in_seconds: z.number().int().min(1).max(3600).optional().describe('Batch-boundary cooldown (1..3600).'),
      smart_limits_enabled: z.boolean().optional(),
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
      'Clear OUR platform-side pause (hold_till = null) on one row. Prefer update({daily_limit:<higher>, reset_hold:true}) for the common "raise the cap AND resume". This standalone action is for resuming WITHOUT changing the limit (only meaningful when done_today_count < daily_limit, e.g. a systemic hold). ' +
      'On a spent budget (done_today_count >= daily_limit) the saturation-latch re-holds immediately, so this is a no-op that stays held; raise daily_limit first. Idempotent (no-op if hold was already clear). Does NOT touch done_today_count or linkedin_quota_hit_till: a LinkedIn-side hard lock cannot be reset from the public surface (result.new_status stays linkedin_blocked if that clock is still active).',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-account-smart-limits/{sid}/reset-hold', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: SID, ...usageMetaField }),
    outputSchema: McpActionResponse(LinkedinAccountSmartLimit),
    annotations: { title: 'Reset LinkedIn account smart-limit hold', ...WRITE },
  },
];
