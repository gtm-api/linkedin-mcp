// Entity: Mass Action Item (gtm.service.orchestration)
// Source of truth: product/research/gtm.service.orchestration/entities/mass_action_items.md (v3.1)
// Format: registry v2: each tool carries route metadata so the generic
// dispatcher can drive it. 2 tools (the whole mass-action-items route group),
// mounted on orchestration.mass_actions alongside the parent mass_actions.
//
// One row = one target of one mass action, executing the parent's plan step by
// step. This is the entity an agent reads to answer "what failed, at which step,
// and why", so step_log[] is typed entry by entry rather than passed through as
// an opaque blob: a loose record here would hand the LLM a JSON dump it has to
// guess its way around, which is the whole point of the surface.
//
// Every shape below is checked against fixtures/contract-oracle/orchestration.contract.json
// (MassActionItem entity + its two routes), not against the research file alone.
// Where the two disagree, the live backend wins and the divergence is noted inline.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  filterOp,
  usageMetaField,
  McpActionResponse,
  McpSearchRequestSchema,
  McpSearchResponse,
} from '@gtm/mcp-shared';

const SID = z.string().length(18).startsWith('ma_im_')
  .describe('Mass-action item sid (ma_im_…).');

// ─── Enums (gtm.lib.common Microservices/Orchestration/MassActionItem/Enums) ───

// 7-value machine. Terminal: succeeded | failed | skipped | cancelled, all
// reversible via retry, which resumes at current_step.
const MassActionItemStatus = z.enum([
  'pending', 'queued', 'running', 'succeeded', 'failed', 'skipped', 'cancelled',
]);

// Per-STEP state inside step_log[]. 'running' is the started-marker: it is
// committed BEFORE the outbound call, so a crash leaves it dangling and the
// outcome of that call is genuinely unknown (never read it as "did not happen").
const MassActionItemStepStatus = z.enum([
  'running', 'deferred', 'succeeded', 'failed', 'skipped',
]);

// Closed single-value enum: the only mid-cascade wait is an async task in flight.
const MassActionItemWaitReason = z.enum(['task_pending']);

// ─── step_log[] entry: the forensic record of one plan step ───
//
// The backend writes entries as plain arrays and MassActionItemDomain rebuilds
// each one through MassActionItemStepLogEntryValue, whose toArray() is
// get_object_vars(): all nine keys are present on the wire, absent ones as null.
// Hence nullable (not optional) on the six that can be empty. passthrough keeps
// a future key from failing the contract test.
const MassActionItemStepLogEntry = z.object({
  step_id: z.number().int()
    .describe('Ordinal of the parent plan step this entry records (mass_actions.plan.steps[].id).'),
  status: MassActionItemStepStatus,
  started_at: z.string()
    .describe('ISO 8601 UTC. Committed BEFORE the outbound call (started-marker).'),
  finished_at: z.string().nullable()
    .describe('Terminal commit of this step; null while running or deferred.'),
  duration_ms: z.number().int().nullable()
    .describe('Wall clock for the step, defer waits included.'),
  executor_ref: z.string().nullable()
    .describe('Async steps: sid of the dispatched task. The poll handle for a deferred item; null on sync steps.'),
  created_object_type: z.string().nullable()
    .describe('creates-steps: entity family of the object this step minted.'),
  created_object_sid: z.string().nullable()
    .describe('creates-steps: sid of the minted object. Survives a later failure, so it is the cleanup surface.'),
  error_message: z.string().nullable()
    .describe("Step-local failure cause. The item-level error_message repeats it behind a 'step {k} {tool}:' prefix."),
}).passthrough();

// ─── Item projection: every MassActionItemDomain field, in Domain order ───
const MassActionItem = z.object({
  sid: z.string(),
  team_sid: z.string(),
  // Parent linkage
  mass_action_sid: z.string()
    .describe('Parent mass action (ma_ac_…).'),
  position: z.number().int()
    .describe('1-based insertion order, immutable. Position 1 is the canary when the parent runs one.'),
  // Plan progress
  current_step: z.number().int()
    .describe('1-based ordinal into the parent plan: the step the item is on, and the point a retry resumes from.'),
  status: MassActionItemStatus,
  retry_count: z.number().int(),
  // Object cursor: what the NEXT step applies to. Engine-written; a creates-step
  // advances it to whatever it minted, so it can leave the parent target_entity family.
  // Free-form on the wire: MassActionDomain types target_entity as string(128),
  // and there is no MassActionTargetEntityEnum in gtm.lib.common to narrow to.
  // The live spelling is the kebab route group ('antidetect-browsers').
  object_type: z.string().nullable()
    .describe("Cursor entity family in kebab route-group spelling, e.g. 'antidetect-browsers'. Starts as the parent's target_entity; null for payload-kind rows and for generative rows that have not minted anything yet."),
  object_sid: z.string().nullable()
    .describe('Cursor sid: the entity the next step acts on. For a generative run this is what the row has created so far.'),
  payload: z.record(z.unknown()).nullable()
    .describe('Opaque per-item dispatch params (target identity + per-target extras) for payload-kind runs; null for object / generative rows.'),
  step_log: z.array(MassActionItemStepLogEntry)
    .describe('One entry per plan step of the CURRENT attempt, ≤3. Read the last entry for the failure, the earlier ones for what already completed (fail-forward: their effects stand).'),
  // Scheduling / wait: one clock for the pacing chain and for mid-cascade defers.
  scheduled_at: z.string().nullable()
    .describe('"Not before" moment: pacing chain slot, retry re-plan, or the re-poll horizon of a deferred item.'),
  wait_reason: MassActionItemWaitReason.nullable()
    .describe("Why the item is deferred mid-cascade. Null when it is not waiting; a parent-level pause leaves this null."),
  // Current-attempt state
  error_message: z.string().nullable()
    .describe("Failure text with a machine-readable prefix: 'step {k} {tool}:' or 'item_timeout:' (reaper force-fail, outcome unknown)."),
  // Per-attempt timing (per-step timing lives in step_log)
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  duration_ms: z.number().int().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
}).passthrough();

// ─── Filter: mirrors MassActionItemFilter exactly (all 14 declared fields) ───
// A key this PHP class does not declare throws WrongFillableFromArrayFieldException
// inside the backend and reaches the caller as a 500, not a 422, so this list is
// pinned to the oracle by tests/contract-parity.test.ts. Operators per research
// §Filterable fields. No `q` (no full-text column) and no `deleted_at` (append-only).
const MassActionItemFilter = z.object({
  sid: filterOp(z.string(), ['eq', 'in']).optional(),
  team_sid: filterOp(z.string(), ['eq']).optional()
    .describe('Redundant in normal use: the backend already scopes every read to the caller\'s team.'),
  mass_action_sid: filterOp(z.string(), ['eq', 'in']).optional()
    .describe('The parent run (ma_ac_…). The drill-down filter, start here.'),
  object_sid: filterOp(z.string(), ['eq', 'in']).optional()
    .describe('Cursor sid, parent-scoped by contract: always pair it with mass_action_sid. "Which runs ever touched object X" is not a supported query (the contract reserves 422 bounded_scan_required for it); the index is (mass_action_sid, object_sid), so on its own it is a full team scan.'),
  status: filterOp(MassActionItemStatus, ['eq', 'ne', 'in', 'nin']).optional(),
  current_step: filterOp(z.number().int(), ['eq', 'gte', 'lte', 'gt', 'lt']).optional()
    .describe('Which plan step the row sits on: "everyone stuck at step 2".'),
  wait_reason: filterOp(MassActionItemWaitReason, ['eq', 'is_null']).optional()
    .describe("eq:'task_pending' selects the items deferred on an async task."),
  retry_count: filterOp(z.number().int(), ['eq', 'gte', 'lte', 'gt', 'lt']).optional(),
  scheduled_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional()
    .describe('Due horizon: what runs next and when.'),
  started_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(),
  finished_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(),
  duration_ms: filterOp(z.number().int(), ['eq', 'gte', 'lte', 'gt', 'lt', 'is_null']).optional(),
  created_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  updated_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
}).partial();

// BaseCrudService::buildQuery passes sortField straight into orderBy() with no
// allow-list, so an unknown column is a SQL error (500). This enum IS the guard.
const MassActionItemSortable = z.enum([
  'position', 'created_at', 'scheduled_at', 'started_at', 'finished_at', 'duration_ms', 'retry_count',
]);

// The retry envelope: mcpAction(action:'retry', item: null, result: ['retried_count' => n]).
// No mode / per-item errors[] block: research described a richer shape than the
// controller ships, and the controller is what answers the call.
const MassActionItemRetryResult = z.object({
  retried_count: z.number().int().nonnegative()
    .describe('How many failed items were re-entered. 0 means nothing matched, not an error.'),
}).passthrough();

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const DANGER = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

const base = {
  service: 'orchestration',
  entity: 'mass_action_items',
  mount: 'orchestration.mass_actions',
} as const;

export const massActionItemsTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_mass_action_items',
    // Research marks this 'typical', which assumed the counts block would carry
    // the per-step story. It does not exist on the live route, so the description
    // is the only channel the step_log semantics have, and it needs the room.
    toolClass: 'complex',
    description:
      'Per-target drill-down of a mass action: one row per target with current_step, the object cursor (object_type / object_sid, on a generative run what the row created) and step_log[], one entry per plan step with status (running / deferred / succeeded / failed / skipped), executor_ref for async steps, created_object_sid for steps that minted one, and error_message. The last step_log entry says what failed and why, earlier ones what completed: a failed item keeps the effects of its finished steps (fail-forward), created_object_sid is the cleanup surface. Filter by mass_action_sid, then narrow by status / current_step / wait_reason; object_sid is parent-scoped, so always pair it with mass_action_sid (unpaired it degrades to a full team scan). Sort defaults to position asc (insertion order; position 1 is the canary); page_size 0 returns pagination.total_count alone. No include[] and no counts block; run-level aggregation lives on the parent, mass-actions metrics.',
    route: { service: 'orchestration', method: 'POST', pathTemplate: '/api/mass-action-items/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    // The backend FormRequest declares no `include` rule and the controller never
    // builds an included block, so advertising the param would be a silent no-op.
    inputSchema: McpSearchRequestSchema(MassActionItemFilter, undefined, MassActionItemSortable, 200)
      .omit({ include: true }),
    outputSchema: McpSearchResponse(MassActionItem),
    annotations: { title: 'Search mass-action items', ...RO },
  },
  {
    ...base,
    name: 'retry_mass_action_items',
    toolClass: 'complex',
    description:
      'Re-enter FAILED items of a mass action AT their current_step: completed steps are never re-executed, so no duplicate creates and no double sends; their step_log entries and minted objects survive untouched. Target EXACTLY ONE of sid (ma_im_…) or filter; both or neither is a 422 on the sid field. The filter arm re-enqueues every matching failed item in one call and is not parent-scoped, so pass mass_action_sid unless you mean every run. Per item: status becomes pending, retry_count++, error_message and finished_at cleared; the failed step\'s log entry is overwritten by the next attempt. Every affected parent un-settles (settled_at cleared) and settles again when its items drain. Only status=failed rows match: succeeded, skipped, cancelled and in-flight are left alone, so a retry matching nothing returns retried_count 0, not an error. An "item_timeout:" failure is retryable, but that message means the outbound call MAY have landed: check the target before retrying a non-idempotent step such as a send.',
    route: { service: 'orchestration', method: 'POST', pathTemplate: '/api/mass-action-items/retry' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    // Oracle: mass_action true, step_eligible false, schedule_required false.
    // The filter arm fans one call out over every matching item, cross-parent;
    // no arm of CrossServiceStepExecutor calls this verb, so it is not a plan step.
    massAction: true,
    stepEligible: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID.optional()
        .describe('Single-item mode. Mutually exclusive with filter.'),
      filter: MassActionItemFilter.optional()
        .describe('Bulk mode: every failed item matching this filter is re-entered. Mutually exclusive with sid.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), MassActionItemRetryResult),
    annotations: { title: 'Retry mass-action items', ...DANGER },
  },
];
