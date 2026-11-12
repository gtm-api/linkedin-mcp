// Entity: Email Box (gtm.service.id), "email server" in the app
// Source of truth: product/research/gtm.service.id/entities/email_boxes.md
// Format: registry v2. Each tool carries route metadata so the generic
// dispatcher can drive it. 9 definitions (the email-boxes route group, ADR 001
// D12 of 2026-11-12: a workspace owns several email servers), mounted on
// id.billing because a server is a paid unit of the workspace's subscription;
// 7 served, 2 REST only (surface api). Authored 2026-11-12, after the backend
// (gtm.service.id e2ee6be) and the Email Accounts screen settled the contract.
//
// Per route, what an agent gets and why:
//   search          served. The read every other verb starts from.
//   create          served, dangerous. A purchase: with an active subscription
//                   the unit is charged in the call (prorated), so the preview
//                   gate stands between the agent and the card. No backend route
//                   prices a purchase, so its first call carries no quote.
//   confirm-checkout REST only. It follows a person's own gesture in the app:
//                   paying in the Paddle checkout create opens for a workspace
//                   with no subscription, which only the app can open. The
//                   webhook does the same work, so an agent loses nothing. Not a
//                   hidden surface: the route is public to every caller with
//                   can_manage_billing and a REST integrator running its own
//                   Paddle.js checkout needs it, so it keeps its line in the REST
//                   reference (hidden_surfaces is for gated caller populations).
//   update          served. A rename.
//   preview-resize  REST only, and the previewRoute of resize: one door for the
//                   money (the precedent is preview-change, 2026-11-07). The app's
//                   confirm dialog calls the route, so it stays.
//   resize          served, dangerous, previewRoute preview-resize: the first
//                   call carries the quote and the fit.
//   delete          served, dangerous. It gives back a paid unit and destroys the
//                   machine.
//   move-in         served. No money moves and nothing leaves the platform; the
//                   run rolls back on a failure before the import.
//   retry           served. It resumes a run that was already confirmed (and
//                   paid for); no charge.
//
// run.verb / run.status are orchestration's EmailBoxRunVerbEnum and
// EmailBoxRunStatusEnum, which the id contract oracle does not carry, and
// price.interval is a class constant pair on EmailBoxPriceValue: plain strings
// with the values in the description, so no enum here goes unpinned.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  filterOp,
  usageMetaField,
  McpActionResponse,
  McpCreateResponse,
  McpSearchResponse,
  McpSimpleDeleteRequestSchema,
  McpSimpleDeleteResponse,
  McpUpdateResponse,
} from '@gtm/mcp-shared';

const SID = z.string().length(18).startsWith('em_bx_')
  .describe('Email server sid (em_bx_...).');

const EmailBoxPlan = z.enum(['starter', 'growth', 'agency', 'dedicated'])
  .describe('Mailboxes per plan: starter 100, growth 500, agency 2000, dedicated 10000.');
const EmailBoxLocation = z.enum(['hel1', 'fsn1', 'nbg1'])
  .describe('hel1 Helsinki, fsn1 Falkenstein, nbg1 Nuremberg.');
const EmailBoxStatus = z.enum(['provisioning', 'active', 'suspended', 'resizing', 'destroying', 'destroyed', 'failed']);
const EmailBoxSuspendedReason = z.enum(['payment_failed', 'unpaid']);

const Money = z.object({
  amount: z.string().describe('Decimal string, e.g. "49.00".'),
  currency: z.string().describe('ISO 4217.'),
});

const EmailBoxRun = z.object({
  verb: z.string()
    .describe('provision, rescale, migrate, suspend, resume, destroy, rotate_secrets, tenant_push or move_accounts.'),
  status: z.string()
    .describe('pending, running, succeeded, failed or cancelled. failed is terminal until retry_email_box_run resumes it.'),
  phase: z.string().nullable(),
  phase_index: z.number().int().nonnegative()
    .describe('1-based among phase_count; 0 before the first phase started.'),
  phase_count: z.number().int().nonnegative(),
  started_at: z.string().nullable(),
  error_code: z.string().nullable(),
}).passthrough();

// The full EmailBoxDomain, in its order. Five fields are per-read joins, not
// columns: seats_cap, seats_used, run, price, renews_at.
const EmailBox = z.object({
  sid: z.string(),
  team_sid: z.string(),
  name: z.string().describe('The label the customer chose; "Server N" when nobody did.'),
  plan: EmailBoxPlan,
  location: EmailBoxLocation.nullable().describe('Null on a server older than the choice.'),
  status: EmailBoxStatus
    .describe('resizing from the moment a plan change is accepted, destroying from the moment a delete is.'),
  suspended_reason: EmailBoxSuspendedReason.nullable()
    .describe('payment_failed: the subscription is past due beyond its grace, or paused. unpaid: more servers of the plan than paid units.'),
  complimentary: z.boolean()
    .describe('The server granted without a paid unit; it cannot be resized or deleted.'),
  seats_cap: z.number().int().nonnegative().describe('Mailboxes the server can hold.'),
  seats_used: z.number().int().nonnegative().describe('Mailboxes it holds now.'),
  ipv4: z.string().nullable(),
  release: z.string().nullable().describe('The gtm.service.email release the server runs.'),
  run: EmailBoxRun.nullable()
    .describe('The newest unfinished lifecycle run of the server, else its newest run when that one failed, else null.'),
  price: Money.extend({
    interval: z.string().describe('month or year.'),
  }).nullable()
    .describe("The plan's unit price on the subscription's cycle. Null for the complimentary server, without a live subscription and once the server is leaving."),
  renews_at: z.string().nullable().describe("The subscription's next billing date."),
  paid_through: z.string().nullable().describe('Set by a delete: the end of the period the server was paid for.'),
  failed_error_code: z.string().nullable(),
  created_at: z.string().nullable(),
  provisioned_at: z.string().nullable(),
  suspended_at: z.string().nullable(),
  updated_at: z.string().nullable(),
}).passthrough();

const EmailBoxFilter = z.object({
  sid: filterOp(z.string(), ['eq', 'in']).optional(),
  status: filterOp(EmailBoxStatus, ['eq', 'ne', 'in', 'nin']).optional()
    .describe('Without it the search answers the servers that still exist; name destroyed to see destroyed ones.'),
}).partial();

// What a workspace with no subscription gets instead of a server: the Paddle.js
// boot pair and the transaction the app opens its checkout on.
const EmailBoxCheckout = z.object({
  client_side_token: z.string().nullable(),
  paddle_environment: z.string(),
  paddle_transaction_id: z.string().nullable(),
}).passthrough();

const EmailBoxResizeQuote = z.object({
  fits: z.boolean().describe("false: the server holds more mailboxes than the plan's cap, and the change would be refused."),
  seats_used: z.number().int().nonnegative(),
  seats_cap_after: z.number().int().nonnegative(),
  amount_due_now: Money.describe('Charged in the change (prorated for the rest of the period); a downgrade is credited instead.'),
  next_amount: Money.extend({
    interval: z.string().describe('month or year.'),
  }).describe('The recurring price of the server from the next period on.'),
});

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const base = {
  service: 'id',
  entity: 'email_boxes',
  mount: 'id.billing',
} as const;

export const emailBoxesTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_email_boxes',
    description:
      "List the workspace's email servers, oldest first: plan, location, status, seats_used of seats_cap, unit price, renews_at, and run (the newest unfinished lifecycle run, else the newest failed one: verb, status, phase_index of phase_count, error_code). Destroyed servers only when filter.status names destroyed. Use it to pick a sid, check room before a move, or watch a purchase or a plan change finish. No cursor; page_size 0 counts only. Requires can_view_email_accounts.",
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/email-boxes/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    inputSchema: z.object({
      filter: EmailBoxFilter.optional(),
      page_size: z.number().int().min(0).max(500).optional()
        .describe('0..500, default 50. 0 = count only (pagination.total_count).'),
      ...usageMetaField,
    }),
    outputSchema: McpSearchResponse(EmailBox),
    annotations: { title: 'Search email servers', ...RO },
  },
  {
    ...base,
    name: 'create_email_box',
    description:
      "Buy an email server, paid as one unit of the plan's price on the workspace's subscription. Spends money. With an active subscription the unit joins it on its own cycle and the prorated amount for the rest of the period is charged to its card in the call (409 payment_declined buys nothing); item is the new server in provisioning, run shows the build. Without one nothing is charged: item is null and checkout holds a Paddle checkout only the app can open, so the user pays on the Email Accounts screen (search_billing_subscriptions tells which case applies). Through MCP it takes two calls: the first, without commit_token, changes nothing and has no price quote; the second, same arguments plus commit_token, buys. The REST route takes no commit_token and buys on the call. Not idempotent: each confirmed call buys another server. 503 email_servers_not_offered: this deployment sells none. Requires can_manage_billing.",
    toolClass: 'complex',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/email-boxes' },
    operation: 'create',
    envelope: 'create',
    availability: 'ga',
    dangerous: true,
    inputSchema: z.object({
      name: z.string().min(1).max(60).describe("The server's label, 1 to 60 characters."),
      plan: EmailBoxPlan,
      location: EmailBoxLocation,
      copy_settings_from: SID.nullable().optional()
        .describe('A serving server of this workspace whose settings and stop-list the new one starts with. Omitted: the stop-list comes from the oldest active server.'),
      ...usageMetaField,
    }),
    outputSchema: McpCreateResponse(EmailBox.nullable()).extend({
      checkout: EmailBoxCheckout.nullable()
        .describe('Set instead of item when the workspace has no subscription: the purchase finishes in the app.'),
    }),
    annotations: { title: 'Buy email server', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    ...base,
    name: 'confirm_email_box_checkout',
    description:
      'Finish a server purchase paid in the Paddle checkout the buy route opened for a workspace with no subscription: reads the transaction from Paddle, mirrors the subscription it created and builds the servers it paid for (result.items). Idempotent; the Paddle webhook does the same work, this makes it immediate. 409 checkout_not_paid until Paddle settles the payment (ask again); 404 for a transaction this workspace did not open. The app calls it when its checkout closes. Requires can_manage_billing.',
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/email-boxes/confirm-checkout' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    surface: 'api',
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      paddle_transaction_id: z.string().startsWith('txn_').max(64)
        .describe('The Paddle transaction (txn_...) of the checkout, as the buy route answered it.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), z.object({ items: z.array(EmailBox) })),
    annotations: { title: 'Confirm email server checkout', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    ...base,
    name: 'update_email_box',
    description:
      'Rename an email server: the label on the Email Accounts screen, 1 to 60 characters. Nothing else changes. Requires can_update_email_accounts.',
    toolClass: 'trivial',
    route: { service: 'id', method: 'PATCH', pathTemplate: '/api/email-boxes/{sid}', sidParam: 'sid' },
    operation: 'update',
    envelope: 'update',
    availability: 'ga',
    dangerous: false,
    inputSchema: z.object({
      sid: SID,
      name: z.string().min(1).max(60).describe('The new label, 1 to 60 characters.'),
      ...usageMetaField,
    }),
    outputSchema: McpUpdateResponse(EmailBox),
    annotations: { title: 'Rename email server', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    ...base,
    name: 'preview_email_box_resize',
    description:
      "Quote a plan change of an email server without making it: whether its mailboxes fit the new plan (fits, seats_used, seats_cap_after), what Paddle would charge now (amount_due_now) and the server's recurring price from the next period (next_amount). No state change, no charge. Through MCP the first call of resize_email_box runs this route and carries its answer as preview_result. Requires can_manage_billing.",
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/email-boxes/{sid}/preview-resize', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    surface: 'api',
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID,
      plan: EmailBoxPlan,
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), EmailBoxResizeQuote),
    annotations: { title: 'Preview email server plan change', ...RO },
  },
  {
    ...base,
    name: 'resize_email_box',
    description:
      "Change an email server's plan. Spends money: its unit moves to the new plan's price in one subscription update, prorated now (an upgrade charges the difference for the rest of the period, a downgrade credits it). The server reads resizing until the run ends; to or from dedicated it moves to a new machine and its sid changes. Through MCP it takes two calls. The first, without commit_token, changes nothing: preview_result carries the quote (fits, seats_used, seats_cap_after, amount_due_now, next_amount) beside the commit_token. Show the money to the user; do not commit when fits is false; status unanswered means no quote came back, say so. The second call, same arguments plus commit_token, commits. The REST route takes no commit_token and commits on the call: POST /api/email-boxes/{sid}/preview-resize is its preview. 409 email_box_does_not_fit, email_box_busy, email_box_complimentary, email_box_not_billed; 422 email_box_already_on_plan. Requires can_manage_billing.",
    toolClass: 'complex',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/email-boxes/{sid}/resize', sidParam: 'sid' },
    // The first call's own backend read: the route the app's confirm dialog
    // reads the same quote from.
    previewRoute: { service: 'id', method: 'POST', pathTemplate: '/api/email-boxes/{sid}/preview-resize', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID,
      plan: EmailBoxPlan,
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(EmailBox),
    // Asked again with the same plan, the change is refused (busy, then already
    // on the plan), so a repeat has no further effect.
    annotations: { title: 'Change email server plan', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    ...base,
    name: 'delete_email_box',
    description:
      "Delete an email server that holds no mailbox: it reads destroying at once, its paid unit goes back to the subscription with no refund (paid_through: the end of the paid period) and the machine is destroyed. Move its mailboxes out first (move_in_email_box_mailboxes on another server), else 409 email_box_has_mailboxes. 409 email_box_busy during a plan change, email_box_complimentary for the granted server. Repeating it is safe. Through MCP the first call only previews. Requires can_manage_billing.",
    toolClass: 'typical',
    route: { service: 'id', method: 'DELETE', pathTemplate: '/api/email-boxes/{sid}', sidParam: 'sid' },
    operation: 'delete',
    envelope: 'delete_simple',
    availability: 'ga',
    dangerous: true,
    inputSchema: McpSimpleDeleteRequestSchema('em_bx_'),
    outputSchema: McpSimpleDeleteResponse.extend({ item: EmailBox }),
    annotations: { title: 'Delete email server', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    ...base,
    name: 'move_in_email_box_mailboxes',
    description:
      'Move mailboxes from another email server of the workspace into this one (sid receives): up to 100, all on from_email_box_sid, both servers active. Runs in the background (result.run); the mailboxes stop syncing until they land, and a failure before the import puts them back. Hosted mailboxes and ones with mail queued to send stay. Watch run in search_email_boxes; retry_email_box_run resumes a failed move. 409 not_enough_seats (free, needed), email_box_busy. Requires can_update_email_accounts.',
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/email-boxes/{sid}/move-in', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID.describe('The server that receives the mailboxes (em_bx_...).'),
      from_email_box_sid: SID.describe('The server that holds them now (em_bx_...).'),
      email_account_sids: z.array(z.string().length(18).startsWith('em_ac_')).min(1).max(100)
        .describe('The mailboxes to move (em_ac_...), 1 to 100, no repeats.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), z.object({ run: EmailBoxRun })),
    annotations: { title: 'Move mailboxes into email server', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    ...base,
    name: 'retry_email_box_run',
    description:
      "Retry the failed lifecycle run of an email server (a build, a plan change, a mailbox move or a delete): orchestration resumes it at the phase that failed. Read the failure first in search_email_boxes (run.status failed, run.error_code). No charge. 409 email_box_no_failed_run when the server's newest run did not fail; 409 email_box_busy while one is still running. Requires can_manage_billing.",
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/email-boxes/{sid}/retry', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: SID, ...usageMetaField }),
    outputSchema: McpActionResponse(EmailBox),
    annotations: { title: 'Retry email server run', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
];
