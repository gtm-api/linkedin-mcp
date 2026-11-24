// Entity: Email Message (gtm.service.email)
// Source of truth: product/research/gtm.service.email/entities/email_messages.md
// Format: registry v2. 12 tools (the email-messages route group), mounted on
// email.messaging.
//
// As built, and narrower than the research in four places the tools follow:
//   - search builds one include, email_thread; get builds none and always
//     answers the stored headers, so it takes sid and sanitize and nothing else;
//   - metrics computes its period numbers over the window alone: the filter
//     reaches aggregated.counts only, group_by is validated and answers no
//     groups, and the reply numbers are not computed (0 and null);
//   - include_bodies has no page-size guard on the server: the tool's
//     description asks for a small page instead of promising a refusal;
//   - get-attachment answers the download flat in result and refuses an IMAP
//     mailbox (503 attachment_fetch_failed).
//
// send is the one outward verb of the service: the preview gate holds it
// (dangerous), and a send this worker's fuse cut is in doubt, never failed, so
// it names the tool that answers what it came to (sentCheck).

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import { filterOp, McpActionResponse, McpCascadeDeleteResponse, McpGetResponse, McpSearchResponse, McpUpdateResponse } from '@gtm/mcp-shared';
import {
  EmailAccountActivityLog,
  EmailFolderRole,
  EmailMessage,
  EmailMessageDirection,
  EmailMessageKind,
  EmailMessageStatus,
  EmailThread,
  RowError,
} from '../domains';
import { emailCommon, emailRoute, metricsResponse, oneOf, period, RO, RO_OPEN, searchInput, sid, str, when } from '../shared';

const flag = () => filterOp(z.boolean(), ['eq']).optional();

const EmailMessageFilter = z.object({
  q: z.string().max(128).optional()
    .describe('Words of the subject or the snippet: every word must be there, as a word or the start of one, in any order. Bodies and mail older than the mirror: search_email_account_provider.'),
  sid: str(['eq', 'in']),
  email_account_sid: str(['eq', 'in']).describe('One mailbox; absent, the search runs across the mailboxes of the server.'),
  email_thread_sid: str(['eq', 'in']).describe('Every message of a conversation.'),
  internet_message_id: str(['eq', 'in']),
  client_reference: str(['eq', 'in', 'is_null']),
  direction: oneOf(EmailMessageDirection, ['eq']),
  status: oneOf(EmailMessageStatus).describe('{ eq: "scheduled" }: the send queue. bounced over a window: list hygiene.'),
  kind: oneOf(EmailMessageKind, ['eq', 'in', 'nin']).describe('Absent: bounce reports are left out.'),
  from_email: str(['eq', 'in']).describe('Lowercase, exact.'),
  to_email: str(['eq', 'in']),
  participant_email: str(['eq', 'in']).describe('In from, to or cc.'),
  folder_role: oneOf(EmailFolderRole, ['eq', 'in', 'nin']),
  email_folder_sids: z.object({ contains: sid('em_fd_') }).strict().optional()
    .describe('{ contains: sid }: messages in that folder or under that label.'),
  is_read: flag(),
  is_flagged: flag(),
  is_answered: flag().describe('{ eq: false } with direction inbound: mail nobody answered.'),
  has_attachments: flag(),
  first_opened_at: when(['gte', 'lte', 'is_null']),
  sent_at: when().describe('The main time window: when it was sent or received.'),
  scheduled_at: when(['gte', 'lte', 'is_null']),
  created_at: when(),
  updated_at: when(),
  deleted_at: when(['is_null', 'gte', 'lte']).describe('Absent: live rows only.'),
}).partial();

const EmailMessageIncluded = z.object({ email_thread: EmailThread.nullable() }).partial();

const EmailMessageCounts = z.object({
  total_count: z.number().int(),
  unread_count: z.number().int().optional().describe('Unread inbound rows of the filter.'),
  groups: z.record(z.unknown())
    .describe('Rows by direction, status, folder_role, is_read (true, false) and kind, the largest value first; by email_account_sid too when the filter names mailboxes (eq or in).'),
}).passthrough();

const EmailMessageMetrics = z.object({
  sent_count: z.number().int().describe('Outbound that left: sent or bounced.'),
  received_count: z.number().int().describe('Inbound, bounce reports left out.'),
  bounced_count: z.number().int(),
  bounce_rate: z.number().nullable().describe('bounced over sent; null when nothing was sent.'),
  tracked_opens_count: z.number().int(),
  open_rate: z.number().nullable().describe('Opened over the sends that carried open tracking.'),
  tracked_clicks_count: z.number().int(),
  click_rate: z.number().nullable().describe('Clicked over the sends that carried click tracking.'),
  replied_count: z.number().int().describe('Not computed here: always 0. Replies are counted per thread.'),
  reply_rate: z.number().nullable().describe('Not computed: always null.'),
  avg_first_reply_seconds: z.number().nullable().describe('Not computed: always null.'),
});

const Recipient = z.object({
  email: z.string().email().max(320),
  display_name: z.string().max(255).nullable().optional(),
});
const Address = z.object({ email: z.string().email().max(320) });

const OutboundAttachment = z.object({
  name: z.string().max(255).nullable().optional().describe('File name; required with content_base64.'),
  content_base64: z.string().nullable().optional().describe('The file, base64. Small files only.'),
  email_message_sid: sid('em_ms_').nullable().optional()
    .describe('Instead of bytes: the stored message that holds the attachment, with attachment_id.'),
  attachment_id: z.string().max(255).nullable().optional().describe('attachments[].id of that message.'),
});

const SendResult = z.object({
  activity_log: z.union([EmailAccountActivityLog, z.object({}).passthrough()])
    .describe('The send attempt (or the enqueue row). Its sid names the attempt in check_email_message_sent and in confirmed_not_sent.'),
  suppressed_recipients: z.array(z.string()).describe('Addresses on the stop-list, left out of this send.'),
  idempotent_replay: z.boolean().describe('true: an earlier send of this message answers the call; nothing was sent now.'),
  content_differs: z.boolean().optional().describe('On a replay: this call said something else than the send that answers it.'),
});

const SendPending = z.object({
  activity_log: z.union([EmailAccountActivityLog, z.object({}).passthrough()]),
  expected_completion_seconds: z.number().int(),
  webhook_events: z.array(z.string()),
  polling_hint: z.string(),
}).passthrough();

const SentOutcome = z.object({
  // A plain string: the backend's EmailSendOutcome is a class of constants, not an enum.
  outcome: z.string()
    .describe('sent: it left. not_sent: proof that nothing left, safe to send again. in_flight: on its way. unknown: nobody can tell yet.'),
  reason: z.string().nullable().describe('Why, e.g. found_in_mailbox, refused, not_in_sent_folder, queued, settling, no_send_under_key.'),
  retry_after: z.string().optional().describe('ISO 8601: when to ask again. Absent on a final answer.'),
  activity_log_sid: z.string().optional().describe('The attempt the answer is about.'),
  waiting_for: z.string().optional().describe('What an unknown waits for; person: only a human can settle it.'),
}).passthrough();

const SEND_CHECK = { tool: 'check_email_message_sent', accountKey: 'email_account_sid', activityLogTool: 'search_email_account_activity_log' } as const;

const WRITE_OPEN = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const base = { service: 'email', entity: 'email_messages', mount: 'email.messaging' } as const;

export const emailMessagesTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_email_messages',
    description:
      "List single messages across the team's mailboxes, newest first: who wrote to whom, subject, snippet, status, folder, read and flag state, opens and clicks. Filter by mailbox, thread, direction, status, participants, folder and time; q matches words of the subject and the snippet. Rows come without bodies unless include_bodies is true, which carries the bodies already mirrored (it fetches nothing): keep such a page to 20 rows or fewer. status eq scheduled is the send queue. Trashed rows and bounce reports are left out unless deleted_at or kind is filtered. For one message with its body use get_email_message; for a whole conversation get_email_thread_llm_context. page_size 0 answers counts alone; counts.groups splits by mailbox only when the filter names mailboxes. Requires can_view_email_messages.",
    toolClass: 'typical',
    route: emailRoute('POST', '/api/email-messages/search'),
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    inputSchema: searchInput(
      EmailMessageFilter,
      z.enum(['sent_at', 'scheduled_at', 'first_opened_at', 'created_at', 'updated_at']),
      z.enum(['email_thread']),
    ).extend({
      include_bodies: z.boolean().nullable().optional().describe('true: body_html and body_text on rows whose body is mirrored. Default false.'),
    }),
    outputSchema: McpSearchResponse(EmailMessage, EmailMessageIncluded, EmailMessageCounts),
    annotations: { title: 'Search email messages', ...RO },
  },
  {
    ...base,
    name: 'get_email_message',
    description:
      'Read one message in full: body_html and body_text as stored, the headers, attachments as metadata. A body not mirrored yet is fetched from the mailbox provider inside the call, so the first read can take seconds; 503 body_fetch_failed is safe to repeat. sanitize true adds body_html_sanitized (HTML safe to render, the quoted history marked) and body_text_unquoted (the text above the first quote), which is what to read when answering. The bytes of an attachment come from get_email_message_attachment. Requires can_view_email_messages.',
    toolClass: 'typical',
    route: { ...emailRoute('GET', '/api/email-messages/{sid}'), queryParams: ['sanitize'] },
    operation: 'get',
    envelope: 'get',
    availability: 'ga',
    dangerous: false,
    inputSchema: z.object({
      sid: sid('em_ms_'),
      sanitize: z.boolean().optional().describe('true: also fill body_html_sanitized and body_text_unquoted. Default false.'),
      ...emailCommon,
    }),
    outputSchema: McpGetResponse(EmailMessage),
    annotations: { title: 'Get email message', ...RO_OPEN },
  },
  {
    ...base,
    name: 'update_email_message',
    description:
      "Change a message's read state, flag, folders or your own key, in the mailbox at its provider too: the provider is written first and the row follows only when it accepted (503 provider_update_failed leaves the row as it was). email_folder_sids is the full membership wanted: several labels on Gmail, exactly one folder on Microsoft and IMAP. A scheduled message takes client_reference only. The client_reference of an outbound message that was sent or tried is frozen (409 client_reference_frozen), since a repeat of the send is found by it. To take a message out of the inbox use archive_email_message; a whole thread read at once is mark_email_thread_read. Requires can_act_email_messages.",
    toolClass: 'typical',
    route: emailRoute('PATCH', '/api/email-messages/{sid}'),
    operation: 'update',
    envelope: 'update',
    availability: 'ga',
    dangerous: false,
    inputSchema: z.object({
      sid: sid('em_ms_'),
      is_read: z.boolean().optional(),
      is_flagged: z.boolean().optional().describe('Starred on Gmail, flagged on Microsoft and IMAP.'),
      email_folder_sids: z.array(sid('em_fd_')).optional().describe('The full membership wanted, from search_email_folders of the same mailbox.'),
      client_reference: z.string().max(255).nullable().optional().describe('Your own key of the message; null clears it.'),
      ...emailCommon,
    }),
    outputSchema: McpUpdateResponse(EmailMessage),
    annotations: { title: 'Update email message', ...WRITE_OPEN },
  },
  {
    ...base,
    name: 'delete_email_message',
    description:
      "Delete a message. A scheduled one is cancelled before it leaves: nothing is sent. Any other moves to the mailbox's Trash at its provider and leaves the mirror. A message being sent right now answers 409 dispatch_in_flight, and a scheduled one whose attempt may already have left answers 409 send_outcome_unknown naming the attempt: ask check_email_message_sent_by_sid first. If the provider refuses the Trash move (503), nothing changes. Repeating answers already_deleted true. Requires can_act_email_messages.",
    toolClass: 'typical',
    route: emailRoute('DELETE', '/api/email-messages/{sid}'),
    operation: 'delete',
    envelope: 'delete_cascade',
    availability: 'ga',
    dangerous: true,
    inputSchema: z.object({ sid: sid('em_ms_'), ...emailCommon }),
    outputSchema: McpCascadeDeleteResponse,
    annotations: { title: 'Delete email message', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  {
    ...base,
    name: 'get_email_messages_metrics',
    description:
      'The deliverability funnel of a period, by when mail was sent or received: sent_count, received_count, bounced_count and bounce_rate, tracked opens and clicks with their rates over the sends that carried tracking. Reply numbers are not computed here (replied_count 0, the rates null): replies are counted per thread, get_email_threads_metrics. aggregated.counts is every live message, not the period. It covers the whole server: it takes no filter and no split; one mailbox by day is get_email_accounts_daily_sends. period is required. Requires can_view_email_messages.',
    toolClass: 'typical',
    route: emailRoute('POST', '/api/email-messages/metrics'),
    operation: 'metrics',
    envelope: 'metrics',
    availability: 'ga',
    dangerous: false,
    inputSchema: z.object({ period, ...emailCommon }),
    outputSchema: metricsResponse(EmailMessageMetrics, EmailMessageCounts),
    annotations: { title: 'Email message metrics', ...RO },
  },
  {
    ...base,
    name: 'send_email_message',
    description:
      'Send an email from a connected mailbox: a new message (to, subject and one of body_html or body_text), a reply (reply_to_email_message_sid: subject, threading and the recipient come from the original) or a forward (forward_email_message_sid). Without scheduled_at it goes out now and item is the sent message; a refusal is a 409 whose context.reason and context.send_outcome say what happened. With scheduled_at it is queued (async true) and leaves under the mailbox\'s daily limit, window and warmup. Recipients on the stop-list are left out and listed in result.suppressed_recipients; all of them stopped is 409 recipient_suppressed. Always pass client_reference: a repeat under the same key and recipients is answered by the first send, never sent twice. On a timeout or 409 send_outcome_unknown do not send again: ask check_email_message_sent. Requires can_act_email_messages.',
    toolClass: 'complex',
    route: emailRoute('POST', '/api/email-messages/send'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    sentCheck: SEND_CHECK,
    massAction: false,
    stepEligible: true,
    scheduleRequired: true,
    inputSchema: z.object({
      email_account_sid: sid('em_ac_').describe('The mailbox that sends; it must be active and not paused.'),
      reply_to_email_message_sid: sid('em_ms_').nullable().optional()
        .describe('Reply to this message of the same mailbox: subject, In-Reply-To and the thread are set for you, and to defaults to its sender.'),
      forward_email_message_sid: sid('em_ms_').nullable().optional()
        .describe('Forward this message of the same mailbox: the quoted original goes under your body; to is required. Never with reply_to_email_message_sid.'),
      include_original_attachments: z.boolean().nullable().optional().describe('With a forward: carry its attachments. Default true.'),
      to: z.array(Recipient).max(50).nullable().optional().describe('Required unless it is a reply. At most 50 recipients across to, cc and bcc.'),
      cc: z.array(Address).max(50).nullable().optional(),
      bcc: z.array(Address).max(50).nullable().optional(),
      from_email: z.string().email().max(320).nullable().optional()
        .describe("The mailbox's address or one of its aliases; anything else is 409 send_as_denied. Default: the address."),
      subject: z.string().max(1023).nullable().optional().describe('Required unless it is a reply or a forward.'),
      body_html: z.string().nullable().optional().describe('Exactly one of body_html and body_text.'),
      body_text: z.string().nullable().optional(),
      attachments: z.array(OutboundAttachment).nullable().optional().describe('Bytes, or a stored attachment by reference. 20 MB in total.'),
      include_signature: z.boolean().nullable().optional()
        .describe('Deprecated and ignored: no signature is added to any mail. Accepted so a call that still sends it is not refused. Write the signature into body_html.'),
      scheduled_at: z.string().nullable().optional()
        .describe('ISO 8601 UTC, in the future: queue it for then. Absent: send now. A past time is refused.'),
      client_reference: z.string().max(255).nullable().optional()
        .describe('Your key of this message, echoed in every webhook about it. With the recipients it is one message: sent once.'),
      idempotency_key: z.string().max(255).nullable().optional()
        .describe('Dedup key for 24 hours: a repeat is answered by the earlier send; the same key with another payload is 409 idempotency_key_reused.'),
      confirmed_not_sent: sid('em_al_').nullable().optional()
        .describe("A person's word that the attempt named here (activity_log_sid of a send in doubt) never arrived: the message goes out again."),
      confirmed_sent: sid('em_al_').nullable().optional()
        .describe("A person's word that the attempt named here arrived: it is settled sent and nothing is sent. Never with confirmed_not_sent."),
      override_suppression: z.boolean().nullable().optional()
        .describe('Send to addresses on the stop-list anyway. Requires can_manage_email_suppressions; each one is audited.'),
      require_to: z.boolean().nullable().optional()
        .describe('true: when every address in to is on the stop-list, refuse the whole send (409 recipient_suppressed) and send nothing to the cc and bcc that remain. Default false: it goes to them. Never with scheduled_at (422).'),
      track_opens: z.boolean().nullable().optional().describe("Default: the mailbox's setting. true needs a verified tracking domain."),
      track_clicks: z.boolean().nullable().optional(),
      custom_headers: z.array(z.object({
        name: z.string().max(255),
        value: z.string().max(2048),
      })).nullable().optional().describe('X-* headers, List-Unsubscribe or Reply-To; any other name is refused.'),
      ...emailCommon,
    }),
    outputSchema: McpActionResponse(EmailMessage, SendResult).extend({
      async: z.literal(true).optional().describe('Present when the message was queued (scheduled_at).'),
      pending: z.array(SendPending).optional().describe('Queued only: what to wait for.'),
    }),
    annotations: { title: 'Send email message', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    ...base,
    name: 'check_email_message_sent',
    description:
      'Ask what a send came to without sending anything: sent, not_sent, in_flight or unknown, with the reason and, while the answer may still change, retry_after. Ask by the client_reference the send carried (add to, cc and bcc when one key was used for several recipient sets, else 422 place_required), or by the activity_log_sid an earlier answer named. A send in doubt is looked for in the mailbox during the call, and one found there turns its message sent. Use it after a send timed out or answered 409 send_outcome_unknown or dispatch_in_flight; send again only on not_sent, under the same key. item is the message when a row exists. Requires can_act_email_messages.',
    toolClass: 'typical',
    route: emailRoute('POST', '/api/email-messages/check-sent'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      email_account_sid: sid('em_ac_').describe('The mailbox the send ran on.'),
      client_reference: z.string().max(255).nullable().optional().describe('The key of the send. Exactly one of client_reference and activity_log_sid.'),
      activity_log_sid: sid('em_al_').nullable().optional().describe('The attempt an earlier answer named. Never with to, cc or bcc.'),
      to: z.array(z.string().email().max(320)).max(50).nullable().optional().describe('The recipient set the send named, to tell apart sends under one key.'),
      cc: z.array(z.string().email().max(320)).max(50).nullable().optional(),
      bcc: z.array(z.string().email().max(320)).max(50).nullable().optional(),
      ...emailCommon,
    }),
    outputSchema: McpActionResponse(EmailMessage, SentOutcome),
    annotations: { title: 'Check email message sent', ...WRITE_OPEN },
  },
  {
    ...base,
    name: 'check_email_message_sent_by_sid',
    description:
      'Ask what became of one outbound message you hold the sid of, a failed or deleted one included: sent, not_sent, in_flight or unknown, with the reason and retry_after. A failed message whose provider may have taken the mail is looked for in the mailbox during the call, and one found there turns sent. Use it before sending a failed message again, so mail that did arrive is not sent twice; without a sid, ask by the key with check_email_message_sent. Requires can_act_email_messages.',
    toolClass: 'typical',
    route: emailRoute('POST', '/api/email-messages/{sid}/check-sent'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: sid('em_ms_'), ...emailCommon }),
    outputSchema: McpActionResponse(EmailMessage, SentOutcome),
    annotations: { title: 'Check email message sent by sid', ...WRITE_OPEN },
  },
  {
    ...base,
    name: 'archive_email_message',
    description:
      "Take a message out of the inbox the way its provider does it: Gmail drops the Inbox label and keeps the others, Microsoft and IMAP move it to the archive folder. Nothing is deleted. result carries the folders after the move. Archiving twice changes nothing. A scheduled message is in no folder yet (422); an IMAP mailbox with no archive folder answers 409 archive_folder_missing: move it with update_email_message instead. Many at once: bulk_update_email_messages with archive true. Requires can_act_email_messages.",
    toolClass: 'typical',
    route: emailRoute('POST', '/api/email-messages/{sid}/archive'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: sid('em_ms_'), ...emailCommon }),
    outputSchema: McpActionResponse(EmailMessage, z.object({
      email_folder_sids: z.array(z.string()),
      folder_role: EmailFolderRole.nullable(),
    })),
    annotations: { title: 'Archive email message', ...WRITE_OPEN },
  },
  {
    ...base,
    name: 'bulk_update_email_messages',
    description:
      'Apply one change to up to 100 messages in a call: read state, flag, folders, and archive true (applied after the field changes, so "read and archived" is one call). Each message is written at its provider and answered on its own in result.items: ok true with the message, or ok false with the refusal that message would have got alone. One refusal never undoes the others: read items and repeat what failed. The call itself answers 200 unless the request is malformed or names no change. Requires can_act_email_messages.',
    toolClass: 'typical',
    route: emailRoute('POST', '/api/email-messages/bulk-update'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sids: z.array(sid('em_ms_')).min(1).max(100),
      is_read: z.boolean().optional(),
      is_flagged: z.boolean().optional(),
      email_folder_sids: z.array(sid('em_fd_')).optional().describe('The full membership wanted, as on update_email_message.'),
      archive: z.boolean().optional().describe('true: archive each message after the field changes.'),
      ...emailCommon,
    }),
    outputSchema: McpActionResponse(z.null(), z.object({
      applied: z.number().int(),
      failed: z.number().int(),
      items: z.array(z.object({
        sid: z.string(),
        ok: z.boolean(),
        item: EmailMessage.optional(),
        error: RowError.optional(),
      })),
    })),
    annotations: { title: 'Bulk update email messages', ...WRITE_OPEN },
  },
  {
    ...base,
    name: 'get_email_message_attachment',
    description:
      'Get a short-lived download link for one attachment of a message: result.download_url with the name, size and mime. attachment_id is attachments[].id of the message. The file is fetched from the mailbox provider on the call; 503 attachment_fetch_failed is safe to repeat. Google and Microsoft mailboxes only: an IMAP mailbox answers 503 attachment_fetch_failed for now. The link is a secret for as long as it lives: hand it to the person or the tool that downloads, and do not store it. Requires can_view_email_messages.',
    toolClass: 'typical',
    route: emailRoute('POST', '/api/email-messages/{sid}/get-attachment'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: sid('em_ms_'),
      attachment_id: z.string().max(255).describe('attachments[].id of the message.'),
      ...emailCommon,
    }),
    outputSchema: McpActionResponse(z.null(), z.object({
      download_url: z.string().describe('Signed and short-lived.'),
      name: z.string(),
      size: z.number().int().describe('Bytes.'),
      mime: z.string(),
    })),
    annotations: { title: 'Get email message attachment', ...RO_OPEN },
  },
  {
    ...base,
    name: 'get_email_message_source',
    description:
      'Get the raw source of a message (.eml, RFC 5322) as its provider holds it, headers and MIME parts untouched: result.download_url is a signed link that lives 15 minutes, and a source of 256 KB or less also comes inline in content_base64. For archiving, legal export or a parser of your own; to read a message use get_email_message. A scheduled message and one of a hosted mailbox have no source (409 source_not_available); past 25 MB it is refused (409 source_too_large); 503 source_fetch_failed is safe to repeat. Requires can_view_email_messages.',
    toolClass: 'typical',
    route: emailRoute('POST', '/api/email-messages/{sid}/get-source'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: sid('em_ms_'), ...emailCommon }),
    outputSchema: McpActionResponse(z.null(), z.object({
      download_url: z.string().describe('Signed, 15 minutes.'),
      filename: z.string(),
      size_bytes: z.number().int(),
      mime: z.string(),
      content_base64: z.string().nullable().describe('The bytes inline when the source is 256 KB or less, else null.'),
    })),
    annotations: { title: 'Get email message source', ...RO_OPEN },
  },
];
