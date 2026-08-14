// Entity: LinkedIn Message (gtm.service.linkedin)
// Source of truth: product/research/gtm.service.linkedin/entities/linkedin_messages.md
// Format: registry v2, where each tool carries route metadata so the generic
// dispatcher can drive it. 12 tools (the linkedin-messages route group);
// they share the /mcp/linkedin/messaging mount with linkedin-conversations.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  filterOp,
  usageMetaField,
  McpActionResponse,
  McpMetricsResponse,
  McpSearchRequestSchema,
  McpSearchResponse,
} from '@gtm/mcp-shared';

const SID = z.string().length(18).startsWith('ln_ms_')
  .describe('LinkedIn message sid (ln_ms_…).');
const ACCOUNT_SID = z.string().length(18).startsWith('ln_ac_')
  .describe('LinkedIn account sid (ln_ac_…).');
const CONVERSATION_SID = z.string().length(18).startsWith('ln_cv_')
  .describe('LinkedIn conversation sid (ln_cv_…).');

const MessengerType = z.enum(['linkedin', 'sales_navigator'])
  .describe('Messenger surface: basic LinkedIn messenger or Sales Navigator.');
const LinkedinMessageLinkedinType = z.enum(['message', 'inmail', 'connection_note'])
  .describe('Channel sub-kind: regular DM / premium InMail / system-seeded connection note.');
const LinkedinMessageDirection = z.enum(['inbox', 'outbox'])
  .describe('Direction relative to our account: received / sent.');
const LinkedinMessageAutomation = z.enum(['auto', 'manual', 'connect', 'synced'])
  .describe('Writer provenance.');

// BREAKING, 2026-08-13: the outbound attachment element is the WIRE's shape now.
// It used to be published as {name, path(https), size} with a promise that the
// plugin downloaded from `path`. No wire has ever taken that: the node reads
// file_base64 / file_byte_size / file_name / file_type, its RPC map declares all
// four non-optional, and the plugin hands them straight to media.uploadFile. So a
// caller who followed this schema did not lose the attachment, they lost the SEND:
// the upload dereferenced the missing members and threw before createMessage ran.
// No alias was kept, because the old shape could never have worked.
//
// `file_url` is OUR addition on top of an unchanged wire, the same arrangement
// send_linkedin_voice_message already has: the backend fetches the URL
// server-side (streamed, hard byte cap), base64s it, and fills in the members the
// caller left out. Prefer it over inlining base64 in JSON.
const Attachment = z.object({
  file_base64: z.string().min(1).optional()
    .describe('The file itself: a data:<mime>;base64,<...> URL or bare base64. Exactly one of file_base64 / file_url.'),
  file_url: z.string().max(2048).url().optional()
    .describe('https:// URL the BACKEND downloads server-side and encodes for you. Exactly one of file_base64 / file_url.'),
  file_name: z.string().min(1).max(255).optional()
    .describe('Display filename shown to the recipient. Derived from the URL path when omitted on the file_url arm.'),
  file_type: z.string().min(1).max(255).optional()
    .describe('MIME type. Read off the data: prefix or the fetched Content-Type when omitted.'),
  file_byte_size: z.number().int().min(1).optional()
    .describe('Advisory only: the backend measures the real size and sends that.'),
}).describe(
  'Exactly one of file_base64 / file_url per item. Decoded bytes across ALL attachments of one send '
  + 'may not exceed 35 MB, derived from the node\'s own 50 MB body limit and base64\'s 4/3 inflation; '
  + 'over it the send is refused with attachments_too_large before a browser dispatch is spent.',
);

// What the two download verbs return. They are pass-through reads: the
// controller sends item:null and puts the plugin body verbatim in `result`
// (LinkedinMessageService::downloadMessageAttachment / downloadSalesMessageAttachment
// -> node /download-attachment-by-url result). Nothing is persisted, so the
// message row is NOT echoed back.
const AttachmentPayload = z.object({
  data_url: z.string().describe('data:<mime>;base64,… . The whole payload, inline.'),
  content_type: z.string().describe('MIME type LinkedIn served the asset with.'),
  file_byte_size: z.number().describe('Decoded size in bytes.'),
}).passthrough();

// Metrics window: required half-open [from, to), ≤ 90 days.
const Period = z.object({
  from: z.string().datetime().describe('ISO 8601 UTC start (inclusive).'),
  to: z.string().datetime().describe('ISO 8601 UTC end (exclusive); must be after from; window ≤ 90 days.'),
}).describe('Metrics time window.');

// Item projection: every field of LinkedinMessageDomain (research §Domain). One row
// shape across all channels (messenger_type / linkedin_type / type / automation are
// discriminator columns on the same row, not separate projections). Base scalar/JSON
// columns are always serialized; .passthrough() keeps forward-compat keys valid.
const LinkedinMessage = z.object({
  sid: z.string(),
  team_sid: z.string(),
  linkedin_account_sid: z.string(),
  linkedin_conversation_sid: z.string(),
  messenger_type: MessengerType,
  linkedin_type: LinkedinMessageLinkedinType,
  type: LinkedinMessageDirection,
  automation: LinkedinMessageAutomation,
  ln_member_id: z.string(),
  ln_id: z.string().nullable(),
  sn_id: z.string().nullable(),
  nickname: z.string().nullable(),
  subject: z.string().nullable(),
  text: z.string(),
  // JSON array; default [] (never null). TWO shapes land in this column and the
  // row does not say which, so every key is optional:
  //   - synced rows carry the get-messages wire element VERBATIM (the sync
  //     handlers store `$el['attachments']` unmapped): { id, urn, name?,
  //     content_type, content_url, file_byte_size? }.
  //   - rows inserted by our own send verbs carry the request value:
  //     { name, path, size }.
  // `urn` is the one to feed download_linkedin_message_attachment.
  attachments: z.array(z.object({
    id: z.string().optional(),
    urn: z.string().optional().describe('digitalmediaAsset URN; the attachment_urn the download tools take.'),
    name: z.string().optional(),
    content_type: z.string().optional(),
    content_url: z.string().optional(),
    file_byte_size: z.number().optional(),
    path: z.string().optional().describe('Outbound rows only: the https:// URL we uploaded from.'),
    size: z.number().optional().describe('Outbound rows only.'),
  }).passthrough()),
  // JSON [ro]: emoji reactions aggregated per emoji, exactly as the get-messages /
  // get-conversations wire reports them (voyager reactionSummaries). NULL when never observed
  // on a reactions-carrying path; [] when observed with no reactions.
  // Each: { emoji, count, is_viewer_reacted, first_reacted_at (ISO 8601) }.
  reactions: z.array(z.object({
    emoji: z.string(),
    count: z.number(),
    is_viewer_reacted: z.boolean(),
    first_reacted_at: z.string().nullable(),
  }).passthrough()).nullable(),
  message_hash: z.string(),
  sent_at: z.string(),
  custom_content: z.record(z.unknown()).nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
}).passthrough();

// Counts: concrete shape per research §search Counts. passthrough for forward-compat.
const LinkedinMessageCounts = z.object({
  total_count: z.number(),
  inbox_count: z.number(),
  outbox_count: z.number(),
  message_count: z.number(),
  inmail_count: z.number(),
  connection_note_count: z.number(),
  with_attachments_count: z.number(),
  groups: z.record(z.unknown()), // dynamic breakdown, object even when empty
}).passthrough();

// Top-level `refresh` block the get-my-latest paths append (AppendsLatestRefresh).
// performed=false on cursor-continuation pages (the §5.8 LinkedIn-side refresh runs
// only on the first page, where cursor is null); stop_reason is null then, a string when performed.
const LatestRefresh = z.object({
  performed: z.boolean(),
  pages_fetched: z.number(),
  items_seen: z.number(),
  items_upserted: z.number(),
  stop_reason: z.string().nullable(),
});

// Period-bound metrics (declared in research §metrics). All three always present, nullable
// (NULL when no qualifying rows). Kept as plain numbers because averages may be fractional.
const LinkedinMessageMetrics = z.object({
  reply_rate_pct: z.number().nullable(),
  avg_time_to_reply_seconds: z.number().nullable(),
  avg_thread_depth: z.number().nullable(),
}).passthrough();

const LinkedinMessageIncludeEnum = z.enum(['linkedin_conversation', 'linkedin_account']);
const LinkedinMessageSortableFieldEnum = z.enum(['sent_at', 'created_at', 'updated_at']);
const LinkedinMessageGroupableFields = z.enum([
  'linkedin_account_sid',
  'linkedin_conversation_sid',
  'type',
  'linkedin_type',
  'automation',
  'messenger_type',
]).describe('Field to group metrics by. One field per request.');

const LinkedinMessageFilter = z.object({
  sid: filterOp(z.string(), ['eq', 'in']),
  linkedin_account_sid: filterOp(z.string(), ['eq', 'in']),
  linkedin_conversation_sid: filterOp(z.string(), ['eq', 'in']),
  messenger_type: filterOp(MessengerType, ['eq', 'in']),
  linkedin_type: filterOp(LinkedinMessageLinkedinType, ['eq', 'ne', 'in', 'nin']),
  type: filterOp(LinkedinMessageDirection, ['eq', 'in']),
  automation: filterOp(LinkedinMessageAutomation, ['eq', 'ne', 'in', 'nin']),
  ln_id: filterOp(z.string(), ['eq', 'ne', 'in', 'nin', 'is_null']),
  ln_member_id: filterOp(z.string(), ['eq', 'ne', 'in', 'nin']),
  sn_id: filterOp(z.string(), ['eq', 'ne', 'in', 'nin', 'is_null']),
  nickname: filterOp(z.string(), ['eq', 'in', 'is_null']),
  message_hash: filterOp(z.string(), ['eq', 'in']),
  q: z.string().max(128).describe('FULLTEXT over message text + inmail subject.'),
  sent_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']),
  created_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']),
  updated_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']),
  deleted_at: filterOp(z.string(), ['is_null', 'gte', 'lte']),
}).partial();

// METRICS takes ONE axis, and that narrowness is the contract rather than an
// oversight. LinkedinMessageService::metrics() builds no LinkedinMessageFilter:
// it reads filter.linkedin_account_sid off the input, bounds sent_at by the
// period and aggregates. Any other axis offered here would be accepted and then
// dropped by the aggregation, so the agent would read unfiltered numbers as the
// answer to a filtered question and have no way to tell. Slice the other
// dimensions with search instead.
const LinkedinMessageMetricsFilter = LinkedinMessageFilter
  .pick({ linkedin_account_sid: true });

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const ACT = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DANGER = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

const base = {
  service: 'linkedin',
  entity: 'linkedin_messages',
  mount: 'linkedin.messaging',
} as const;

export const linkedinMessagesTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_linkedin_messages',
    description:
      'List LinkedIn messages (basic DM + Sales Navigator + InMail) with operator-object filters (account, conversation, channel, direction, contact ids, date ranges) and FULLTEXT q over body + subject. Supports include[], sort, cursor pagination. page_size:0 for count-only. To read a single message, filter by {sid:{eq:"ln_ms_…"}}.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-messages/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: McpSearchRequestSchema(LinkedinMessageFilter, LinkedinMessageIncludeEnum, LinkedinMessageSortableFieldEnum, 200),
    outputSchema: McpSearchResponse(LinkedinMessage),
    annotations: { title: 'Search LinkedIn messages', ...RO },
  },
  {
    ...base,
    name: 'get_linkedin_messages_metrics',
    description:
      'Period-bound message aggregates for one account (reply_rate_pct, avg_time_to_reply_seconds, avg_thread_depth) with an optional group_by axis. Requires period {from,to} (≤ 90 days) and filter.linkedin_account_sid - that is the ONLY filter axis the aggregation applies, unlike search. Returns the counts block alongside.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-messages/metrics' },
    operation: 'metrics',
    envelope: 'metrics',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: z.object({
      filter: LinkedinMessageMetricsFilter.describe('Row scope; linkedin_account_sid is REQUIRED (422 without it).'),
      period: Period,
      group_by: LinkedinMessageGroupableFields.optional().describe('Optional single split axis.'),
      ...usageMetaField,
    }),
    outputSchema: McpMetricsResponse(LinkedinMessageMetrics),
    annotations: { title: 'Get LinkedIn messages metrics', ...RO },
  },
  {
    ...base,
    name: 'get_my_latest_linkedin_messages',
    description:
      'Always-fresh head read of ONE basic-messenger thread (§5.8 refresh of that conversation from LinkedIn, then the last N messages, sent_at DESC). Never stale: it 429s with bucket_saturated / sync_in_progress. Use before drafting a reply; use search_linkedin_messages for stored history.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-messages/get-my-latest' },
    operation: 'action',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      linkedin_conversation_sid: CONVERSATION_SID.describe("REQUIRED; must be a messenger_type='linkedin' thread."),
      page_size: z.number().int().min(1).max(100).optional().describe('N returned, 1..100, default 50.'),
      cursor: z.string().nullable().optional().describe('Opaque; pagination over the refreshed tail.'),
      ...usageMetaField,
    }),
    outputSchema: McpSearchResponse(LinkedinMessage, undefined, LinkedinMessageCounts).extend({ refresh: LatestRefresh }),
    annotations: { title: 'Get my latest LinkedIn messages', ...ACT },
  },
  {
    ...base,
    name: 'get_my_latest_linkedin_messages_sales_nav',
    description:
      "Sales Navigator variant of get_my_latest_linkedin_messages: always-fresh head read of ONE SN thread's messages (§5.8 refresh-then-return). Requires a messenger_type='sales_navigator' conversation; same hard-429 guards.",
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-messages/get-my-latest-sales-nav' },
    operation: 'action',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      linkedin_conversation_sid: CONVERSATION_SID.describe("REQUIRED; must be a messenger_type='sales_navigator' thread."),
      page_size: z.number().int().min(1).max(100).optional().describe('N returned, 1..100, default 50.'),
      cursor: z.string().nullable().optional().describe('Opaque; pagination over the refreshed tail.'),
      ...usageMetaField,
    }),
    outputSchema: McpSearchResponse(LinkedinMessage, undefined, LinkedinMessageCounts).extend({ refresh: LatestRefresh }),
    annotations: { title: 'Get my latest Sales Navigator messages', ...ACT },
  },
  {
    ...base,
    name: 'send_linkedin_message',
    description:
      'Send one outbound regular LinkedIn DM on the basic messenger (outward action). Reply to an existing thread via linkedin_conversation_sid, or open a new thread to a 1st-degree connection via ln_id / sn_id. Guards run first: in-flight dedup, send_messages daily cap, 8000-char body cap, connection guard, attachment https:// reachability, basic-messenger surface guard. Fire-on-success: a row is inserted only on terminal success. When NOT: InMail to a non-connection → send_linkedin_inmail; voice note → send_linkedin_voice_message; Sales Navigator thread → send_linkedin_sales_nav_message; the connection-request note lives on linkedin-connection-requests. Bulk send: loop client-side and respect the daily cap.',
    toolClass: 'complex',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-messages/send' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    creditable: false,
    massAction: false,
    stepEligible: true,
    scheduleRequired: false,
    inputSchema: z.object({
      linkedin_account_sid: ACCOUNT_SID,
      linkedin_conversation_sid: CONVERSATION_SID.nullable().optional().describe("Existing basic-messenger thread; provide this OR a profile URN."),
      ln_id: z.string().max(128).nullable().optional().describe('Regular-profile URN (ACoAA…) for a new thread.'),
      sn_id: z.string().max(64).nullable().optional().describe('Sales Navigator URN (ACwAA…); interchangeable with ln_id.'),
      text: z.string().min(1).max(8000).describe('Message body; 1..8000 chars.'),
      attachments: z.array(Attachment).optional().describe('Exactly one of file_base64 / file_url per item; 35 MB decoded total per send.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(LinkedinMessage),
    annotations: { title: 'Send LinkedIn message', ...DANGER },
  },
  {
    ...base,
    name: 'send_linkedin_voice_message',
    description:
      'Send one voice note on the basic LinkedIn messenger (outward action). audio arrives as a https:// url or base64 (any common format) and is normalized server-side to AAC/m4a, hard-capped at 60 s. Same guard chain as send_linkedin_message plus audio validation. Fire-on-success: a row is inserted only on terminal success; no text body. When NOT: text DM → send_linkedin_message; SN threads → send_linkedin_sales_nav_message; audio longer than 60 s is rejected, so trim client-side first.',
    toolClass: 'complex',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-messages/send-voice' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      linkedin_account_sid: ACCOUNT_SID,
      linkedin_conversation_sid: CONVERSATION_SID.nullable().optional().describe("Existing basic-messenger thread; provide this OR a profile URN."),
      ln_id: z.string().max(128).nullable().optional().describe('Regular-profile URN for a new thread.'),
      sn_id: z.string().max(64).nullable().optional().describe('Sales Navigator URN; interchangeable with ln_id.'),
      audio: z.object({
        url: z.string().optional().describe('https:// source the backend fetches.'),
        base64: z.string().optional().describe('Inline payload (~15 MB cap pre-normalization).'),
      }).describe('Exactly one of url / base64; normalized server-side to AAC/m4a ≤ 60 s.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(LinkedinMessage),
    annotations: { title: 'Send LinkedIn voice message', ...DANGER },
  },
  {
    ...base,
    name: 'send_linkedin_inmail',
    description:
      'Send one premium InMail to a person (outward action). Person-addressed only via ln_id / sn_id, subject required (≤ 200), body ≤ 1900. Guards: in-flight dedup, send_inmails daily cap, Premium guard, InMail-credits guard. Fire-on-success; the response result carries the authoritative inmail_credits_remaining (open profiles may not decrement). When NOT: 1st-degree connection → send_linkedin_message (free); no Premium / zero credits → the guards 422; SN thread continuation → send_linkedin_sales_nav_message.',
    toolClass: 'complex',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-messages/send-inmail' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      linkedin_account_sid: ACCOUNT_SID,
      ln_id: z.string().max(128).nullable().optional().describe('Regular-profile URN (ACoAA…); one URN required.'),
      sn_id: z.string().max(64).nullable().optional().describe('Sales Navigator URN; interchangeable with ln_id.'),
      subject: z.string().min(1).max(200).describe('REQUIRED InMail subject; 1..200 chars.'),
      text: z.string().min(1).max(1900).describe('InMail body; 1..1900 chars.'),
      attachments: z.array(Attachment).optional().describe('Exactly one of file_base64 / file_url per item; 35 MB decoded total per send.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(LinkedinMessage),
    annotations: { title: 'Send LinkedIn InMail', ...DANGER },
  },
  {
    ...base,
    name: 'send_linkedin_sales_nav_message',
    description:
      'Send one Sales Navigator message (outward action): continue an existing SN thread via linkedin_conversation_sid (messenger_type=sales_navigator), or open a new SN thread via ln_id / sn_id. Body ≤ 8000. Guards: in-flight dedup, send_inmails daily cap, SN-seat guard, SN surface guard. Fire-on-success. When NOT: basic-messenger threads → send_linkedin_message / send_linkedin_voice_message; cold InMail outside SN → send_linkedin_inmail; account without an SN seat is rejected, so check linkedin-accounts.has_sn first.',
    toolClass: 'complex',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-messages/send-sales-nav' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      linkedin_account_sid: ACCOUNT_SID,
      linkedin_conversation_sid: CONVERSATION_SID.nullable().optional().describe("Existing SN thread (messenger_type='sales_navigator'); provide this OR a profile URN."),
      ln_id: z.string().max(128).nullable().optional().describe('Regular-profile URN for a new SN thread.'),
      sn_id: z.string().max(64).nullable().optional().describe('Sales Navigator URN (preferred on the SN surface); interchangeable with ln_id.'),
      text: z.string().min(1).max(8000).describe('Message body; 1..8000 chars.'),
      attachments: z.array(Attachment).optional().describe('Exactly one of file_base64 / file_url per item; 35 MB decoded total per send.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(LinkedinMessage),
    annotations: { title: 'Send Sales Navigator message', ...DANGER },
  },
  {
    ...base,
    name: 'react_linkedin_message',
    description:
      'Add or remove an emoji reaction on one stored message on LinkedIn (outward action). Pass the message sid + a reaction_type; the reaction is dispatched to LinkedIn and mirrored onto the stored row. Set remove:true to take YOUR reaction back (pass the same reaction_type you reacted with). Basic messenger only: an SN message or a non-2-… message_hash is refused before dispatch. Spends the messaging_general bucket.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-messages/{sid}/react', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID,
      reaction_type: z.string().min(1).max(32).describe('Single emoji or LinkedIn reaction identifier.'),
      remove: z.boolean().nullable().optional()
        .describe('true = unreact (drives the unreact-on-message verb) with the SAME reaction_type. Default false = react.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(LinkedinMessage),
    annotations: { title: 'React to message', ...DANGER },
  },
  {
    ...base,
    name: 'download_linkedin_message_attachment',
    description:
      'Download one inbound attachment of a basic-messenger message, returned inline as a base64 data_url (nothing is persisted, no row changes). This verb is addressed by RAW LinkedIn ids, not by our message sid, so assemble it from a message row you already hold (search_linkedin_messages): linkedin_account_sid = that row\'s linkedin_account_sid; message_id = that row\'s message_hash (must be the 2-… form); attachment_urn = attachments[i].urn on the same row. profile_id is the ACTING account\'s own LinkedIn URN: read ln_id off that linkedin_account_sid via search_linkedin_accounts, NOT the other party\'s URN. 120 s budget, up to ~50 MB; spends the messaging_general bucket.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-messages/download-attachment' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      linkedin_account_sid: ACCOUNT_SID.describe('Mailbox owner that received the message: the message row\'s linkedin_account_sid.'),
      profile_id: z.string().max(128).describe("The acting account's OWN profile URN (ln_id of linkedin_account_sid from search_linkedin_accounts), not the sender's."),
      message_id: z.string().max(255).describe('Raw LinkedIn MessageId: the message row\'s message_hash (2-… form; the conversation id is decoded from it).'),
      attachment_urn: z.string().max(512).describe('Which attachment of that message: attachments[i].urn on the stored row (urn:li:digitalmediaAsset:…).'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), AttachmentPayload),
    annotations: { title: 'Download message attachment', ...RO },
  },
  {
    ...base,
    name: 'download_linkedin_sales_nav_message_attachment',
    description:
      "Sales Navigator variant of download_linkedin_message_attachment: one inbound attachment of an SN message, inline as a base64 data_url. Same raw-id addressing, one field fewer (the SN wire verb takes no profile_id): linkedin_account_sid must be an account with Sales Navigator, message_id is the message row's message_hash, attachment_urn is attachments[i].urn on that row. The row must be messenger_type='sales_navigator' (an account without SN is refused before dispatch). Same 120 s budget and messaging_general bucket.",
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-messages/download-sales-nav-attachment' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      linkedin_account_sid: ACCOUNT_SID.describe("Mailbox owner (Sales Navigator required): the SN message row's linkedin_account_sid."),
      message_id: z.string().max(255).describe("Raw LinkedIn MessageId: the message row's message_hash."),
      attachment_urn: z.string().max(512).describe('Which attachment of that message: attachments[i].urn on the stored row (urn:li:digitalmediaAsset:…).'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), AttachmentPayload),
    annotations: { title: 'Download Sales Navigator attachment', ...RO },
  },
  {
    ...base,
    name: 'start_linkedin_group_conversation',
    description:
      'Start a new multi-attendee (group) chat on the basic messenger and send an opening message (outward action). Provide the executor account, 2..20 attendee URNs and the opening body (1..8000 chars, optional attachments, optional conversation_title to name the group); mints the group thread and dispatches the first message. Spends the messaging_general bucket.',
    toolClass: 'complex',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-messages/start-group' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      linkedin_account_sid: ACCOUNT_SID,
      attendees: z.array(z.object({
        ln_id: z.string().max(128).nullable().optional().describe('Regular-profile URN.'),
        sn_id: z.string().max(64).nullable().optional().describe('Sales Navigator URN; interchangeable with ln_id.'),
      })).min(2).max(20).describe('2..20 other participants; each needs a URN.'),
      text: z.string().min(1).max(8000).describe('Opening message; 1..8000 chars.'),
      conversation_title: z.string().max(100).nullable().optional()
        .describe('Optional group name, max 100 chars; omitted leaves the thread unnamed.'),
      attachments: z.array(Attachment).optional().describe('Exactly one of file_base64 / file_url per item; 35 MB decoded total per send.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(LinkedinMessage),
    annotations: { title: 'Start group conversation', ...DANGER },
  },
];
