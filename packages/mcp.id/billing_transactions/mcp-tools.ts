// Entity: Billing Transaction (gtm.service.id)
// Source of truth: product/research/gtm.service.id/entities/billing_transactions.md
// Format: registry v2. Each tool carries route metadata so the generic
// dispatcher can drive it. 4 tools (the billing-transactions route group): an
// append-only, read-only financial ledger (search / metrics / get) plus the
// get-invoice action (temporary Paddle invoice-PDF URL, mutates nothing).
// Rows are written only by the Paddle webhook ingest; money moves via Paddle,
// not platform credits.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  filterOp,
  usageMetaField,
  McpActionResponse,
  McpGetRequestSchema,
  McpGetResponse,
  McpMetricsRequestSchema,
  McpMetricsResponse,
  McpSearchRequestSchema,
  McpSearchResponse,
} from '@gtm/mcp-shared';

const SID = z.string().length(18).startsWith('bl_tx_')
  .describe('Billing transaction sid (bl_tx_…).');

const BillingTransactionStatusEnum = z.enum(['billed', 'paid', 'completed', 'past_due', 'canceled']);
const BillingTransactionOriginEnum = z.enum(['subscription_charge', 'subscription_update', 'one_time']);
const BillingSubscriptionCollectionModeEnum = z.enum(['automatic', 'manual']); // shared enum, owned by billing_subscriptions

// Loose item / counts / metrics schemas: full field set is tightened by the
// Stage-1 contract tests against live envelopes; passthrough keeps live
// responses valid.
const BillingTransaction = z.object({
  sid: z.string(),
  owner_user_sid: z.string(),
  team_sid: z.string().nullable(),
  subscription_sid: z.string().nullable(),
  paddle_transaction_id: z.string(),
  status: BillingTransactionStatusEnum,
  origin: BillingTransactionOriginEnum,
  collection_mode: BillingSubscriptionCollectionModeEnum,
  invoice_number: z.string().nullable(),
  total: z.string(),
  tax: z.string().nullable(),
  currency: z.string(),
  items: z.array(z.object({
    price_sid: z.string().nullable(),
    product_sid: z.string().nullable(),
    product_type: z.enum(['plan', 'addon']),
    quantity: z.number(),
    unit_amount: z.string(),
    paddle_price_id: z.string().nullable(),
  })),
  billed_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
}).passthrough();

const BillingTransactionCounts = z.object({}).passthrough();
const BillingTransactionMetrics = z.object({}).passthrough();

const BillingTransactionFilter = z.object({
  sid: filterOp(z.string(), ['eq', 'in']).optional(),
  owner_user_sid: filterOp(z.string(), ['eq', 'in']).optional(),
  team_sid: filterOp(z.string(), ['eq', 'in', 'is_null']).optional(),
  subscription_sid: filterOp(z.string(), ['eq', 'in', 'is_null']).optional(),
  paddle_transaction_id: filterOp(z.string(), ['eq', 'in']).optional(),
  invoice_number: filterOp(z.string(), ['eq', 'in', 'is_null']).optional(),
  status: filterOp(BillingTransactionStatusEnum, ['eq', 'ne', 'in', 'nin']).optional(),
  origin: filterOp(BillingTransactionOriginEnum, ['eq', 'ne', 'in', 'nin']).optional(),
  collection_mode: filterOp(BillingSubscriptionCollectionModeEnum, ['eq', 'ne', 'in']).optional(),
  currency: filterOp(z.string(), ['eq', 'in']).optional(),
  billed_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(),
  created_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
}).partial();

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const base = {
  service: 'id',
  entity: 'billing_transactions',
  mount: 'id.billing',
} as const;

// Closed sets taken verbatim from the route rules(): an in: rule answers a 422
// with "invalid", never with the list, so the tool has to carry it.
const BillingTransactionInclude = z.enum(['subscription', 'owner', 'team']);
const BillingTransactionSortable = z.enum(['billed_at', 'created_at', 'total']);

export const billingTransactionsTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_billing_transactions',
    description:
      "List billing transactions (invoices / charges) for the caller: one row per Paddle transaction, newest first. Filter by status / origin / collection_mode / currency / billed_at window, or locate one by invoice_number. include subscription / owner / team to hydrate context. Read-only, append-only ledger; page_size:0 returns counts only. Requires billing.view.",
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/billing-transactions/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    inputSchema: McpSearchRequestSchema(BillingTransactionFilter, BillingTransactionInclude, BillingTransactionSortable),
    outputSchema: McpSearchResponse(BillingTransaction, undefined, BillingTransactionCounts),
    annotations: { title: 'Search billing transactions', ...RO },
  },
  {
    ...base,
    name: 'get_billing_transactions_metrics',
    description:
      "Period-bound money sums over the caller's transactions. Requires period {from,to}. Money never crosses currencies; every sum lives inside a per-currency by_currency entry keyed by ISO 4217. Answers 'how much did I pay / tax this quarter'. Sums are GROSS (refunds not modeled in v1). Filter is the same object as search and every axis is applied; billed_at / created_at operators are dropped from the period-bound sums (period is the one window there) but they DO scope the counts block, which carries no period of its own. Requires billing.view.",
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/billing-transactions/metrics' },
    operation: 'metrics',
    envelope: 'metrics',
    availability: 'ga',
    dangerous: false,
    // BillingTransactionMetricsRequest makes period + period.from + period.to
    // `required`. Without a slot for them the z.object strips whatever the agent
    // sends and the call 422s every single time, for any input.
    inputSchema: McpMetricsRequestSchema(BillingTransactionFilter).extend({
      period: z.object({
        from: z.string().describe('ISO 8601 UTC window start (inclusive).'),
        to: z.string().describe('ISO 8601 UTC window end; must be ≥ from.'),
      }).describe('Required metrics window [from, to].'),
    }),
    outputSchema: McpMetricsResponse(BillingTransactionMetrics),
    annotations: { title: 'Billing transaction metrics', ...RO },
  },
  {
    ...base,
    name: 'get_billing_transaction_invoice',
    description:
      "Fetch a temporary, time-limited download URL for this transaction's invoice PDF from Paddle (never stored on our side; expires ~1h). Works for self-serve card charges and sales-issued manual invoices. Returns invoice_not_ready if the transaction is not yet billed. Read-only, mutates nothing. Requires billing.view.",
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/billing-transactions/{sid}/get-invoice', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: SID, ...usageMetaField }),
    outputSchema: McpActionResponse(BillingTransaction),
    annotations: { title: 'Get transaction invoice', ...RO },
  },
  {
    ...base,
    name: 'get_billing_transaction',
    description: 'Fetch a single billing transaction by sid, with optional subscription / owner / team includes. Returns the frozen items[] charge snapshot inline.',
    toolClass: 'trivial',
    route: { service: 'id', method: 'GET', pathTemplate: '/api/billing-transactions/{sid}', sidParam: 'sid' },
    operation: 'get',
    envelope: 'get',
    availability: 'ga',
    dangerous: false,
    inputSchema: McpGetRequestSchema('bl_tx_'),
    outputSchema: McpGetResponse(BillingTransaction),
    annotations: { title: 'Get billing transaction', ...RO },
  },
];
