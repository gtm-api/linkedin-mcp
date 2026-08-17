// Entity: Billing Subscription (gtm.service.id)
// Source of truth: product/research/gtm.service.id/entities/billing_subscriptions.md
// Format: registry v2. Each tool carries route metadata so the generic
// dispatcher can drive it. 13 tools (the billing-subscriptions route group):
// two read tools (search / get) + eleven custom actions. Money-moving mutations
// are dangerous:true → the server-side preview→commit gate applies. Every
// custom action returns the plain McpActionResponse envelope (KNOWLEDGE §1.8);
// the "async" verbs (checkout / pause / resume / cancel) embed their pending
// hint inside result rather than using a top-level pending[]; see research.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  AccessIdentityValueActorTypeEnum,
  filterOp,
  usageMetaField,
  McpActionResponse,
  McpGetRequestSchema,
  McpGetResponse,
  McpSearchRequestSchema,
  McpSearchResponse,
} from '@gtm/mcp-shared';

const SID = z.string().length(18).startsWith('bl_sb_')
  .describe('Billing subscription sid (bl_sb_…).');
const PRICE_SID = z.string().length(18).startsWith('bl_pc_')
  .describe('Billing price sid (bl_pc_…): a bracket / cadence price.');
const TEAM_SID = z.string().length(18).startsWith('ts_tm_')
  .describe('Team sid (ts_tm_…): the applied team.');

const BillingSubscriptionStatusEnum = z.enum(['active', 'past_due', 'paused', 'canceled']);
const BillingSubscriptionCollectionModeEnum = z.enum(['automatic', 'manual']);

// Loose item / counts schemas: full field set is tightened by the Stage-1
// contract tests against live envelopes; passthrough keeps live responses valid.
const BillingSubscription = z.object({
  sid: z.string(),
  owner_user_sid: z.string(),
  team_sid: z.string().nullable(),
  paddle_subscription_id: z.string().nullable(),
  status: BillingSubscriptionStatusEnum,
  collection_mode: BillingSubscriptionCollectionModeEnum,
  price_sid: z.string(),
  quantity: z.number(),
  addons: z.array(z.object({
    product_sid: z.string(),
    price_sid: z.string(),
    paddle_item_id: z.string().nullable(),
    quantity: z.number(),
    status: z.enum(['active', 'canceled']),
  })),
  currency: z.string(),
  current_period_starts_at: z.string().nullable(),
  current_period_ends_at: z.string().nullable(),
  next_billed_at: z.string().nullable(),
  paused_at: z.string().nullable(),
  scheduled_resume_at: z.string().nullable(),
  scheduled_change: z.object({
    action: z.enum(['cancel', 'pause', 'resume']),
    effective_at: z.string(),
    resume_at: z.string().nullable(),
  }).nullable(),
  canceled_at: z.string().nullable(),
  // Shared AccessIdentityValue (general/KNOWLEDGE.md); passthrough tolerates
  // cross-service serialization drift.
  canceled_by: z.object({
    actor_type: AccessIdentityValueActorTypeEnum,
    actor_sid: z.string(),
    team_sid: z.string(),
    permissions: z.record(z.unknown()),
    request_sid: z.string().nullable().optional(),
    reason: z.string().nullable(),
  }).passthrough().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
}).passthrough();

const BillingSubscriptionCounts = z.object({}).passthrough();

const BillingSubscriptionFilter = z.object({
  sid: filterOp(z.string(), ['eq', 'in']).optional(),
  owner_user_sid: filterOp(z.string(), ['eq', 'in']).optional(),
  team_sid: filterOp(z.string(), ['eq', 'in', 'is_null']).optional(),
  paddle_subscription_id: filterOp(z.string(), ['eq', 'in', 'is_null']).optional(),
  status: filterOp(BillingSubscriptionStatusEnum, ['eq', 'ne', 'in', 'nin']).optional(),
  collection_mode: filterOp(BillingSubscriptionCollectionModeEnum, ['eq', 'in']).optional(),
  price_sid: filterOp(z.string(), ['eq', 'in']).optional(),
  current_period_ends_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(),
  next_billed_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(),
  canceled_at: filterOp(z.string(), ['gte', 'lte', 'is_null']).optional(),
  created_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  updated_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  deleted_at: filterOp(z.string(), ['is_null', 'gte', 'lte']).optional(),
}).partial();

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const DANGER = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

const base = {
  service: 'id',
  entity: 'billing_subscriptions',
  mount: 'id.billing',
} as const;

// Closed sets taken verbatim from the route rules(): an in: rule answers a 422
// with "invalid", never with the list, so the tool has to carry it.
const BillingSubscriptionInclude = z.enum(['price', 'product', 'team', 'latest_transactions']);
const BillingSubscriptionSortable = z.enum(['created_at', 'updated_at', 'current_period_ends_at']);

export const billingSubscriptionsTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_billing_subscriptions',
    description:
      "List the caller's billing subscriptions: the ones they bought (owner = caller, including floating subscriptions applied to no team) plus the one applied to a team they can read. Filter by status, team_sid:{is_null:true} for floating, paddle_subscription_id:{is_null:true} for the internal sentinels (free/partner), or current_period_ends_at for expiry windows. include price / product / team / latest_transactions to hydrate context. page_size:0 returns counts only.",
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/billing-subscriptions/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    inputSchema: McpSearchRequestSchema(BillingSubscriptionFilter, BillingSubscriptionInclude, BillingSubscriptionSortable),
    outputSchema: McpSearchResponse(BillingSubscription, undefined, BillingSubscriptionCounts),
    annotations: { title: 'Search billing subscriptions', ...RO },
  },
  {
    ...base,
    name: 'create_billing_subscription_checkout',
    description:
      'Start a self-serve purchase of a subscription. DANGEROUS (charges money): it pre-creates a billed Paddle transaction and returns a hosted checkout_url the buyer pays in the Paddle overlay (server-side preview→commit gate applies). Resolves the bracket price for the requested slot count, optionally applies to team_sid on activation (omit to buy floating), and can bundle add-ons in the same checkout. The real subscription row is born on the billing-subscriptions.activated webhook; poll get/search afterwards. Requires billing.manage.',
    toolClass: 'complex',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/billing-subscriptions/create-checkout' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      price_sid: PRICE_SID,
      quantity: z.number().int().min(1).describe('Slots to buy on the base plan line; must fall inside the price bracket.'),
      team_sid: TEAM_SID.optional().describe('Apply to this team on activation; omit / null to buy floating.'),
      addons: z.array(z.object({
        price_sid: PRICE_SID,
        quantity: z.number().int().min(1),
      })).optional().describe('Optional add-on items bought in the same checkout (one Paddle transaction).'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(BillingSubscription),
    annotations: { title: 'Create subscription checkout', ...DANGER },
  },
  {
    ...base,
    name: 'apply_billing_subscription',
    description:
      'Apply a floating subscription (owned by the caller) to a team, activating its slots + limits there. Owner-only. DANGEROUS state change (server-side confirm gate); rejects with 409 if the team already has a live applied subscription or is soft-deleted. No charge. Requires billing.manage.',
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/billing-subscriptions/{sid}/apply', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID,
      team_sid: TEAM_SID,
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(BillingSubscription),
    annotations: { title: 'Apply subscription to team', ...DANGER },
  },
  {
    ...base,
    name: 'unapply_billing_subscription',
    description:
      "Detach a subscription from its team, returning it to floating on the buyer's balance. DANGEROUS: removes the team's capacity (the team goes suspended if this was its only applied subscription); does NOT cancel billing or refund. Used to move a subscription to another team. Requires billing.manage.",
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/billing-subscriptions/{sid}/unapply', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: SID, ...usageMetaField }),
    outputSchema: McpActionResponse(BillingSubscription),
    annotations: { title: 'Unapply subscription', ...DANGER },
  },
  {
    ...base,
    name: 'preview_billing_subscription_change',
    description:
      'Read-only proration preview for a quantity / bracket-price change BEFORE committing. Calls Paddle Pricing Preview and returns the immediate charge (upgrade) or next-period credit (downgrade), the resolved new bracket price, and whether it crosses a bracket boundary. No state change, no charge. This is the confirmation gate to show the user before change_billing_subscription. Provide at least one of quantity / price_sid. Requires billing.view.',
    toolClass: 'complex',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/billing-subscriptions/{sid}/preview-change', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID,
      quantity: z.number().int().min(1).optional().describe('Proposed new slot count (re-bracketed automatically).'),
      price_sid: PRICE_SID.optional().describe('Explicit target bracket price; usually resolved from quantity.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(BillingSubscription),
    annotations: { title: 'Preview subscription change', ...RO },
  },
  {
    ...base,
    name: 'change_billing_subscription',
    description:
      'Commit a quantity / bracket-price change. DANGEROUS: an UPGRADE charges the owner\'s card immediately (prorated); a downgrade applies next period (no immediate charge). Server-side preview→commit gate applies; call preview_billing_subscription_change first. manual (sales) subscriptions are not re-bracketed (422). The committed state arrives via webhook; the response returns the optimistic post-change row. Provide at least one of quantity / price_sid. Requires billing.manage.',
    toolClass: 'complex',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/billing-subscriptions/{sid}/change', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID,
      quantity: z.number().int().min(1).optional().describe('New slot count (re-bracketed). Omit for a price-only change.'),
      price_sid: PRICE_SID.optional().describe('Explicit target bracket; usually derived from quantity.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(BillingSubscription),
    annotations: { title: 'Change subscription', ...DANGER },
  },
  {
    ...base,
    name: 'add_billing_subscription_addon',
    description:
      'Add a recurring add-on item to the SAME subscription (one Paddle PATCH, one prorated charge). DANGEROUS: charges the owner\'s card (prorated); server-side confirm gate applies. Idempotent per request_id: a retry with the same token does not re-charge. Requires billing.manage.',
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/billing-subscriptions/{sid}/add-addon', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID,
      price_sid: PRICE_SID.describe('The add-on price (product.type=addon).'),
      quantity: z.number().int().min(1).describe('Units of the add-on.'),
      request_id: z.string().max(64).describe('Client idempotency token; a retry with the same token does not re-charge.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(BillingSubscription),
    annotations: { title: 'Add subscription add-on', ...DANGER },
  },
  {
    ...base,
    name: 'remove_billing_subscription_addon',
    description:
      'Remove an add-on item from the subscription, effective next period (no refund, no immediate charge). DANGEROUS state change (server-side confirm gate). Requires billing.manage.',
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/billing-subscriptions/{sid}/remove-addon', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID,
      price_sid: PRICE_SID.describe('The add-on price to remove.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(BillingSubscription),
    annotations: { title: 'Remove subscription add-on', ...DANGER },
  },
  {
    ...base,
    name: 'pause_billing_subscription',
    description:
      'Pause the subscription effective the next billing period. DANGEROUS state change (server-side confirm gate); while paused the applied team is gated like suspended, slots/data retained, billing stops. No charge. The committed status arrives via webhook. Resume with resume_billing_subscription. Requires billing.manage.',
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/billing-subscriptions/{sid}/pause', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: SID, ...usageMetaField }),
    outputSchema: McpActionResponse(BillingSubscription),
    annotations: { title: 'Pause subscription', ...DANGER },
  },
  {
    ...base,
    name: 'resume_billing_subscription',
    description:
      'Resume a paused subscription; billing continues from the next period and the applied team re-derives active. DANGEROUS state change (server-side confirm gate). No charge. The committed status arrives via webhook. Requires billing.manage.',
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/billing-subscriptions/{sid}/resume', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: SID, ...usageMetaField }),
    outputSchema: McpActionResponse(BillingSubscription),
    annotations: { title: 'Resume subscription', ...DANGER },
  },
  {
    ...base,
    name: 'cancel_billing_subscription',
    description:
      'Cancel the subscription at the end of the current period (terminal). DANGEROUS: the team loses capacity when the period ends, though data is retained and there is no immediate charge or refund. Server-side confirm gate applies. There is no delete verb; cancel is the canonical termination. Requires billing.manage.',
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/billing-subscriptions/{sid}/cancel', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: SID, ...usageMetaField }),
    outputSchema: McpActionResponse(BillingSubscription),
    annotations: { title: 'Cancel subscription', ...DANGER },
  },
  {
    ...base,
    name: 'get_billing_subscription_update_payment_method_link',
    description:
      'Return a short-lived Paddle portal deep link to update the card for this subscription (the typical past_due recovery path). No charge, mutates nothing on our side. Requires billing.manage.',
    toolClass: 'trivial',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/billing-subscriptions/{sid}/get-update-payment-method-link', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: SID, ...usageMetaField }),
    outputSchema: McpActionResponse(BillingSubscription),
    annotations: { title: 'Get update-payment-method link', ...RO },
  },
  {
    ...base,
    name: 'get_billing_subscription',
    description: 'Fetch a single billing subscription by sid, with optional includes (price, product, team, latest_transactions).',
    toolClass: 'trivial',
    route: { service: 'id', method: 'GET', pathTemplate: '/api/billing-subscriptions/{sid}', sidParam: 'sid' },
    operation: 'get',
    envelope: 'get',
    availability: 'ga',
    dangerous: false,
    inputSchema: McpGetRequestSchema('bl_sb_'),
    outputSchema: McpGetResponse(BillingSubscription),
    annotations: { title: 'Get billing subscription', ...RO },
  },
];
