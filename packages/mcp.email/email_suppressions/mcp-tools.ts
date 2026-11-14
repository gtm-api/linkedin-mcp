// Entity: Email Suppression (gtm.service.email), "stop-list" in the app
// Source of truth: product/research/gtm.service.email/entities/email_suppressions.md
// Format: registry v2. 4 tools (the email-suppressions route group), mounted on
// email.deliverability.
//
// The stop-list is the workspace's, and every email server holds its own copy:
// an add or a lift on one server is passed to the others by gtm.service.id
// (research, "Fan-out across a workspace's servers"). A row's sid belongs to
// the server that answered, so a lift names the sid a search on the same
// server returned.
//
// create answers two envelopes from one route: the create envelope for one
// address, an action envelope (action "create") for a list. The output schema
// is the union of the two, the route as built.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  McpActionResponse,
  McpCreateResponse,
  McpSearchResponse,
  McpSimpleDeleteResponse,
} from '@gtm/mcp-shared';
import { EmailMessage, EmailSuppression, EmailSuppressionOrigin } from '../domains';
import { emailCommon, emailRoute, metricsResponse, oneOf, period, RO, searchInput, sid, str, when } from '../shared';

const EmailSuppressionFilter = z.object({
  sid: str(['eq', 'in']),
  address: str(['eq', 'in']).describe('Exact address, any case; in: probe a list before a send.'),
  origin: oneOf(EmailSuppressionOrigin),
  created_at: when().describe('When the address was stopped.'),
  deleted_at: when(['is_null', 'gte', 'lte'])
    .describe('Default: the live list. A range reads lifted rows: who re-opened which address, and when.'),
}).partial();

const EmailSuppressionIncluded = z.object({
  source_email_message: EmailMessage.nullable().describe('The message that bounced, was unsubscribed from or complained about.'),
}).partial();

const EmailSuppressionCounts = z.object({
  total_count: z.number().int(),
  groups: z.object({ origin: z.record(z.number()) }).partial().passthrough(),
}).passthrough();

const EmailSuppressionMetrics = z.object({
  added_count: z.number().int().describe('Addresses stopped in the period.'),
  lifted_count: z.number().int().describe('Addresses lifted in the period.'),
});

const base = { service: 'email', entity: 'email_suppressions', mount: 'email.deliverability' } as const;

export const emailSuppressionsTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_email_suppressions',
    description:
      "List the workspace's stop-list: the addresses no mailbox of the team sends to, each with its origin (manual, bounce, unsubscribe, complaint) and reason. Every send checks the list by itself, so use this to see why someone was skipped, to check one address (filter address eq, page_size 1), to probe a list before a send (address in) and to audit lifts (a deleted_at range; deleted_by is who lifted). include source_email_message brings the message behind an automatic row. Not for why an address bounced (search_email_bounce_log). Requires can_view_email_suppressions.",
    toolClass: 'typical',
    route: emailRoute('POST', '/api/email-suppressions/search'),
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    inputSchema: searchInput(
      EmailSuppressionFilter,
      z.enum(['created_at', 'address', 'deleted_at']),
      z.enum(['source_email_message']),
    ),
    outputSchema: McpSearchResponse(EmailSuppression, EmailSuppressionIncluded, EmailSuppressionCounts),
    annotations: { title: 'Search email stop-list', ...RO },
  },
  {
    ...base,
    name: 'create_email_suppression',
    description:
      "Put an address, or up to 1000 of them, on the workspace's stop-list: from the next send on no mailbox of the team writes to it, and mail already queued to it is skipped. Use it for an opt-out the platform cannot see (a reply that says remove me) or to import an old unsubscribe list; bounces, unsubscribe links and complaints stop an address by themselves. Give exactly one of address and addresses. An address already on the list is left as it is: one address answers already_exists, a list answers result.items, created_count and already_suppressed. Requires can_manage_email_suppressions.",
    toolClass: 'typical',
    route: emailRoute('POST', '/api/email-suppressions'),
    operation: 'create',
    envelope: 'create',
    availability: 'ga',
    dangerous: false,
    inputSchema: z.object({
      address: z.string().email().max(320).nullable().optional().describe('One address.'),
      addresses: z.array(z.string().email().max(320)).min(1).max(1000).nullable().optional()
        .describe('1 to 1000 addresses; a repeat inside the list counts once.'),
      reason: z.string().max(512).nullable().optional().describe('A note kept on every row this call makes.'),
      ...emailCommon,
    }),
    outputSchema: z.union([
      McpCreateResponse(EmailSuppression),
      McpActionResponse(z.null(), z.object({
        items: z.array(EmailSuppression).describe('One row per address, new and already there alike.'),
        created_count: z.number().int(),
        already_suppressed: z.array(z.string()).describe('The addresses that were on the list before the call.'),
      })),
    ]),
    annotations: { title: 'Add to email stop-list', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    ...base,
    name: 'delete_email_suppression',
    description:
      "Lift an address off the workspace's stop-list: every mailbox of the team may write to it again, including an address that bounced, unsubscribed or complained. The row stays as history with deleted_by, who lifted it; stopping the address again is a new row. Named by the row's sid, so find it first with search_email_suppressions (filter address eq). Repeating it is safe. Through MCP the first call only previews. Requires can_manage_email_suppressions.",
    toolClass: 'typical',
    route: emailRoute('DELETE', '/api/email-suppressions/{sid}'),
    operation: 'delete',
    envelope: 'delete_simple',
    availability: 'ga',
    dangerous: true,
    inputSchema: z.object({ sid: sid('em_sp_'), ...emailCommon }),
    outputSchema: McpSimpleDeleteResponse,
    annotations: { title: 'Lift from email stop-list', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    ...base,
    name: 'get_email_suppressions_metrics',
    description:
      "The stop-list's size and movement over a period: aggregated.counts is the live list now (total_count, and by origin in groups.origin), aggregated.metrics what happened inside the period (added_count, lifted_count). group_by origin splits both into groups[], one per origin that has a live row or moved in the period; an origin that is absent reads as zero. Use it for whether the list grows from bounces, complaints or opt-outs. period is required. Requires can_view_email_suppressions.",
    toolClass: 'typical',
    route: emailRoute('POST', '/api/email-suppressions/metrics'),
    operation: 'metrics',
    envelope: 'metrics',
    availability: 'ga',
    dangerous: false,
    inputSchema: z.object({
      filter: EmailSuppressionFilter.optional(),
      period,
      group_by: z.enum(['origin']).optional(),
      ...emailCommon,
    }),
    outputSchema: metricsResponse(
      EmailSuppressionMetrics,
      EmailSuppressionCounts,
      z.object({ key: z.string(), counts: EmailSuppressionCounts, metrics: EmailSuppressionMetrics }),
    ),
    annotations: { title: 'Email stop-list metrics', ...RO },
  },
];
