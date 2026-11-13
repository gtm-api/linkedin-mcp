// Entity: Email Engagement (gtm.service.email)
// Source of truth: product/research/gtm.service.email/entities/email_engagements.md
// Format: registry v2. 2 tools (the email-engagements route group, read only:
// the tracking edge writes the rows), mounted on email.deliverability.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import { filterOp, McpSearchResponse } from '@gtm/mcp-shared';
import { EmailEngagement, EmailEngagementKind, EmailMessage } from '../domains';
import { emailCommon, emailRoute, metricsResponse, oneOf, period, RO, searchInput, str, when } from '../shared';

const isBotFiltered = filterOp(z.boolean(), ['eq', 'in']).optional()
  .describe('Default { eq: false }: people only. { in: [true, false] } includes scanners and mail proxies.');

const EmailEngagementFilter = z.object({
  sid: str(['eq', 'in']),
  email_message_sid: str(['eq', 'in']).describe("One message's hits."),
  email_account_sid: str(['eq', 'in']),
  kind: oneOf(EmailEngagementKind, ['eq', 'in', 'nin']),
  is_bot_filtered: isBotFiltered,
  occurred_at: when(),
  deleted_at: when(['is_null', 'gte', 'lte']),
}).partial();

const EmailEngagementIncluded = z.object({
  email_message: EmailMessage.nullable(),
}).partial();

const EmailEngagementCounts = z.object({
  total_count: z.number().int(),
  groups: z.record(z.unknown()),
}).passthrough();

const EmailEngagementMetrics = z.object({
  hits_count: z.number().int().describe('Hits in the period.'),
  unique_messages_count: z.number().int().describe('Distinct messages with at least one hit: reach, not volume.'),
});

const base = { service: 'email', entity: 'email_engagements', mount: 'email.deliverability' } as const;

export const emailEngagementsTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_email_engagements',
    description:
      'List tracking hits on sent mail, one row per open, click or unsubscribe, with the link that was clicked (url) and when. Hits of scanners and mail proxies are left out unless is_bot_filtered is lifted. Use it for every open and click of one message (filter email_message_sid), which links a prospect followed (kind click) and the unsubscribe trail (kind unsubscribe, include email_message). Not for open, click or reply rates (get_email_messages_metrics: hits have no sends to divide by) or whether one message was opened (first_opened_at on the message). Requires can_view_email_engagements.',
    toolClass: 'typical',
    route: emailRoute('POST', '/api/email-engagements/search'),
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    inputSchema: searchInput(EmailEngagementFilter, z.enum(['occurred_at']), z.enum(['email_message'])),
    outputSchema: McpSearchResponse(EmailEngagement, EmailEngagementIncluded, EmailEngagementCounts),
    annotations: { title: 'Search email engagements', ...RO },
  },
  {
    ...base,
    name: 'get_email_engagements_metrics',
    description:
      'Tracking hits over a period: hits_count and unique_messages_count (the messages that were opened, clicked or unsubscribed from). group_by kind splits them per kind; group_by is_bot_filtered, with filter.is_bot_filtered lifted to { in: [true, false] }, shows how much of the volume is scanners. Scanner hits are left out by default. period is required and at most 92 days (422 period_too_wide past that). Requires can_view_email_engagements.',
    toolClass: 'typical',
    route: emailRoute('POST', '/api/email-engagements/metrics'),
    operation: 'metrics',
    envelope: 'metrics',
    availability: 'ga',
    dangerous: false,
    inputSchema: z.object({
      filter: EmailEngagementFilter.omit({ deleted_at: true }).optional(),
      period,
      group_by: z.enum(['kind', 'is_bot_filtered']).optional(),
      ...emailCommon,
    }),
    outputSchema: metricsResponse(
      EmailEngagementMetrics,
      EmailEngagementCounts,
      z.object({ key: z.string(), metrics: EmailEngagementMetrics }),
    ),
    annotations: { title: 'Email engagement metrics', ...RO },
  },
];
