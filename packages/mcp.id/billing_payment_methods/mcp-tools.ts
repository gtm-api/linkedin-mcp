// Entity: Billing Payment Method (gtm.service.id), VIRTUAL (no local table)
// Source of truth: product/research/gtm.service.id/entities/billing_payment_methods.md
// Format: registry v2. Each tool carries route metadata so the generic
// dispatcher can drive it. 3 tools (the billing-payment-methods route group):
// a thin live proxy over the Paddle Billing API. `list` is a collection GET
// (no /search, no {sid}) modeled as a read action; `get-add-link` mints a
// Paddle portal deep link; `delete` proxies a Paddle DELETE. The {sid} on
// delete is a RAW Paddle id (paymtd_…), NOT an 18-char platform sid; route
// validation matches ^paymtd_. Card data never enters our service (PCI); money
// moves via Paddle.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  usageMetaField,
  McpActionResponse,
  McpSearchResponse,
  McpSimpleDeleteResponse,
} from '@gtm/mcp-shared';

// Raw Paddle payment-method id, echoed verbatim as the sid; no 18-char length
// check (see research Domain storage notes; route is constrained where sid ^paymtd_).
const PAYMENT_METHOD_SID = z.string().startsWith('paymtd_')
  .describe('Paddle payment-method id (paymtd_…): a raw Paddle id, not an 18-char platform sid.');

// Loose item schema: brand / last4 / expiry only (PCI); tightened by the
// Stage-1 contract tests against live Paddle-proxied envelopes.
const BillingPaymentMethod = z.object({
  sid: z.string(),
  type: z.enum(['card', 'paypal', 'apple_pay', 'google_pay', 'other']),
  card_brand: z.string().nullable(),
  card_last4: z.string().nullable(),
  card_expiry: z.string().nullable(),
  is_default: z.boolean(),
  origin: z.string().nullable(),
  saved_at: z.string().nullable(),
}).passthrough();

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const DANGER = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

const base = {
  service: 'id',
  entity: 'billing_payment_methods',
  mount: 'id.billing',
} as const;

export const billingPaymentMethodsTools: ToolDefinition[] = [
  {
    ...base,
    name: 'list_billing_payment_methods',
    description:
      "List the saved cards / PayPal / wallets for the active workspace's paying user (proxied live from Paddle). The list is re-sorted so the billing card is items[0]; is_default:true is the card that last billed the workspace, so answer 'which card am I paying with' by reading it. Cards may be listed even with no applied subscription; empty if the user has no Paddle customer. Brand + last4 + expiry only (PCI). Requires billing.view.",
    toolClass: 'typical',
    route: { service: 'id', method: 'GET', pathTemplate: '/api/billing-payment-methods' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    inputSchema: z.object({ ...usageMetaField }),
    outputSchema: McpSearchResponse(BillingPaymentMethod),
    annotations: { title: 'List payment methods', ...RO },
  },
  {
    ...base,
    name: 'get_billing_payment_method_add_link',
    description:
      "Return a temporary Paddle Customer Portal deep link to add or replace a card for the workspace's applied subscription. This is the ONLY way to add a card: Paddle has no add-card API; the user enters card details on Paddle's hosted page. Never cached. Returns no_billing_account if the workspace has no applied subscription. Requires billing.manage.",
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/billing-payment-methods/get-add-link' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ ...usageMetaField }),
    outputSchema: McpActionResponse(z.null(), z.object({ add_link: z.string().nullable(), expires_at: z.string(), subscription_sid: z.string() })),
    annotations: { title: 'Get add-card link', ...RO },
  },
  {
    ...base,
    name: 'delete_billing_payment_method',
    description:
      "Remove a saved payment method from the workspace's paying user's Paddle customer (proxies Paddle DELETE; no local row, no cascade). DANGEROUS. Search first and, if the method is is_default:true (the billing card), confirm with the user before deleting: it leaves the subscription card-less. Deleting an already-removed method is idempotent success. sid is a raw Paddle paymtd_ id. Requires billing.manage.",
    toolClass: 'typical',
    route: { service: 'id', method: 'DELETE', pathTemplate: '/api/billing-payment-methods/{sid}', sidParam: 'sid' },
    operation: 'delete',
    envelope: 'delete_simple',
    availability: 'ga',
    dangerous: true,
    inputSchema: z.object({ sid: PAYMENT_METHOD_SID, ...usageMetaField }),
    outputSchema: McpSimpleDeleteResponse,
    annotations: { title: 'Delete payment method', ...DANGER },
  },
];
