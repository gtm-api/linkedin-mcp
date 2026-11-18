// Entity: Email Thread (gtm.service.email)
// Source of truth: product/research/gtm.service.email/entities/email_threads.md
// Format: registry v2. 4 tools (the email-threads route group: a thread is an
// aggregate the sync maintains, so no get, create, update or delete; one row by
// sid is search with filter.sid). Mounted on email.messaging.
//
// As built the metrics route computes its period numbers over the window alone:
// the filter reaches aggregated.counts only, group_by is validated and answers
// no groups, and avg_first_reply_seconds is always null. The tool offers the
// period and nothing else.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import { filterOp, McpActionResponse, McpSearchResponse } from '@gtm/mcp-shared';
import { EmailAccount, EmailMessage, EmailParticipant, EmailThread } from '../domains';
import { emailCommon, emailRoute, metricsResponse, period, RO, RO_OPEN, searchInput, sid, str, when } from '../shared';

const EmailThreadFilter = z.object({
  q: z.string().max(128).optional().describe('Words of the subject.'),
  sid: str(['eq', 'in']).describe('One thread by sid: there is no get.'),
  email_account_sid: str(['eq', 'in']),
  participant_email: str(['eq', 'in']).describe('An address anywhere in the thread (from, to, cc).'),
  has_unanswered_inbound: filterOp(z.boolean(), ['eq']).optional()
    .describe('{ eq: true }: the newest message is inbound, the reply is owed by us.'),
  unread_count: filterOp(z.number().int().nonnegative(), ['gt']).optional().describe('{ gt: 0 }: threads holding unread mail.'),
  last_message_at: when(),
  last_inbound_at: when(['gte', 'lte', 'gt', 'lt', 'is_null']),
  last_outbound_at: when(['gte', 'lte', 'gt', 'lt', 'is_null'])
    .describe('Follow-ups: lte a cutoff, with has_unanswered_inbound false.'),
  created_at: when(),
  updated_at: when(),
  deleted_at: when(['is_null', 'gte', 'lte']),
}).partial();

const EmailThreadIncluded = z.object({
  email_account: EmailAccount.nullable(),
  last_messages: z.array(EmailMessage).describe('The newest five messages, newest first, without bodies.'),
}).partial();

const EmailThreadCounts = z.object({
  total_count: z.number().int(),
  unread_threads_count: z.number().int().optional(),
  groups: z.record(z.unknown())
    .describe('Threads by has_unanswered_inbound (true, false); by email_account_sid too when the filter names mailboxes (eq or in).'),
}).passthrough();

const EmailThreadMetrics = z.object({
  threads_count: z.number().int().describe('Threads whose newest message falls in the period.'),
  replied_threads_count: z.number().int().describe('Of those, threads that hold mail both ways.'),
  avg_first_reply_seconds: z.number().nullable().describe('Not computed yet: always null.'),
});

const base = { service: 'email', entity: 'email_threads', mount: 'email.messaging' } as const;

export const emailThreadsTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_email_threads',
    description:
      "List conversations across the team's mailboxes, newest activity first: participants, message and unread counts, when mail last came in and went out, and has_unanswered_inbound (the newest message is theirs, the reply is ours to write). Use it for inbox triage (has_unanswered_inbound eq true, or unread_count gt 0), every thread with one person (participant_email), and follow-up picks (last_outbound_at lte a cutoff). include last_messages brings the newest five messages of each thread. To read a whole conversation use get_email_thread_llm_context; single messages are search_email_messages. Requires can_view_email_messages.",
    toolClass: 'typical',
    route: emailRoute('POST', '/api/email-threads/search'),
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    inputSchema: searchInput(
      EmailThreadFilter,
      z.enum(['last_message_at', 'last_inbound_at', 'last_outbound_at', 'unread_count', 'created_at']),
      z.enum(['email_account', 'last_messages']),
    ),
    outputSchema: McpSearchResponse(EmailThread, EmailThreadIncluded, EmailThreadCounts),
    annotations: { title: 'Search email threads', ...RO },
  },
  {
    ...base,
    name: 'get_email_threads_metrics',
    description:
      'Conversation counts over a period: threads_count (threads whose newest message falls in the period) and replied_threads_count (those that hold mail both ways); avg_first_reply_seconds is not computed yet and reads null. aggregated.counts is every live thread, not the period. It covers the whole server: it takes no filter and no split. period is required. Requires can_view_email_messages.',
    toolClass: 'typical',
    route: emailRoute('POST', '/api/email-threads/metrics'),
    operation: 'metrics',
    envelope: 'metrics',
    availability: 'ga',
    dangerous: false,
    inputSchema: z.object({ period, ...emailCommon }),
    outputSchema: metricsResponse(EmailThreadMetrics, EmailThreadCounts),
    annotations: { title: 'Email thread metrics', ...RO },
  },
  {
    ...base,
    name: 'get_email_thread_llm_context',
    description:
      'Read a whole conversation as one plain-text transcript, oldest first, one line per message ("[date] from → to: text"), cut to a token budget: the oldest messages drop first and one line says how many were left out; the newest message always stays. Quoted history and signatures are stripped unless include_quoted_text is true. result.last_message_sid is the message to answer: pass it to send_email_message as reply_to_email_message_sid. Bodies not mirrored yet are fetched from the provider in the call, so the first read of an old thread can take seconds; 503 body_fetch_failed is safe to repeat. Bounce reports are left out. Requires can_view_email_messages.',
    toolClass: 'complex',
    route: emailRoute('POST', '/api/email-threads/{sid}/get-llm-context'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: sid('em_th_'),
      max_tokens: z.number().int().min(500).max(50000).nullable().optional().describe('The transcript budget, 500 to 50000; default 4000.'),
      include_quoted_text: z.boolean().nullable().optional().describe('true: full bodies, quoted history included. Default false.'),
      ...emailCommon,
    }),
    outputSchema: McpActionResponse(z.null(), z.object({
      transcript: z.string(),
      messages_included: z.number().int(),
      messages_omitted: z.number().int().describe('Dropped by the budget.'),
      participants: z.array(EmailParticipant),
      has_unanswered_inbound: z.boolean(),
      last_message_sid: z.string().nullable().describe('The newest message of the transcript.'),
    })),
    annotations: { title: 'Get email thread transcript', ...RO_OPEN },
  },
  {
    ...base,
    name: 'mark_email_thread_read',
    description:
      'Mark every message of a conversation read, in the mailbox at its provider too, in one call: the way to settle a thread after it was handled. item is the thread after the change (unread_count 0), result.updated_messages_count how many messages turned. If the provider refuses part way, the messages already turned stay read, so repeating finishes the job. One message alone is update_email_message. Requires can_act_email_messages.',
    toolClass: 'typical',
    route: emailRoute('POST', '/api/email-threads/{sid}/mark-as-read'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: sid('em_th_'), ...emailCommon }),
    outputSchema: McpActionResponse(EmailThread, z.object({ updated_messages_count: z.number().int() })),
    annotations: { title: 'Mark email thread read', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
];
