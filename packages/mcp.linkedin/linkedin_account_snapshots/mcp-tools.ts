// Entity: LinkedIn Account Snapshot (gtm.service.linkedin)
// Source of truth: product/research/gtm.service.linkedin/entities/linkedin_account_snapshots.md
// Format: registry v2, where each tool carries route metadata so the generic
// dispatcher can drive it. 1 tool (the linkedin-account-snapshots route group);
// snapshots are immutable & append-only: create/get/delete live on /internal/,
// metrics & group-by are not supported. Mounted on linkedin.account-monitor.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  AccessIdentityValue,
  filterOp,
  McpSearchRequestSchema,
  McpSearchResponse,
} from '@gtm/mcp-shared';

// Item projection: every field of LinkedinAccountSnapshotDomain, field-for-field
// from the research #### Domain. .passthrough() keeps forward-compat if the
// backend adds fields. Counts is the generic { total_count, groups:{} } → left loose.
const LinkedinAccountSnapshot = z.object({
  sid: z.string(),
  team_sid: z.string(),
  linkedin_account_sid: z.string(),

  // Score
  warmup_score: z.number(),
  warmup_breakdown: z.array(z.object({
    driver: z.enum(['account_age', 'limit_hits', 'blocks', 'activity', 'sessions_ip', 'completeness']),
    penalty_pct: z.number(),
  })),

  // Snapshot context: parser-driven JSON payloads (no typed Value)
  account: z.record(z.unknown()),
  account_diff: z.number(),
  sessions: z.array(z.record(z.unknown())).nullable(),
  sessions_count: z.number(),
  sessions_diff: z.number(),
  network_size: z.number(),
  has_verification: z.boolean(),
  account_completeness: z.number(),
  account_age_months: z.number(),
  last_post_days: z.number().nullable(),

  // Last-month activity counters
  last_month_connection_requests_sent: z.number(),
  last_month_connection_requests_accepted: z.number(),
  last_month_messages_sent: z.number(),
  last_month_messages_received: z.number(),
  last_month_messages_blocked: z.number(),
  withdrawal_queue: z.number(),

  // Scoring outputs / rate-limit surface: JSON breakdowns keyed by
  // warmup-driver / limit_type / action type. Objects even when empty, because
  // the Domain declares them in jsonMapProperties() (Core/Support/JsonShape.php).
  tips: z.record(z.unknown()),
  smart_limits_enabled: z.boolean(),
  smart_limits: z.record(z.unknown()),
  fact_limits: z.record(z.unknown()),
  executed_actions: z.record(z.number()),

  // Audit: shared AccessIdentityValue
  created_by: AccessIdentityValue,

  // Timestamps
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
}).passthrough();

const LinkedinAccountSnapshotCounts = z.object({}).passthrough();

const num = (ops: Parameters<typeof filterOp>[1]) => filterOp(z.number().int(), ops).optional();
const dt = (ops: Parameters<typeof filterOp>[1]) => filterOp(z.string(), ops).optional();

const LinkedinAccountSnapshotFilter = z.object({
  sid: filterOp(z.string(), ['eq', 'in']).optional(),
  linkedin_account_sid: filterOp(z.string(), ['eq', 'in']).optional()
    .describe('Primary filter for per-account history / trend views.'),
  warmup_score: num(['eq', 'ne', 'gte', 'lte', 'gt', 'lt', 'in', 'nin'])
    .describe('Score-band queries (warmup_score < 50 = "New" accounts).'),
  network_size: num(['eq', 'ne', 'gte', 'lte', 'gt', 'lt']),
  has_verification: filterOp(z.boolean(), ['eq']).optional(),
  account_completeness: num(['eq', 'ne', 'gte', 'lte', 'gt', 'lt']),
  account_age_months: num(['eq', 'ne', 'gte', 'lte', 'gt', 'lt']),
  last_post_days: num(['eq', 'gte', 'lte', 'gt', 'lt', 'is_null'])
    .describe('is_null:true ⇒ never posted.'),
  account_diff: num(['gte', 'lte', 'gt', 'lt']),
  sessions_count: num(['eq', 'gte', 'lte', 'gt', 'lt']),
  sessions_diff: num(['gte', 'lte', 'gt', 'lt']).describe('IP-stability signal.'),
  last_month_connection_requests_sent: num(['eq', 'gte', 'lte', 'gt', 'lt']),
  last_month_connection_requests_accepted: num(['eq', 'gte', 'lte', 'gt', 'lt']),
  last_month_messages_sent: num(['eq', 'gte', 'lte', 'gt', 'lt']),
  last_month_messages_received: num(['eq', 'gte', 'lte', 'gt', 'lt']),
  last_month_messages_blocked: num(['eq', 'gte', 'lte', 'gt', 'lt'])
    .describe('Elevated value ⇒ risk.'),
  withdrawal_queue: num(['eq', 'gte', 'lte', 'gt', 'lt']),
  smart_limits_enabled: filterOp(z.boolean(), ['eq']).optional(),
  created_at: dt(['gte', 'lte', 'gt', 'lt']).describe('Primary time filter.'),
  updated_at: dt(['gte', 'lte', 'gt', 'lt']),
  deleted_at: dt(['is_null', 'gte', 'lte']).describe('Default scope: { is_null: true }.'),
}).partial();

const LinkedinAccountSnapshotInclude = z.enum(['linkedin_account']);
const LinkedinAccountSnapshotSortable = z.enum(['created_at', 'warmup_score']);

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const base = {
  service: 'linkedin',
  entity: 'linkedin_account_snapshots',
  mount: 'linkedin.account-monitor',
} as const;

export const linkedinAccountSnapshotsTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_linkedin_account_snapshots',
    description:
      'Per-account warmup snapshots over time (immutable, append-only, captured ~every 22h by the scheduler). ' +
      'Use for: a warmup trend over N days (filter linkedin_account_sid + created_at range), before/after compare (paused automation, rotated proxy/nickname), and reading warmup_breakdown + tips to explain WHY a warmup_score is what it is (score = round(100 × ∏(1 − penalty_pct/100)) over 6 compounding drivers). ' +
      'For the LATEST snapshot per account use linkedin-accounts.search with include[]=linkedin_account_snapshot (1:1); searching here for the latest is more expensive. ' +
      'No q (no text-searchable fields). Sort: created_at (default desc) | warmup_score. include[]: linkedin_account.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-account-snapshots/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    inputSchema: McpSearchRequestSchema(LinkedinAccountSnapshotFilter, LinkedinAccountSnapshotInclude, LinkedinAccountSnapshotSortable, 200),
    outputSchema: McpSearchResponse(LinkedinAccountSnapshot, undefined, LinkedinAccountSnapshotCounts),
    annotations: { title: 'Search LinkedIn account snapshots', ...RO },
  },
];
