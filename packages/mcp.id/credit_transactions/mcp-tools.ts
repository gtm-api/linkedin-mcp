// Entity: Credit Transaction (gtm.service.id)
// Source of truth: product/research/gtm.service.id/entities/credit_transactions.md
// Format: registry v2. Each tool carries route metadata so the generic
// dispatcher can drive it. 4 tools (the credits.* public surface), mounted on
// id.credits. This is the money-grade movements ledger: history search, spend
// metrics, the balance read, and the async top-up. All ledger WRITES
// (reserve/debit/release/allocation/expiry) are internal, never MCP tools.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  filterOp,
  usageMetaField,
  McpActionResponse,
  McpAsyncActionResponse,
  McpMetricsRequestSchema,
  McpMetricsResponse,
  McpSearchRequestSchema,
  McpSearchResponse,
} from '@gtm/mcp-shared';

// Consumable family. Shared enum OWNED in ./credit_lots.md; MVP single value.
// Mirrors CreditKindEnum: `platform` rows are minted by gs-native operations
// only, never by gtm-side code, but they appear on reads and the agent must
// be able to parse and filter them.
const CreditKind = z.enum(['enrichment', 'platform']);

const CreditTransactionType = z.enum(['allocation', 'debit', 'refund', 'expiry']);
const CreditTransactionStatus = z.enum(['pending', 'confirmed', 'released', 'expired']);

const CreditTransactionSortable = z.enum(['created_at', 'confirmed_at', 'amount']);
const CreditTransactionGroupable = z.enum(['type', 'status', 'operation']);

// Item schema stays passthrough-loose (movement rows carry service-specific
// metadata shapes). counts / metrics / balance are typed to the concrete field
// sets the backend emits (research §search / §metrics / §get-balance), with
// passthrough retained for forward-compat. purchase carries its own result block.
const CreditTransaction = z.object({
  sid: z.string(),
  team_sid: z.string(),
  kind: CreditKind,
  type: CreditTransactionType,
  status: CreditTransactionStatus,
  amount: z.number(),
  operation: z.string().nullable(),
  reference_sid: z.string().nullable(),
  request_id: z.string().nullable(),
  expires_at: z.string().nullable(),
  metadata: z.object({
    account_sid: z.string().nullable(),
    lot_breakdown: z.array(z.object({
      lot_sid: z.string(),
      amount: z.number(),
    })).nullable(),
    purchase: z.boolean().nullable(),
  }).nullable(),
  confirmed_at: z.string().nullable(),
  released_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
}).passthrough();

// counts: the search.counts sibling + metrics.aggregated.counts (§4.17.1,
// groups-first): total_count top-level, per-field row-count breakdowns under
// groups. type/status keyed by their enum values; operation is spend-by-op.
const CreditTransactionCounts = z.object({
  total_count: z.number().int(),
  groups: z.object({
    type: z.record(z.number().int()),
    status: z.record(z.number().int()),
    operation: z.record(z.number().int()),
  }).passthrough(),
}).passthrough();

// metrics leaf: the period-bound aggregate at metrics.aggregated.metrics (§4.17).
// SUM over signed amount by type/status; net_change is signed, the rest are >= 0.
const CreditTransactionMetrics = z.object({
  spent: z.number().int(),
  granted: z.number().int(),
  refunded: z.number().int(),
  expired: z.number().int(),
  net_change: z.number().int(),
  debit_count: z.number().int(),
}).passthrough();

// get-balance result: item is null, the balance rides in result. active_lots are
// CreditLotDomain rows owned by ./credit_lots (kept loose here, not redeclared).
const CreditBalanceResult = z.object({
  kind: CreditKind,
  available: z.number().int(),
  held: z.number().int(),
  lot_total_remaining: z.number().int(),
  active_lots: z.array(z.record(z.unknown())),
  next_expiry: z.object({
    next_expiry_at: z.string().nullable(),
    next_expiry_amount: z.number().int(),
  }),
}).passthrough();

const CreditTransactionFilter = z.object({
  sid: filterOp(z.string(), ['eq', 'in']).optional(),
  kind: filterOp(CreditKind, ['eq', 'in']).optional(),
  type: filterOp(CreditTransactionType, ['eq', 'ne', 'in', 'nin']).optional(),
  status: filterOp(CreditTransactionStatus, ['eq', 'ne', 'in', 'nin']).optional(),
  operation: filterOp(z.string(), ['eq', 'in', 'is_null']).optional()
    .describe('What consumed credits, e.g. "enrich_profile"; is_null:true = allocation/expiry rows.'),
  reference_sid: filterOp(z.string(), ['eq', 'in', 'is_null']).optional()
    .describe('Reverse lookup from an er_… enrich_request or bl_tx_… Paddle tx.'),
  request_id: filterOp(z.string(), ['eq', 'in', 'is_null']).optional()
    .describe('Charge-idempotency key lookup.'),
  created_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  confirmed_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(),
}).partial();

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const DANGER = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

const base = {
  service: 'id',
  entity: 'credit_transactions',
  mount: 'id.credits',
} as const;

export const creditTransactionsTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_credit_transactions',
    description:
      'Credit movements history (every grant, debit, refund, expiry), filterable by type, status, operation, reference_sid, time window. Use for "what did I spend on", "show my last debits", "which movement burned lot X". For the current balance use get_credit_balance instead. Returns a counts block. page_size:0 returns counts only.',
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/credit-transactions/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: McpSearchRequestSchema(CreditTransactionFilter, undefined, CreditTransactionSortable)
      // The SearchRequest declares no include rule and the controller builds no
      // included block, so advertising the param would be a silent no-op.
      .omit({ include: true }),
    outputSchema: McpSearchResponse(CreditTransaction, undefined, CreditTransactionCounts),
    annotations: { title: 'Search credit transactions', ...RO },
  },
  {
    ...base,
    name: 'get_credit_transactions_metrics',
    description:
      'Credit spend/grant metrics over a period (period column = created_at, half-open [from,to)). Returns spent, granted, refunded, expired, net_change and debit_count. filter is the same object as search and every axis is applied. The time axes are the exception worth knowing: created_at / confirmed_at operators are dropped from the period-bound metrics (period is the one window there) but they DO scope the counts block, which carries no period of its own. Optional single group_by (type / status / operation).',
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/credit-transactions/metrics' },
    operation: 'metrics',
    envelope: 'metrics',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: McpMetricsRequestSchema(CreditTransactionFilter).extend({
      period: z.object({
        from: z.string().describe('ISO 8601 UTC window start (inclusive).'),
        to: z.string().describe('ISO 8601 UTC window end (exclusive); must be ≥ from.'),
      }).describe('Required metrics window [from, to).'),
      group_by: CreditTransactionGroupable.optional().describe('Optional single split axis.'),
    }),
    outputSchema: McpMetricsResponse(CreditTransactionMetrics),
    annotations: { title: 'Credit transactions metrics', ...RO },
  },
  {
    ...base,
    name: 'get_credit_balance',
    description:
      "The single public read of a team's spendable credit balance for a kind. Assembles available (active non-expired lot remaining minus active pending holds), the active lots list (soonest-expiring first) and next_expiry. Read-only assembly; item is null, the balance is in result.",
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/credit-transactions/get-balance' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      kind: CreditKind.describe('Consumable family. gtm mints "enrichment"; "platform" rows come from gs-native operations.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), CreditBalanceResult),
    annotations: { title: 'Get credit balance', ...RO },
  },
  {
    ...base,
    name: 'purchase_credits',
    description:
      'Top up credits. Creates a Paddle one-time transaction and returns a checkout_url for the human to pay; the credits land AFTER transaction.completed (ASYNC: poll get_credit_balance or await the webhook). CREDITABLE + DESTRUCTIVE: charges the owner\'s card / opens Paddle checkout; the real gate is the human confirming the amount in the Paddle overlay. On retry the agent MUST reuse the SAME request_id; a fresh key creates a second charge.',
    toolClass: 'complex',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/credit-transactions/purchase' },
    operation: 'action',
    envelope: 'action_async',
    availability: 'ga',
    dangerous: true,
    creditable: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      kind: CreditKind.describe('Consumable family. gtm mints "enrichment"; "platform" rows come from gs-native operations.'),
      amount: z.number().int().min(1).describe('Credits to buy.'),
      request_id: z.string().max(64)
        .describe('Idempotency key; MUST be stable across retries. A new key = a second charge.'),
      ...usageMetaField,
    }),
    outputSchema: McpAsyncActionResponse(CreditTransaction),
    annotations: { title: 'Purchase credits', ...DANGER },
  },
];
