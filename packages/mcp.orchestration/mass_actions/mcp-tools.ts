// Entity: MassAction (gtm.service.orchestration)
// Source of truth: product/research/gtm.service.orchestration/entities/mass_actions.md
//   (v3.1 statusless / standing-run, signed)
// Format: registry v2. 9 tools = the 9 public api/mass-actions routes, verified
// against fixtures/contract-oracle/orchestration.contract.json. Mounted alone on
// /mcp/orchestration/mass-actions: this is the planner surface, and a client that
// wants to plan a run should not have to load the webhook registry to find it.
//
// The surface an LLM uses to run a bulk dispatch end to end:
//   preview -> (consent) -> create -> get / metrics -> pause / resume / release
//   -> delete
//
// TWO DIFFERENT `commit_token`s exist in this codebase and they are NOT the same
// artifact. Read this before touching `dangerous` on any tool here.
//
//   1. The BACKEND token (this file). Minted by POST /api/mass-actions/preview,
//      consumed by POST /api/mass-actions. A stateless HMAC over
//      {team_sid, actor, target_entity, title, plan, scope, schedule, canary_mode}
//      with a 15-minute TTL (MassActionCommitToken in gtm.service.orchestration).
//      It is the run's single consent artifact: one approval covers all items x
//      all steps, and any drift in the plan or scope invalidates it.
//   2. The WORKER token (runtime/middleware/preview-gate.ts). Injected into every
//      `dangerous: true` tool's input schema by server-factory.ts, minted and
//      verified by the gate, and never forwarded to the backend.
//
// They collide on the JSON key. If `create_mass_action` were `dangerous: true`,
// the gate would read the caller's BACKEND token out of `commit_token`, fail to
// verify it as its own HMAC (bad_signature), and answer "request a fresh preview"
// without ever calling the backend. The run could never be committed. So create
// is `dangerous: false` and the backend's own preview -> commit contract IS the
// gate here: it is strictly stronger than the generic one (it validates the whole
// plan, prices it, and lists the destructive steps before anything is enrolled),
// and the research locks exactly one consent layer for plan mode ("no second
// confirmation layer"). `delete_mass_action` keeps the generic gate: its input is
// a bare sid, so there is nothing to collide with.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  filterOp,
  usageMetaField,
  AccessIdentityValue,
  McpActionResponse,
  McpCreateResponse,
  McpCascadeDeleteResponse,
  McpSimpleDeleteRequestSchema,
  McpGetRequestSchema,
  McpGetResponse,
  McpMetricsRequestSchema,
  McpMetricsResponse,
  McpSearchRequestSchema,
  McpSearchResponse,
} from '@gtm/mcp-shared';

const SID = z.string().length(18).startsWith('ma_ac_')
  .describe('Mass-action sid (ma_ac_...).');

// Control axis only. NOT an outcome: "did it finish / how did it go" is read
// from item metrics (in_flight = 0 means settled), "was it stopped" from
// deleted_at. MassActionStatusEnum in gtm.lib.common.
const MassActionStatus = z.enum(['active', 'paused']);

const MassActionPausedReason = z.enum([
  'manual', 'limit_reached', 'account_unavailable', 'canary_failed', 'other',
]);

const MassActionCanaryMode = z.enum(['none', 'first_item']);

// The plan-step vocabulary, mirrored from MassActionStepToolEnum in
// gtm.lib.common. One case there = one arm of the live CrossServiceStepExecutor,
// so this list is the set of verbs the engine can actually drive today, not the
// larger generator-built vocabulary the research file describes. Anything outside
// it is rejected by preview with 422 not_step_eligible before a single item is
// enrolled, so it is worth constraining here rather than letting an agent author
// a plan the server will refuse.
const MassActionStepToolCanonical = z.enum([
  'linkedin-connection-requests.send-linkedin-connection-request',
  'linkedin-posting.react',
  // Added 2026-08-13. Spends comment_posts (30/day at a 360 s floor), a much tighter
  // budget than the reaction above: size a run accordingly. Takes `text` from the step
  // args, and replies in-thread when the item payload carries a parent comment urn,
  // which a get-post-commenters row does.
  'linkedin-posting.comment',
  // Added 2026-08-13. Send-class, so a plan containing it requires a schedule.
  // Spends send_messages (50/day at a 480 s floor). Takes `text` from the step args
  // and the recipient from the item payload: an existing thread if the item has one,
  // otherwise the member id to open one with. A cold first touch to a non-connection
  // is refused by the owning service, so put a connect step earlier if you need one.
  'linkedin-messages.send',
  // Added 2026-08-13. The cheapest, lowest-risk engagement LinkedIn offers: needs no
  // connection and is idempotent, so a retried step is safe and it is the natural
  // warm-up leg of a follow, wait, connect sequence. Spends networking_general
  // (40/day at a 180 s floor), shared with accept / ignore / withdraw / remove.
  // `linkedin-followings.unfollow` is deliberately NOT authorable.
  'linkedin-followings.follow',
  'email-messages.send',
  // Antidetect-browser fleet (accounts-page mass bar + "provision N browsers").
  // 'antidetect-browsers.create' is the generate-scope anchor (mints the row).
  'antidetect-browsers.run',
  'antidetect-browsers.stop',
  'antidetect-browsers.delete',
  'antidetect-browsers.create',
  'antidetect-browsers.generate-cloud-browser-access-key',
  'antidetect-browsers.revoke-cloud-browser-access-key',
  // Linkedin-account mass-edit. Only update-sync-config is a mass operation;
  // display-field `update` and `reset-sync` are single-account (public verbs +
  // update_linkedin_account / reset_linkedin_account_sync tools), not mass steps.
  'linkedin-accounts.update-sync-config',
  // Smart-limit mass-edit.
  'linkedin-account-smart-limits.update',
  'linkedin-account-smart-limits.reset-hold',
]);

// The connect verb answers to two wire spellings for ONE executor arm: the
// canonical one above and the route-path spelling below, which stored plans use.
// PHP accepts both (MassActionStepToolEnum::acceptedValues()), so re-previewing a
// plan read back off an existing run must not fail here. Authors should pick from
// the canonical set; the alias is accepted, never recommended.
const MassActionStepTool = z.union([
  MassActionStepToolCanonical,
  z.literal('linkedin-connection-requests.send'),
]).describe(
  "Dotted verb '{entity-kebab-plural}.{verb}'. Only these are step-eligible today; anything else fails preview with 422 not_step_eligible on field plan.steps.{i}.tool. 'linkedin-connection-requests.send' is a legacy alias of the send-linkedin-connection-request case, accepted but not the spelling to author.",
);

const MassActionPlanStep = z.object({
  tool: MassActionStepTool,
  args: z.record(z.unknown()).optional()
    .describe("The verb's own arguments, EXCLUDING the target: the target is injected per item from the object cursor or the item payload. Shared across every item of the run."),
}).passthrough();

const MassActionPlan = z.object({
  steps: z.array(MassActionPlanStep).min(1).max(3)
    .describe('1..3 steps, run in order per item. Step ids are server-assigned 1-based ordinals; do not send them. Longer intents split into sequential mass-actions.'),
});

const MassActionSchedule = z.object({
  interval_seconds_min: z.number().int().min(30).max(86400),
  interval_seconds_max: z.number().int().min(30).max(86400)
    .describe('>= interval_seconds_min.'),
}).describe('Paces ITEM STARTS with per-gap jitter (item k starts at item k-1 plus a uniform draw from this window). Steps inside one item run contiguously. Mandatory when the plan carries a send-class step.');

// Four create-time shapes. Not a stored column: the executor branches on each
// ITEM's shape at runtime, so there is no scope_kind on the row.
const MassActionScope = z.union([
  z.object({
    kind: z.literal('objects'),
    object_sids: z.array(z.string().length(18)).min(1).max(100)
      .describe('Existing rows of the target_entity family, 1..100.'),
  }),
  z.object({
    kind: z.literal('targets'),
    targets: z.array(z.record(z.unknown())).min(1).max(100)
      .describe('1..100 payload-kind identities (send-class); per-item params, shape owned by the target entity.'),
  }),
  z.object({
    kind: z.literal('generate'),
    count: z.number().int().min(1).max(100)
      .describe('N slot items with no pre-existing object; step 1 must be a creates: verb.'),
  }),
  z.object({ kind: z.literal('none') })
    .describe('Empty: a STANDING run at 0 items that an auto-scrape appends into over time.'),
]);

// Item schema: MassActionDomain field for field (20 fields, oracle order).
// passthrough keeps forward-compat if the backend adds one.
const MassAction = z.object({
  sid: z.string(),
  team_sid: z.string(),
  target_entity: z.string(),                              // kebab-plural family the plan operates on
  plan: z.record(z.unknown()),                            // MassActionPlanValue: { steps: [{id, tool, args}] }
  canary_mode: MassActionCanaryMode,
  status: MassActionStatus,
  total_count: z.number(),                                // grows on append (standing runs); no terminal counters
  credits_spent: z.number(),                              // running meter, no cap
  title: z.string().nullable(),
  schedule: z.record(z.unknown()).nullable(),             // MassActionScheduleValue; null = ASAP drain
  paused_reason: MassActionPausedReason.nullable(),       // populated only while status='paused'
  hold_till: z.string().nullable(),                       // auto-resume clock; null while paused = manual resume only
  canary_satisfied_at: z.string().nullable(),             // null = gate closed, only position 1 dispatches
  started_at: z.string().nullable(),
  settled_at: z.string().nullable(),                      // most recent moment in_flight hit 0
  created_by: AccessIdentityValue.passthrough().nullable(),
  deleted_by: AccessIdentityValue.passthrough().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),                      // set = the run was stopped
}).passthrough();

// The agentic monitoring rollup (MassActionMetricsService). Served flat under
// response.metrics, and embeddable per row via include=metrics on get.
const MassActionMetrics = z.object({
  items_by_status: z.record(z.number()),
  items_by_current_step: z.record(z.number()),
  items_by_wait_reason: z.record(z.number()),
  in_flight: z.number(),                                  // pending + queued + running; 0 = caught up
  next_scheduled_at: z.string().nullable(),
  last_scheduled_at: z.string().nullable(),
  credits_spent: z.number(),
  created_objects: z.record(z.number()),
  top_errors: z.array(z.object({ prefix: z.string(), count: z.number() }).passthrough()),
}).passthrough();

const MassActionPreview = z.object({
  items_count: z.number(),                                // 0 for kind:'none'
  steps_per_item: z.number(),
  credits_estimate: z.number(),
  dangerous_steps: z.array(z.object({ step_id: z.number(), tool: z.string() }).passthrough()),
  eta: z.object({
    starts: z.string(),                                   // 'asap' | 'scheduled'
    estimated_completion_at: z.string().nullable(),
  }).passthrough(),
  warnings: z.array(z.string()),
}).passthrough();

const MassActionPreviewResult = z.object({
  preview: MassActionPreview,
  commit_token: z.string(),
  expires_at: z.string(),
}).passthrough();

const MassActionPauseResult = z.object({
  frozen_pending_count: z.number(),
  in_flight_running_count: z.number(),
}).passthrough();

const MassActionResumeResult = z.object({
  rescheduled_pending_count: z.number(),
  next_item_scheduled_at: z.string().nullable(),
}).passthrough();

const MassActionReleaseResult = z.object({
  released_pending_count: z.number(),
  next_item_scheduled_at: z.string().nullable(),
}).passthrough();

// Every key here exists on the PHP MassActionFilter (12 fields). A key it does
// not declare is a 500 inside the backend, not a 422, so this list is pinned by
// the contract-parity gate.
const MassActionFilter = z.object({
  sid: filterOp(z.string(), ['eq', 'in']).optional(),
  team_sid: filterOp(z.string(), ['eq']).optional()
    .describe('Auto-applied from the JWT scope; not overridable.'),
  target_entity: filterOp(z.string(), ['eq', 'ne', 'in', 'nin']).optional(),
  status: filterOp(MassActionStatus, ['eq', 'in']).optional(),
  paused_reason: filterOp(MassActionPausedReason, ['eq', 'in', 'is_null']).optional(),
  hold_till: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(),
  canary_satisfied_at: filterOp(z.string(), ['is_null', 'gte', 'lte']).optional()
    .describe('is_null:true = the canary gate is still closed.'),
  started_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(),
  settled_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(),
  created_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  updated_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  deleted_at: filterOp(z.string(), ['is_null', 'gte', 'lte']).optional()
    .describe('Omit for live runs only; send any operator to bring stopped (soft-deleted) runs into scope.'),
}).partial();

// The two actions take DIFFERENT include vocabularies, and they are two
// mechanisms rather than one list split in half.
//
// `get` serves `metrics`, assembled inline by the controller from
// MassActionMetricsService: the full breakdown for ONE run. It has no
// FormRequest, so no Rule::in describes it and the parity gate cannot see it.
//
// `search` serves `item_counts` through MassActionIncludedBuilder, one grouped
// count per row, and MassActionSearchRequest validates it with
// Rule::in(MassActionIncludedBuilder::available()). The full `metrics` shape is
// deliberately NOT an include there: it scans every item of every row on the page.
//
// This block previously said search emitted an empty included block for every row
// and that only `metrics` was served anywhere. Both halves stopped being true when
// item_counts landed, and the stale contract-oracle fixture kept the parity gate
// green over it until 2026-08-13.
const MassActionInclude = z.enum(['metrics']);

const MassActionSearchInclude = z.enum(['item_counts']);

const MassActionSortable = z.enum(['created_at', 'updated_at', 'settled_at', 'total_count']);

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE_IDEM = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DANGER_IDEM = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

const base = {
  service: 'orchestration',
  entity: 'mass_actions',
  mount: 'orchestration.mass_actions',
} as const;

export const massActionsTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_mass_actions',
    description:
      "List the team's bulk runs with filter, sort and cursor pagination. Filter by status (active / paused), paused_reason, target_entity, canary_satisfied_at (is_null:true = the canary gate is still closed), or the created / updated / started / settled time ranges. status is a CONTROL axis, not an outcome: to learn how a run went call get_mass_actions_metrics or get_mass_action with include=metrics. Stopped runs are excluded unless deleted_at is filtered explicitly. page_size:0 returns the count alone.",
    toolClass: 'typical',
    route: { service: 'orchestration', method: 'POST', pathTemplate: '/api/mass-actions/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: McpSearchRequestSchema(MassActionFilter, MassActionSearchInclude, MassActionSortable, 200),
    outputSchema: McpSearchResponse(MassAction),
    annotations: { title: 'Search mass-actions', ...RO },
  },
  {
    ...base,
    name: 'get_mass_action',
    description:
      'Fetch one bulk run by sid: the plan that runs, status / paused_reason / hold_till, the canary gate, credits_spent and settled_at. include=metrics adds the item breakdown, which is where outcome lives.',
    toolClass: 'trivial',
    route: { service: 'orchestration', method: 'GET', pathTemplate: '/api/mass-actions/{sid}', sidParam: 'sid' },
    operation: 'get',
    envelope: 'get',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: McpGetRequestSchema('ma_ac_', MassActionInclude),
    outputSchema: McpGetResponse(MassAction),
    annotations: { title: 'Get mass-action', ...RO },
  },
  {
    ...base,
    name: 'preview_mass_action',
    description:
      [
        'Validate a whole bulk plan without running anything and mint the consent token create_mass_action consumes. ALWAYS the first call of a bulk dispatch.',
        '',
        'Validates in one pass, reporting all findings at once: plan shape (1..3 steps), step-eligibility of each tool, scope shape and size (1..100), the generate-scope rule (step 1 must mint an object) and the send-class schedule mandate. A tool outside the step vocabulary comes back 422 validation_failed with error.field_errors["plan.steps.{i}.tool"] = ["not_step_eligible: ..."], naming the authorable set so the plan is repairable in one turn. Nothing is persisted, charged or created.',
        '',
        'On success the result carries preview (items_count, steps_per_item, credits_estimate, dangerous_steps, eta, warnings), commit_token and expires_at. Show the preview to the user, then pass the token to create_mass_action UNCHANGED with the exact same inputs: it is an HMAC over them plus the caller, so any edit invalidates it (422) and needs a fresh preview. Tokens live 15 minutes.',
      ].join('\n'),
    toolClass: 'complex',
    route: { service: 'orchestration', method: 'POST', pathTemplate: '/api/mass-actions/preview' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    massAction: false,
    stepEligible: false,
    scheduleRequired: false,
    inputSchema: z.object({
      title: z.string().max(255).nullable().optional()
        .describe('Human label for the run, shown in the list view and on the consent surface.'),
      target_entity: z.string().max(128)
        .describe("Kebab-plural entity family the plan's steps operate on, e.g. 'linkedin-connection-requests', 'linkedin-posting' or 'email-messages'. The compatibility anchor a linked auto-scrape checks against."),
      scope: MassActionScope
        .describe('What the run enrols: existing rows (objects), payload identities (targets), generated slots (generate), or nothing yet (none, a standing run an auto-scrape feeds).'),
      plan: MassActionPlan,
      schedule: MassActionSchedule.nullable().optional()
        .describe('Omit for an ASAP drain. Required when the plan carries a send-class step, else 422 schedule_required.'),
      canary_mode: MassActionCanaryMode.optional()
        .describe("Default 'first_item': only item 1 dispatches until it succeeds, so a wrong plan burns one target instead of all of them."),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), MassActionPreviewResult),
    annotations: { title: 'Preview mass-action plan', ...RO },
  },
  {
    ...base,
    name: 'create_mass_action',
    description:
      [
        'Commit a previewed plan into a running bulk dispatch. Requires the commit_token from preview_mass_action over EXACTLY these inputs: the server re-derives the HMAC, so an edited plan, a changed scope or a different caller is 422 invalid_commit_token, and a token older than 15 minutes is 422 commit_token_expired. Re-preview in either case.',
        '',
        'Re-runs the full preview validation, then inserts the run plus its items and starts dispatching in one transaction. Always asynchronous, even for one item: the returned sid IS the monitoring handle. Poll get_mass_action with include=metrics or get_mass_actions_metrics, or subscribe to the mass-actions.settled / .paused webhooks.',
        '',
        'With canary_mode=first_item only item 1 runs until it succeeds; a canary failure pauses the run with paused_reason=canary_failed. A none-scope run is created empty (total_count 0) and dispatches nothing until an auto-scrape appends leads into it. Replaying a still-valid token creates a SECOND identical run, so discard the token after use.',
      ].join('\n'),
    toolClass: 'complex',
    route: { service: 'orchestration', method: 'POST', pathTemplate: '/api/mass-actions' },
    operation: 'create',
    envelope: 'create',
    availability: 'ga',
    // See the header note: the backend's own preview -> commit_token contract is
    // the consent gate for this verb, and the generic worker gate cannot be
    // layered on top because both claim the `commit_token` argument.
    dangerous: false,
    creditable: false,
    inputSchema: z.object({
      title: z.string().max(255).nullable().optional(),
      target_entity: z.string().max(128),
      scope: MassActionScope,
      plan: MassActionPlan,
      schedule: MassActionSchedule.nullable().optional(),
      canary_mode: MassActionCanaryMode.optional(),
      commit_token: z.string().max(512)
        .describe('The token preview_mass_action returned for these exact inputs. Not the confirmation token of the protected-tool preview flow: it comes from preview_mass_action and nowhere else.'),
      ...usageMetaField,
    }),
    outputSchema: McpCreateResponse(MassAction),
    annotations: { title: 'Create mass-action', ...WRITE },
  },
  {
    ...base,
    name: 'get_mass_actions_metrics',
    description:
      "Where a run is right now, in one round-trip, without paging items. Typical call: filter {sid:{eq}}. Returns items_by_status (the outcome split), items_by_current_step, items_by_wait_reason, in_flight (0 means the run is caught up), the next / last scheduled item, credits_spent, created_objects and the top error prefixes. No group_by: the shape is fixed. Use this instead of listing a run's items to answer 'how is it going'.",
    toolClass: 'typical',
    route: { service: 'orchestration', method: 'POST', pathTemplate: '/api/mass-actions/metrics' },
    operation: 'metrics',
    envelope: 'metrics',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: McpMetricsRequestSchema(MassActionFilter),
    outputSchema: McpMetricsResponse(MassActionMetrics),
    annotations: { title: 'Mass-action metrics', ...RO },
  },
  {
    ...base,
    name: 'pause_mass_action',
    description:
      "Freeze dispatch: status becomes paused with paused_reason='manual'. Queued jobs roll back at pre-flight and in-flight items finish their current step, then stop at the boundary; vendor calls already on the wire are never aborted. Pass hold_till to arm auto-resume at that moment, omit it to wait for an explicit resume_mass_action. Idempotent: pausing a paused run refreshes it.",
    toolClass: 'typical',
    route: { service: 'orchestration', method: 'POST', pathTemplate: '/api/mass-actions/{sid}/pause', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    massAction: false,
    stepEligible: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID,
      hold_till: z.string().nullable().optional()
        .describe('ISO 8601 UTC moment for the scheduler to resume the run by itself. Must be in the future (else 422 hold_till_in_past).'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(MassAction, MassActionPauseResult),
    annotations: { title: 'Pause mass-action', ...WRITE_IDEM },
  },
  {
    ...base,
    name: 'resume_mass_action',
    description:
      'Unfreeze dispatch: status becomes active, paused_reason and hold_till are cleared, and pending items are re-planned onto a fresh jitter chain from now. Items that deferred mid-cascade restart at their current step, so completed steps are not re-run. Does NOT touch the canary gate: after a canary_failed pause only the retried canary dispatches, and release_mass_action_canary is what opens the gate. 409 invalid_transition if the run is not paused.',
    toolClass: 'typical',
    route: { service: 'orchestration', method: 'POST', pathTemplate: '/api/mass-actions/{sid}/resume', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    massAction: false,
    stepEligible: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID,
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(MassAction, MassActionResumeResult),
    annotations: { title: 'Resume mass-action', ...WRITE_IDEM },
  },
  {
    ...base,
    name: 'release_mass_action_canary',
    description:
      'Open the canary gate by hand: stamps canary_satisfied_at and releases every remaining item, the same sweep the canary would have triggered by succeeding. Use it when the first item failed for a reason you accept, or when you do not want to wait for it. Valid only while the run is live, canary_mode=first_item and the gate is still closed, else 409 invalid_transition. Releasing a PAUSED run stamps the gate but dispatches nothing until resume_mass_action: the pause dominates.',
    toolClass: 'typical',
    route: { service: 'orchestration', method: 'POST', pathTemplate: '/api/mass-actions/{sid}/release', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    massAction: false,
    stepEligible: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID,
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(MassAction, MassActionReleaseResult),
    annotations: { title: 'Release mass-action canary', ...WRITE_IDEM },
  },
  {
    ...base,
    name: 'delete_mass_action',
    description:
      'STOP a bulk run. This is the cancel path and it works at any status: pending and queued items are swept to cancelled, running items finish their current step and stop at the boundary, an auto-scrape feeding a standing run stops being able to append, and the run is soft-deleted. The cascade block reports how many were cancelled and how many were still in flight. Items stay queryable; there is no undo through MCP, and a plan cannot be edited, so restarting means a fresh preview and create.',
    toolClass: 'typical',
    route: { service: 'orchestration', method: 'DELETE', pathTemplate: '/api/mass-actions/{sid}', sidParam: 'sid' },
    operation: 'delete',
    envelope: 'delete_cascade',
    availability: 'ga',
    dangerous: true,
    creditable: false,
    inputSchema: McpSimpleDeleteRequestSchema('ma_ac_'),
    outputSchema: McpCascadeDeleteResponse,
    annotations: { title: 'Stop and delete mass-action', ...DANGER_IDEM },
  },
];
