// Entity: Email Bounce Log (gtm.service.email)
// Source of truth: product/research/gtm.service.email/entities/email_bounce_log.md
// Format: registry v2. 2 tools (the email-bounce-log route group, read only:
// the classifier writes the rows), mounted on email.deliverability.
//
// As built the metrics route applies one filter to its period numbers, the
// mailbox (filter.email_account_sid.eq); the other filter keys reach
// aggregated.counts alone, and group_by is validated and answers no groups.
// The tool offers what the numbers honour: the period and the mailbox.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import { filterOp, McpSearchResponse } from '@gtm/mcp-shared';
import {
  EmailAccount,
  EmailBounceLog,
  EmailBounceLogKind,
  EmailBounceLogSource,
  EmailMessage,
  EmailMessageBounceType,
  EmailSuppression,
} from '../domains';
import { emailCommon, emailRoute, metricsResponse, oneOf, period, RO, searchInput, sid, str, when } from '../shared';

const EmailBounceLogFilter = z.object({
  sid: str(['eq', 'in']),
  email_account_sid: str(['eq', 'in']),
  email_message_sid: str(['eq', 'in', 'is_null']).describe('{ is_null: true }: events no outbound message was matched to.'),
  kind: oneOf(EmailBounceLogKind, ['eq', 'in']),
  bounce_type: oneOf(EmailMessageBounceType, ['eq', 'in', 'is_null'])
    .describe('hard: the address does not exist. soft: full or temporary. policy: refused as spam, a reputation signal.'),
  source: oneOf(EmailBounceLogSource, ['eq', 'in']),
  recipient: str(['eq', 'in']).describe('Exact address, lowercase.'),
  occurred_at: when(),
}).partial();

const EmailBounceLogIncluded = z.object({
  email_account: EmailAccount.nullable(),
  email_message: EmailMessage.nullable().describe('The outbound message that bounced.'),
  ndr_email_message: EmailMessage.nullable().describe('The bounce report itself.'),
  email_suppression: EmailSuppression.nullable().describe('The stop-list row the event made.'),
}).partial();

const EmailBounceLogCounts = z.object({
  total_count: z.number().int(),
  groups: z.record(z.unknown()),
}).passthrough();

const EmailBounceLogMetrics = z.object({
  total_count: z.number().int().describe('Events in the period.'),
  bounce_count: z.number().int(),
  complaint_count: z.number().int(),
  hard_count: z.number().int(),
  soft_count: z.number().int(),
  policy_count: z.number().int(),
  unmatched_count: z.number().int().describe('Events no outbound message was matched to.'),
  unique_bounced_messages_count: z.number().int().describe('Distinct messages that bounced: sends, not event rows.'),
});

const base = { service: 'email', entity: 'email_bounce_log', mount: 'email.deliverability' } as const;

export const emailBounceLogTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_email_bounce_log',
    description:
      "List bounces and complaints, one row per event: the recipient, kind, bounce_type (hard, soft, policy), the provider's bounce_code and diagnostic, and how it was detected. The history stays after the message or the mailbox is deleted. Use it for why one send bounced (filter email_message_sid), the whole story of one address (recipient eq, include email_message and email_suppression) and what a mailbox is being refused for. Not for whether an address is stopped now (search_email_suppressions), a message's own status (get_email_message) or a mailbox's rates (search_email_account_health). Requires can_view_email_suppressions.",
    toolClass: 'typical',
    route: emailRoute('POST', '/api/email-bounce-log/search'),
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    inputSchema: searchInput(
      EmailBounceLogFilter,
      z.enum(['occurred_at']),
      z.enum(['email_account', 'email_message', 'ndr_email_message', 'email_suppression']),
    ),
    outputSchema: McpSearchResponse(EmailBounceLog, EmailBounceLogIncluded, EmailBounceLogCounts),
    annotations: { title: 'Search email bounce log', ...RO },
  },
  {
    ...base,
    name: 'get_email_bounce_log_metrics',
    description:
      'Bounce and complaint counts over a period, for the whole server or one mailbox: events in total, bounces against complaints, hard, soft and policy bounces, events matched to no message, and the distinct messages that bounced. A growing policy share is reputation damage, hard is list quality, soft is noise. Narrow it to a mailbox with filter.email_account_sid eq; it takes no other filter and no split. period is required. Requires can_view_email_suppressions.',
    toolClass: 'typical',
    route: emailRoute('POST', '/api/email-bounce-log/metrics'),
    operation: 'metrics',
    envelope: 'metrics',
    availability: 'ga',
    dangerous: false,
    inputSchema: z.object({
      filter: z.object({
        email_account_sid: filterOp(sid('em_ac_'), ['eq']).optional().describe('One mailbox.'),
      }).optional(),
      period,
      ...emailCommon,
    }),
    outputSchema: metricsResponse(EmailBounceLogMetrics, EmailBounceLogCounts),
    annotations: { title: 'Email bounce log metrics', ...RO },
  },
];
