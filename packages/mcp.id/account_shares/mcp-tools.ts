// Entity: Account Share (gtm.service.id)
// Source of truth: product/research/gtm.service.id/entities/account_shares.md
// Format: registry v2. Each tool carries route metadata so the generic
// dispatcher can drive it. 5 tools (the whole account-shares route group),
// mounted on id.access: a share is another TEAM acting through this team's
// connected account, so it sits with the other grantable, revocable delegations
// (API keys, OAuth authorizations) rather than on the org roster. See
// PACKAGES.md for the placement argument.
//
// Account Sharing is TEMPORARY, revocable lending of a connected account to
// another workspace. Permanent ownership handover is `account_transfers`, whose
// controller methods carry no #[ApiMethod] at all: it has no MCP tool by design,
// so an agent can never be talked into giving an account away for good. Every
// description below repeats that disambiguation, because the tool description is
// the only place an agent reads it.
//
// ALL THREE WRITE TOOLS ARE ALWAYS ASYNC. None of them finishes the work it
// starts: each commits an intent on the share row and returns, and the row's
// `status` is the answer. A 2xx is never success on its own.
//
// There is no `get` route and no `/{sid}` route on this entity, so single-row
// polling is search_account_shares with filter { sid: { eq } }.
//
// Permissions: the controller declares requiredPermission on every route
// (can_view_account_shares on the two reads, can_manage_account_shares on
// create / recall / return) and gtm.service.id runs CheckPermissions on its /api
// group, so a caller without the token gets 403 before the handler runs.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  AccessIdentityValue,
  filterOp,
  usageMetaField,
  McpActionResponse,
  McpCreateResponse,
  McpSearchRequestSchema,
  McpSearchResponse,
} from '@gtm/mcp-shared';

const SID = z.string().length(18).startsWith('ac_sh_')
  .describe('Account share sid (ac_sh_…). This entity has no get route: read one row with search and filter { sid: { eq } }.');

// gtm.lib.common Core/Enums/AccountChannelEnum: shared, not entity-local.
const AccountChannel = z.enum(['linkedin', 'email']);

// The durable phase. Opening: pending, owner_parked, active. Closing: closing,
// holder_released. Giving up: rolling_back (non terminal, the un-park is still
// owed). Terminal: returned, recalled, failed.
const AccountShareStatus = z.enum([
  'pending',
  'owner_parked',
  'active',
  'closing',
  'holder_released',
  'rolling_back',
  'returned',
  'recalled',
  'failed',
]);

const AccountShareEndReason = z.enum([
  'returned_by_holder',
  'recalled_by_owner',
  'holder_deleted_copy',
  'holder_team_purged',
  'owner_team_purged',
]);

const AccountShareFailureReason = z.enum([
  'park_failed',
  'export_failed',
  'copy_refused',
  'probe_stale',
  'team_purged',
]);

// Full projection of AccountShareDomain (25 fields, item-parity checked against
// the oracle). Passthrough keeps live envelopes valid if the Domain grows.
const AccountShare = z.object({
  sid: z.string(),
  team_sid: z.string()
    .describe('The OWNER team: the row tenant, the side that lent the account out.'),
  channel: AccountChannel
    .describe('Which channel service owns the physical account pair.'),
  to_team_sid: z.string()
    .describe('The HOLDER team: the side that borrowed the account.'),
  to_user_sid: z.string().nullable()
    .describe('Resolved user when the share was targeted by email; null when targeted by team sid.'),
  to_email: z.string().nullable()
    .describe('The targeting input kept for audit; null when targeted by team sid.'),
  owner_cluster_id: z.number().int(),
  holder_cluster_id: z.number().int(),
  owner_account_sid: z.string()
    .describe('The owner\'s channel account row, parked for the duration of the loan. Prefix agnostic: ln_ac_ on LinkedIn, em_ac_ on email.'),
  owner_channel_ref: z.string().nullable()
    .describe('Opaque second row the channel needs to name (LinkedIn puts its ab_br_ browser sid here); null when the channel needs none.'),
  holder_account_sid: z.string().nullable()
    .describe('The holder\'s copy. NULL until the copy phase lands, so it is null on every pre-active row.'),
  holder_channel_ref: z.string().nullable(),
  status: AccountShareStatus
    .describe('The durable phase, and the answer to "did the loan start". Only active means the holder can work.'),
  holder_over_slot: z.boolean()
    .describe('True when the holder had no free account slot at create, so the copy landed in the channel\'s subscription hold. The loan still reaches active; the holder cannot work until it upgrades.'),
  end_reason: AccountShareEndReason.nullable()
    .describe('Stamped when an ending is REQUESTED. Only ever set on a row that reached active.'),
  failure_reason: AccountShareFailureReason.nullable()
    .describe('Why a pre-active phase gave up. Non null on exactly rolling_back and failed.'),
  planned_return_at: z.string().nullable()
    .describe('Informational only. When it passes the owner is emailed a recall link once; there is NO auto return.'),
  expiry_notified_at: z.string().nullable(),
  phase_claimed_at: z.string().nullable(),
  phase_attempts: z.number().int()
    .describe('Attempts on the CURRENT phase, reset on every advance. A large and growing value is the stuck signal on a phase that may not give up.'),
  ended_at: z.string().nullable(),
  ended_by: AccessIdentityValue.nullable()
    .describe('Who ended it. The machine readable why is end_reason (an ending) or failure_reason (a failure), never this blob.'),
  created_by: AccessIdentityValue.nullable(),
  created_at: z.string(),
  updated_at: z.string(),
}).passthrough();

// Mirrors AccountShareFilter (gtm.lib.common Microservices/Id/AccountShare).
// No q: there is no free-text axis on a share. The tenant column is absent by
// design: search scopes to team_sid and list-received flips the scope to
// to_team_sid, so the SIDE is chosen by the tool, never by the filter.
const AccountShareFilter = z.object({
  sid: filterOp(z.string(), ['eq', 'in']).optional(),
  channel: filterOp(AccountChannel, ['eq', 'in']).optional()
    .describe('"My LinkedIn loans" vs "my email loans".'),
  status: filterOp(AccountShareStatus, ['eq', 'ne', 'in', 'nin']).optional()
    .describe('The phase. { eq: "active" } is the live set; { in: ["rolling_back","failed"] } is the loans that gave up.'),
  to_team_sid: filterOp(z.string(), ['eq', 'in']).optional()
    .describe('Owner side question: everything lent to team X.'),
  to_user_sid: filterOp(z.string(), ['eq', 'in']).optional(),
  owner_account_sid: filterOp(z.string(), ['eq', 'in']).optional()
    .describe('Share history of an owned account: "is this account lent out, and to whom".'),
  holder_account_sid: filterOp(z.string(), ['eq', 'in']).optional()
    .describe('Holder side question: map a borrowed copy back to its loan.'),
  holder_over_slot: filterOp(z.boolean(), ['eq']).optional()
    .describe('Which loans reached active but landed with no free slot on the holder side.'),
  end_reason: filterOp(AccountShareEndReason, ['eq', 'in', 'is_null']).optional(),
  failure_reason: filterOp(AccountShareFailureReason, ['eq', 'in', 'is_null']).optional(),
  owner_cluster_id: filterOp(z.number().int(), ['eq', 'in']).optional(),
  holder_cluster_id: filterOp(z.number().int(), ['eq', 'in']).optional(),
  phase_claimed_at: filterOp(z.string(), ['is_null', 'lte', 'gte']).optional(),
  planned_return_at: filterOp(z.string(), ['is_null', 'gte', 'lte', 'gt', 'lt']).optional()
    .describe('{ is_null: true } is an open ended lend.'),
  created_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
}).partial();

const AccountShareSortable = z.enum(['created_at', 'planned_return_at', 'updated_at']);

// Both terminating verbs answer with the same two numbers. closing_count is
// shares this call moved to `closing`, NOT shares that finished closing.
const AccountShareCloseResult = z.object({
  closing_count: z.number().int().nonnegative()
    .describe('Shares this call stamped closing. The teardown is the driver\'s, so this is never "recalled" or "returned".'),
  total_matched: z.number().int().nonnegative()
    .describe('True count of active shares the target set held. closing_count below this means a remainder is left; re-read the count before the next call.'),
}).passthrough();

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
// Research pins create as non destructive: it creates a row and destroys
// nothing, and the loan is revocable by recall. Not idempotent, because a second
// create on a live share is a 409 rather than an idempotent return (the two
// calls may name different holders).
const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
// recall / return end a loan, so both are destructive and go through the server
// preview then confirm gate. Repeating one is safe (a terminal row answers 409
// share_not_active), so idempotentHint stays true.
const DANGER_IDEM = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

const base = {
  service: 'id',
  entity: 'account_shares',
  mount: 'id.access',
} as const;

export const accountSharesTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_account_shares',
    description:
      'List the account shares your team ISSUED: accounts you lent OUT to another workspace. Sharing is TEMPORARY and revocable; permanent ownership transfer is a web-app-only flow with no MCP tool, so never offer this as a way to give an account away. This is also the polling surface, since there is no get tool and no /{sid} route: read one loan with filter { sid: { eq } } and watch status until active (the holder can work), failed (it never started, read failure_reason), or terminal recalled / returned. filter.owner_account_sid answers \'is this account lent out and to whom\'; holder_over_slot finds loans that landed with no free slot. The number recall_account_share has to confirm is pagination.total_count here, NOT total_matched; page_size 0 returns it with no rows. No include[], no counts block, no free-text q. Needs can_view_account_shares.',
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/account-shares/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    // The FormRequest declares no include rule and the controller builds no
    // included block, so advertising the param would be a silent no-op.
    inputSchema: McpSearchRequestSchema(AccountShareFilter, undefined, AccountShareSortable, 200)
      .omit({ include: true }),
    outputSchema: McpSearchResponse(AccountShare),
    annotations: { title: 'Search issued account shares', ...RO },
  },
  {
    ...base,
    name: 'list_received_account_shares',
    description:
      'List the account shares your team RECEIVED: accounts on loan TO you. Reach for this whenever the question is about a BORROWED account (what did we borrow, from whom, until when, is it still active), and for search_account_shares when it is about an account your own team owns and lent out. Registered as an action route but it is a plain read, with the same envelope, filters and sorts as search. It is also the holder\'s only programmatic arrival signal, because the domain events fan out to the owner team alone: poll filter { status: { eq: "active" } } sorted by created_at asc. Rows belong to the owner tenant, so created_by and ended_by arrive with permissions emptied and the trace id nulled. No include[], no counts block; page_size 0 returns pagination.total_count alone. Needs can_view_account_shares.',
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/account-shares/list-received' },
    operation: 'action',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    // Oracle: mass_action false, step_eligible false, schedule_required false.
    // A second list surface on one entity, hence an ACTION route, but it fans
    // nothing out and orchestration has no arm that calls it.
    massAction: false,
    stepEligible: false,
    scheduleRequired: false,
    inputSchema: McpSearchRequestSchema(AccountShareFilter, undefined, AccountShareSortable, 200)
      .omit({ include: true }),
    outputSchema: McpSearchResponse(AccountShare),
    annotations: { title: 'List received account shares', ...RO },
  },
  {
    ...base,
    name: 'create_account_share',
    description:
      'Lend ONE of your connected accounts to another workspace, temporarily and revocably. This is a loan, not a handover: permanent ownership transfer has no MCP tool at all. Target exactly one of to_email (resolved to that user\'s working team) or to_team_sid; neither, both, a bad email or a self-target is 422. account_sid is prefix agnostic (ln_ac_, em_ac_); `channel` says which service owns it. ALWAYS ASYNC: returns 201 with status pending, and the loan has NOT started. Poll search_account_shares with filter { sid: { eq } } until status is active (the holder can work) or failed (read failure_reason); rolling_back means it is being undone, so do not re-issue. holder_over_slot true means the copy landed in the holder\'s subscription hold and they cannot work until they upgrade; a share never fails on slots. One row is one account with no bulk arm, so N accounts is N calls. planned_return_at only emails the owner a recall link; there is no auto return. Needs can_manage_account_shares.',
    toolClass: 'complex',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/account-shares' },
    operation: 'create',
    envelope: 'create',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: z.object({
      channel: AccountChannel
        .describe('Which channel service owns the account you are lending.'),
      account_sid: z.string().length(18)
        .describe('The owned account to lend. Length checked only, never prefix checked: the same field names a LinkedIn account (ln_ac_), an email account (em_ac_) or a future channel\'s sender, and `channel` is what says which.'),
      to_email: z.string().email().max(255).optional()
        .describe('Default targeting: the holder team is that user\'s working team. Exactly one of to_email or to_team_sid.'),
      to_team_sid: z.string().length(18).startsWith('ts_tm_').optional()
        .describe('Direct targeting. Exactly one of to_email or to_team_sid; it must not be your own team.'),
      planned_return_at: z.string().nullable().optional()
        .describe('ISO 8601 UTC. Informational only: it drives one owner reminder email with a recall link. There is NO auto return.'),
      ...usageMetaField,
    }),
    outputSchema: McpCreateResponse(AccountShare),
    annotations: { title: 'Lend an account to another workspace', ...CREATE },
  },
  {
    ...base,
    name: 'recall_account_share',
    description:
      'Take a lent-out account back. Owner side, no holder consent. Target EXACTLY ONE of sid (ac_sh_) or filter; neither or both is 422 on sid_or_filter. FILTER MODE fans out over the loans you ISSUED, the server FORCES status to active so your filter can only narrow the set, and it drains INLINE at most 100 shares per call, minting no mass-action row. It also requires confirmation_count equal to the active-pinned pagination.total_count search_account_shares reports for the same filter; anything else is 409 confirmation_count_mismatch. Single-sid mode ignores it. ASYNC: the call stamps status closing and a driver does the teardown, so closing_count means shares that STARTED closing, never shares recalled; poll status to recalled. NOT atomic: a mid-batch error returns no counters and earlier shares stay closing, so re-query search rather than retrying the same body. closing_count below total_matched leaves a remainder; every next call needs a FRESH count. Needs can_manage_account_shares.',
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/account-shares/recall' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    creditable: false,
    // Oracle: mass_action true, step_eligible false, schedule_required false.
    // The filter arm is the fan-out; it is drained inline by the controller,
    // and no orchestration executor arm calls this verb as a plan step.
    massAction: true,
    stepEligible: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID.optional()
        .describe('Single-share mode. Mutually exclusive with filter.'),
      filter: AccountShareFilter.optional()
        .describe('Mass-target mode, resolved against the loans you ISSUED. status is overwritten with eq active server side, so it cannot be widened. Mutually exclusive with sid.'),
      confirmation_count: z.number().int().min(0).optional()
        .describe('Blast-radius confirmation, REQUIRED with filter and ignored with sid. Must equal the active-pinned pagination.total_count of the same filter from search_account_shares; a mismatch is 409, not a partial run.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(AccountShare, AccountShareCloseResult),
    annotations: { title: 'Recall a lent-out account', ...DANGER_IDEM },
  },
  {
    ...base,
    name: 'return_account_share',
    description:
      'Give a borrowed account back early. Holder side. Same shape as recall_account_share: EXACTLY ONE of sid (ac_sh_) or filter, filter mode server-pinned to status active, drained INLINE at most 100 shares per call with no mass-action row minted, and confirmation_count required with filter and matched against the active-pinned pagination.total_count of list_received_account_shares (409 confirmation_count_mismatch otherwise). The difference is the side: the filter resolves over the loans you RECEIVED, and a share you do not hold is 403 not_share_holder. ASYNC: it stamps status closing, then the driver tears the holder copy down and un-parks the owner, so closing_count counts shares that STARTED closing; poll status to returned. Not atomic, and the same remainder and recount rule as recall. Deleting the borrowed copy on the channel has the same effect, ending the loan with end_reason holder_deleted_copy. Needs can_manage_account_shares.',
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/account-shares/return' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    creditable: false,
    // Oracle: mass_action true, step_eligible false, schedule_required false.
    massAction: true,
    stepEligible: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID.optional()
        .describe('Single-share mode. Mutually exclusive with filter.'),
      filter: AccountShareFilter.optional()
        .describe('Mass-target mode, resolved against the loans you RECEIVED. status is overwritten with eq active server side. Mutually exclusive with sid.'),
      confirmation_count: z.number().int().min(0).optional()
        .describe('Blast-radius confirmation, REQUIRED with filter and ignored with sid. Must equal the active-pinned pagination.total_count of the same filter from list_received_account_shares.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(AccountShare, AccountShareCloseResult),
    annotations: { title: 'Return a borrowed account', ...DANGER_IDEM },
  },
];
