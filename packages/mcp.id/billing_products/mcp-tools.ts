// Entity: Billing Product (gtm.service.id)
// Source of truth: product/research/gtm.service.id/entities/billing_products.md
// Format: registry v2. Each tool carries route metadata so the generic
// dispatcher can drive it. 1 tool (the billing-products route group): a
// read-only, Paddle-synced product catalog. The wider billing surface
// (subscriptions / transactions / payment-methods) shares the id.billing mount
// from their own entity files.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  filterOp,
  usageMetaField,
  McpSearchRequestSchema,
  McpSearchResponse,
} from '@gtm/mcp-shared';

const BillingProductTypeEnum = z.enum(['plan', 'addon']);

// Loose item schema: full field set is tightened by the Stage-1
// contract tests against live envelopes; passthrough keeps live responses valid.
const BillingProduct = z.object({
  sid: z.string(),
  paddle_product_id: z.string().nullable(),
  name: z.string(),
  slug: z.string(),
  type: BillingProductTypeEnum,
  limits: z.object({
    accounts: z.number(),
    cloud_browser: z.number(),
    webhooks: z.number(),
  }),
  is_active: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
}).passthrough();

// Counts shape mirrors BillingProductService::counts() (research §counts):
// total_count + groups.type (keyed by BillingProductTypeEnum) + groups.is_active.
const BillingProductCounts = z.object({
  total_count: z.number(),
  groups: z.object({
    type: z.record(z.number()),
    is_active: z.object({ 'true': z.number(), 'false': z.number() }),
  }),
});

const BillingProductFilter = z.object({
  q: z.string().optional().describe('Full-text (LIKE) over name / slug.'),
  sid: filterOp(z.string(), ['eq', 'in']).optional(),
  paddle_product_id: filterOp(z.string(), ['eq', 'in', 'is_null']).optional(),
  slug: filterOp(z.string(), ['eq', 'in']).optional(),
  type: filterOp(BillingProductTypeEnum, ['eq', 'ne', 'in', 'nin']).optional(),
  is_active: filterOp(z.boolean(), ['eq']).optional(),
  created_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  updated_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  deleted_at: filterOp(z.string(), ['is_null', 'gte', 'lte']).optional(),
}).partial();

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const base = {
  service: 'id',
  entity: 'billing_products',
  mount: 'id.billing',
} as const;

// Closed sets taken verbatim from the route rules(): an in: rule answers a 422
// with "invalid", never with the list, so the tool has to carry it.
const BillingProductInclude = z.enum(['prices']);
const BillingProductSortable = z.enum(['updated_at', 'created_at', 'slug']);

export const billingProductsTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_billing_products',
    description:
      'List the Paddle-synced product catalog (the base plan + add-ons) with filtering, sorting and cursor pagination. Filter by type to split plan vs add-on, is_active for the live catalog, or q for an infix match over name/slug. Each row carries the per-unit limits grant. Read-only: the catalog is authored in Paddle, never here. page_size:0 returns counts only.',
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/billing-products/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    inputSchema: McpSearchRequestSchema(BillingProductFilter, BillingProductInclude, BillingProductSortable),
    outputSchema: McpSearchResponse(BillingProduct, undefined, BillingProductCounts),
    annotations: { title: 'Search billing products', ...RO },
  },
];
