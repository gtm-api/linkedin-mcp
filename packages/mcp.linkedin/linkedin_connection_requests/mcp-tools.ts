// Entity: LinkedIn Connection Request (gtm.service.linkedin)
// Source of truth: product/research/gtm.service.linkedin/entities/linkedin_connection_requests.md
// Format: registry v2, where each tool carries route metadata so the generic
// dispatcher can drive it. 7 tools (the linkedin-connection-requests route
// group), mounted on linkedin.network.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  filterOp,
  usageMetaField,
  McpActionResponse,
  McpAsyncActionResponse,
  McpMetricsResponse,
  McpMetricsRequestSchema,
  McpSearchRequestSchema,
  McpSearchResponse,
} from '@gtm/mcp-shared';

const SID = z.string().length(18).startsWith('ln_cr_')
  .describe('LinkedIn connection-request sid (ln_cr_…).');
const ACCOUNT_SID = z.string().length(18).startsWith('ln_ac_')
  .describe('LinkedIn account sid (ln_ac_…) of the sending account.');

const LinkedinConnectionRequestRemovalKind = z.enum(['accepted', 'withdrawn', 'expired']);

// ─── One key, one send (product KNOWLEDGE §4.9a; gtm.service.linkedin 06a879a, round 5) ───
//
// An invitation is under the rule the message sends follow (linkedin_messages):
// under a client_reference the key and the person (the member the URN decodes
// to) are ONE invitation, whatever its note says; a repeat is answered with what
// the first send came to and never goes out twice. Every refusal names
// error.context.send_outcome (not_sent, in_flight, unknown, sent), the request's
// own 422 included; activity_log_sid names the caller's own attempt only, another
// invitation's is blocking_activity_log_sid. A lost answer is a 409
// send_outcome_unknown naming send_decisive_at (it was a 503 "retry shortly"
// before round 5), and LinkedIn's refusal of a second invitation while one of the
// account's is out is answered by ours. check_linkedin_connection_request_sent
// asks without sending.
const INVITATION_KEY = z.string().max(255).nullable().optional()
  .describe('Your key for this ONE invitation (max 255, byte for byte): one key per invitation, the same key on every repeat of it. The key and the person (the member the URN decodes to) are one invitation whatever its note says, and a repeat never goes out twice: it answers 200 with the request the first send stored (result.idempotent_replay, result.content_differs when this note differs) or 409 naming error.context.send_outcome (in_flight, unknown with retry_after and send_decisive_at, or sent; not_sent with blocking_activity_log_sid when another invitation to the person is on its way or in doubt). Without a key the same note to the same person counts as a repeat for an hour after it went out. Stored on the row and searchable; check_linkedin_connection_request_sent asks by it.');

const CONFIRMED_NOT_SENT = z.string().length(18).startsWith('ln_al_').nullable().optional()
  .describe("A person's word that an earlier attempt of THIS invitation is not on LinkedIn: its activity_log_sid (ln_al_...), from the 409 or check_linkedin_connection_request_sent, given only after someone looked at the account's sent invitations. Taken once the attempt can no longer land (before that: 409 send_outcome_unknown, waiting_for may_still_land, retry_after and send_decisive_at that moment): it settles that attempt not_sent and this request goes out. An attempt check-sent named in unkeyed_activity_log_sids is not settled: the word counts for this key only, check-sent stops naming it, and the request goes through the usual checks. Moot when the attempt is no longer in doubt; another invitation's sid is 422 not_this_message.");

const CONFIRMED_SENT = z.string().length(18).startsWith('ln_al_').nullable().optional()
  .describe("A person's word that an earlier attempt of THIS invitation IS on LinkedIn: its activity_log_sid, as for confirmed_not_sent (never both). Taken at once; it settles the attempt sent (an attempt check-sent named in unkeyed_activity_log_sids takes this key) and sends nothing: the answer is 409 concurrent_send_in_flight with send_outcome sent, or 200 with the request once it is stored. Another invitation's sid is 422 not_this_message; an attempt already proved not sent is 409 confirmed_sent_contradicts.");

// One candidate of unkeyed_attempt_at_place as check-sent names it
// (LinkedinAccountActivityLogService::recordedAttemptOf, gtm.service.linkedin
// aab9687, review r5d LOW-1): the attempt, its verb, its start and the place it
// recorded when it was sent, as its own target columns keep it.
const UnkeyedAttempt = z.object({
  activity_log_sid: z.string()
    .describe("The attempt (ln_al_...): what a person's word names."),
  action_type: z.string()
    .describe('Its verb, as the activity log names it: send_connection_request.'),
  created_at: z.string().nullable()
    .describe('ISO 8601: when the attempt started.'),
  place: z.object({
    ln_member_id: z.string().optional(),
    ln_id: z.string().optional(),
    sn_id: z.string().optional(),
    recruiter_id: z.string().optional(),
    entity_type: z.string().optional(),
    entity_urn: z.string().optional(),
  }).passthrough().nullable()
    .describe("The place the attempt recorded when it was sent, only the fields it set: the person's ids (ln_member_id, ln_id, sn_id). Null when it recorded none."),
  nickname: z.string().optional()
    .describe("The person's slug, when the attempt kept one."),
}).passthrough();

// check-sent's `result` (LinkedinSendCheckResult::toResult at 06a879a, with
// aab9687's unkeyed_attempts; the shape every family answers): outcome and reason
// always; retry_after, activity_log_sid, send_decisive_at, unkeyed_activity_log_sids
// and unkeyed_attempts when known.
// Plain strings rather than z.enum: the values are the service's constants, and
// no PHP enum backs them for the enum-parity gate to pin.
const CheckSentResult = z.object({
  outcome: z.string()
    .describe('sent | not_sent | in_flight | unknown. Send the same request again only on not_sent; on in_flight or unknown ask again after retry_after.'),
  reason: z.string().nullable()
    .describe('Why. sent: null (item is the request), request_row_pending (it went out, its row comes later), caller_confirmed (a person said so; no row). not_sent: no_send_under_key, refused, not_in_invitations, caller_confirmed. unknown: answer_lost, may_still_land, unreadable, unexplained, unkeyed_attempt_at_place.'),
  retry_after: z.string().optional()
    .describe('ISO 8601: for an invitation in doubt, when the sent invitations are read next.'),
  activity_log_sid: z.string().optional()
    .describe('The attempt the answer is about (in flight, in doubt or landed): what confirmed_not_sent / confirmed_sent name on send_linkedin_connection_request.'),
  send_decisive_at: z.string().optional()
    .describe("ISO 8601: the moment an invitation in doubt can no longer land; a person's confirmed_not_sent is taken from then on."),
  unkeyed_activity_log_sids: z.array(z.string()).optional()
    .describe('With reason unkeyed_attempt_at_place: the candidates, attempts to the person that a build keeping no key made in the last 48 hours and that may be this invitation, by activity-log sid, newest first; activity_log_sid is the first. What a person looks at, and what their word may name.'),
  unkeyed_attempts: z.array(UnkeyedAttempt).optional()
    .describe('With reason unkeyed_attempt_at_place, in the order of unkeyed_activity_log_sids: each candidate with its verb, when it started and the person it recorded, so a person knows where to look.'),
}).passthrough();

// Item projection: every field of LinkedinConnectionRequestDomain (research §Domain).
// Base scalar columns are always serialized (present keys; only nullable when the
// Domain type is `| null`); .passthrough() keeps forward-compat keys valid.
const LinkedinConnectionRequest = z.object({
  sid: z.string(),
  team_sid: z.string(),
  linkedin_account_sid: z.string(),
  ln_member_id: z.string(),
  ln_id: z.string().nullable(),
  sn_id: z.string().nullable(),
  nickname: z.string().nullable(),
  note: z.string().nullable(),
  client_reference: z.string().nullable(), // the caller's own key given at send time; null on sync-picked-up rows
  sent_at: z.string().nullable(), // NULL = send time unknown (sync-picked-up UI invitations; LinkedIn omits the send time)
  invitation_id: z.string().nullable(),
  resend_available_at: z.string().nullable(),
  last_check_at: z.string().nullable(),
  removal_kind: LinkedinConnectionRequestRemovalKind.nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
}).passthrough();

// Metrics: concrete shape per research §metrics. passthrough for forward-compat.
const LinkedinConnectionRequestMetrics = z.object({
  avg_note_length_of_accepted: z.number().nullable(),
  avg_time_to_accept_seconds: z.number().nullable(),
}).passthrough();

const LinkedinConnectionRequestFilter = z.object({
  sid: filterOp(z.string(), ['eq', 'in']).optional(),
  linkedin_account_sid: filterOp(z.string(), ['eq', 'in']).optional(),
  // ln_id / sn_id are URN-decoded to a ln_member_id match by the Service's
  // applyFieldFilter override, which only reads .eq / .in; ne/nin/is_null on
  // these two columns would silently return UNFILTERED, so they are not offered.
  ln_id: filterOp(z.string(), ['eq', 'in']).optional(),
  ln_member_id: filterOp(z.string(), ['eq', 'ne', 'in', 'nin', 'is_null']).optional(),
  sn_id: filterOp(z.string(), ['eq', 'in']).optional(),
  nickname: filterOp(z.string(), ['eq', 'in', 'is_null']).optional(),
  client_reference: filterOp(z.string(), ['eq', 'ne', 'in', 'nin', 'is_null']).optional()
    .describe('The key the caller gave at send time; exact match, is_null:true = sends made without one.'),
  removal_kind: filterOp(LinkedinConnectionRequestRemovalKind, ['eq', 'ne', 'in', 'nin', 'is_null']).optional()
    .describe('is_null:true = pending; eq to split accepted / withdrawn / expired.'),
  sent_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(), // nullable: sync rows with unknown send time
  resend_available_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(),
  created_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  updated_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  deleted_at: filterOp(z.string(), ['is_null', 'gte', 'lte']).optional()
    .describe('Default scope is { is_null: true } (pending rows).'),
}).partial();

// METRICS takes ONE axis, and that narrowness is the contract rather than an
// oversight. LinkedinConnectionRequestService::metrics() builds no
// LinkedinConnectionRequestFilter: it reads filter.linkedin_account_sid off the
// input, bounds created_at by the period and aggregates. Any other axis offered
// here would be accepted and then dropped by the aggregation, so the agent would
// read unfiltered numbers as the answer to a filtered question and have no way
// to tell. Slice the other dimensions with search instead.
const LinkedinConnectionRequestMetricsFilter = LinkedinConnectionRequestFilter
  .pick({ linkedin_account_sid: true });

const LinkedinConnectionRequestInclude = z.enum(['linkedin_account']);

const LinkedinConnectionRequestSortable = z.enum([
  'sent_at', 'resend_available_at', 'deleted_at', 'created_at',
]);

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
// A live-dispatch read: it fetches from LinkedIn in-request through the account's
// browser, which cold-starts a stopped or idle one (about 50 s, or 503
// browser_starting) and releases that account's overdue syncs. Not a read-only
// tool in the MCP sense, whatever its verb says (the audit report of 2026-09-16,
// item 11): a client that auto-approves readOnlyHint tools must not run it blind.
const LIVE_READ = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const SYNC = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const DANGER = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
const DANGER_ONCE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

const base = {
  service: 'linkedin',
  entity: 'linkedin_connection_requests',
  mount: 'linkedin.network',
} as const;

export const linkedinConnectionRequestsTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_linkedin_connection_requests',
    description:
      'List outbound LinkedIn connection requests (invitations we sent) with filters, sorting, cursor pagination and filter.q, a LIKE (substring) over the note. Pending rows have removal_kind IS NULL; terminal rows are accepted / withdrawn / expired (deleted_at set). include[] can eager-load linkedin_account.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-connection-requests/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    inputSchema: McpSearchRequestSchema(LinkedinConnectionRequestFilter, LinkedinConnectionRequestInclude, LinkedinConnectionRequestSortable, 200),
    outputSchema: McpSearchResponse(LinkedinConnectionRequest),
    annotations: { title: 'Search connection requests', ...RO },
  },
  {
    ...base,
    name: 'get_linkedin_connection_requests_metrics',
    description:
      'Period-bound aggregates over one account\'s sent requests. Requires period {from,to} and filter.linkedin_account_sid (.eq or .in) - that is the ONLY filter axis the aggregation applies, unlike search. Returns avg_note_length_of_accepted and avg_time_to_accept_seconds; acceptance / withdraw / expiry rates are derived client-side from the counts block.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-connection-requests/metrics' },
    operation: 'metrics',
    envelope: 'metrics',
    availability: 'ga',
    dangerous: false,
    inputSchema: McpMetricsRequestSchema(LinkedinConnectionRequestMetricsFilter).extend({
      period: z.object({
        from: z.string().describe('ISO 8601 UTC window start (inclusive).'),
        to: z.string().describe('ISO 8601 UTC window end (exclusive); must be after from.'),
      }).describe('Required metrics window [from, to).'),
    }),
    outputSchema: McpMetricsResponse(LinkedinConnectionRequestMetrics),
    annotations: { title: 'Connection requests metrics', ...RO },
  },
  {
    ...base,
    name: 'send_linkedin_connection_request',
    description:
      'Send one outbound LinkedIn connection request (outward action). Address the person by profile_id (the URN, ln_id OR sn_id) or by public_identifier (a vanity slug or linkedin.com/in/ URL, resolved server-side). Server-side checks run first: the daily send limit, the premium-aware note cap (200 free / 300 premium), and the 21-day resend cooldown. Fire-on-success: a row is created only when LinkedIn confirms the send. Sends once per client_reference and person: a repeat is answered, never sent twice; on a 409 read error.context.send_outcome, never resend under a new key. A person with a request on record under another key or none is refused 422 resend_not_available, context.cause pending, accepted, cooldown (resend_available_at) or sync_reset; LinkedIn refusing a second invitation while one of the account\'s is out is answered by that one, never as a refusal of this send. check_linkedin_connection_request_sent asks what an invitation came to without sending.',
    toolClass: 'complex',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-connection-requests/send' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    pacedBucket: 'send_connection_requests',
    massAction: false,
    stepEligible: true,
    scheduleRequired: false,
    inputSchema: z.object({
      linkedin_account_sid: ACCOUNT_SID,
      profile_id: z.string().max(128).optional().describe('Target URN: ln_id (ACoAA…) OR sn_id (ACwAA…); both accepted as profile_id. Exactly one of profile_id / public_identifier.'),
      public_identifier: z.string().max(2048).optional().describe("The person's vanity slug (jane-doe) or their linkedin.com/in/<slug> URL, when that is all you have (a signup, a CRM). Resolved server-side to the URN: the team's own rows first (connections, invitations, followers), then the corpus, then a lite-profile read on the sender (spends enrichment, one extra browser call, cached afterwards). Exactly one of profile_id / public_identifier."),
      note: z.string().max(300).nullable().optional()
        .describe('Invitation note; server caps at 200 chars when the sender is not premium. Over the cap it is 422 unless allow_no_note_fallback is set. Sent verbatim: the platform renders no merge fields, a {{first_name}} goes out as those braces.'),
      allow_no_note_fallback: z.boolean().optional()
        .describe("Default false. When the note is longer than the sender's cap (200 free / 300 premium), send the invite WITHOUT it instead of refusing 422, for campaigns where reaching the person beats personalizing. The response says which happened in result.note_fallback_used, and the stored row carries note=null, so a follow-up does not assume a note the prospect never saw. Scope, stated plainly: this covers the length cap, which the server evaluates itself. LinkedIn's own monthly with-note quota is only visible at send time and arrives untyped, so a refusal there still fails the call rather than being retried blind (a retry after an ambiguous send can invite the person twice)."),
      client_reference: INVITATION_KEY,
      confirmed_not_sent: CONFIRMED_NOT_SENT,
      confirmed_sent: CONFIRMED_SENT,
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(LinkedinConnectionRequest),
    annotations: { title: 'Send connection request', ...DANGER_ONCE },
  },
  // check-sent (2026-10-05, round 5; product KNOWLEDGE §4.9a): what an invitation
  // came to, asked without sending. It sends nothing, but an invitation in doubt
  // has the account's sent invitations (and the person's connection) read in the
  // request when the last look is old enough, through the account's browser on
  // the syncs' own budgets, so it is a live read, not readOnlyHint. No
  // pacedBucket, as check_linkedin_message_sent: a look the budget holds back
  // reads nothing and the call still answers (unknown, with retry_after), never 429.
  {
    ...base,
    name: 'check_linkedin_connection_request_sent',
    description:
      "Ask what a LinkedIn connection request came to, without sending: by the client_reference it went out under (optionally for one person: profile_id or ln_member_id), or by the activity_log_sid a 409 named. result.outcome: sent (item is the request, or null with reason request_row_pending or caller_confirmed), in_flight, unknown (the answer was lost and the sent invitations have not shown it yet; retry_after, send_decisive_at), or not_sent (no_send_under_key, refused, not_in_invitations, caller_confirmed). Send the same request again only on not_sent, under the same key. result.activity_log_sid is the attempt a person's word names (confirmed_not_sent / confirmed_sent on the send); reason unkeyed_attempt_at_place lists in unkeyed_activity_log_sids the attempts of a build that kept no key that may be this one. An invitation in doubt has the sent invitations read now when the last look is old enough, so a call can take as long as a head read. A key sent to several persons is 422 place_required (context.places).",
    toolClass: 'complex',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-connection-requests/check-sent' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      linkedin_account_sid: ACCOUNT_SID.describe('The account that sent (ln_ac_…). A key is looked up on this account only.'),
      client_reference: z.string().min(1).max(255).nullable().optional()
        .describe('The key the invitation went out under, byte for byte. Exactly one of client_reference / activity_log_sid. Found at any age: an invitation in doubt never ages out of its key.'),
      activity_log_sid: z.string().length(18).startsWith('ln_al_').nullable().optional()
        .describe('The attempt a 409 or an earlier check named (ln_al_…); it takes no person. An attempt of another account, or one that is no invitation, is 404.'),
      profile_id: z.string().max(128).nullable().optional()
        .describe('The person, next to client_reference: the URN the send was given (ln_id ACoAA… or sn_id ACwAA…). At most one of profile_id / ln_member_id.'),
      ln_member_id: z.string().max(64).nullable().optional()
        .describe("The person, next to client_reference: their member id (digits)."),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(LinkedinConnectionRequest, CheckSentResult),
    annotations: { title: 'Check whether a LinkedIn connection request went out', ...LIVE_READ },
  },
  {
    ...base,
    name: 'sync_linkedin_connection_requests',
    description:
      'Refresh the outbound sent-invitations snapshot for one account by inserting a sync_run (upsert-only). ASYNC: returns pending refs to poll or await the linkedin-connection-requests.sync-completed webhook.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-connection-requests/sync-linkedin-connection-requests' },
    operation: 'action',
    envelope: 'action_async',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ linkedin_account_sid: ACCOUNT_SID, ...usageMetaField }),
    outputSchema: McpAsyncActionResponse(LinkedinConnectionRequest),
    annotations: { title: 'Sync connection requests', ...SYNC },
  },
  {
    ...base,
    name: 'get_my_latest_linkedin_connection_requests',
    description:
      'Always-fresh head read of pending outbound requests: refresh the newest from LinkedIn in-request (§5.8), then return the last N (sent_at DESC). The first page (cursor null) triggers the refresh; continuation pages read the already-refreshed DB. Account-scoped. Runs through the account\'s browser: a stopped or idle one is cold-started first (about 50 s, or 503 browser_starting), which also releases that account\'s overdue syncs.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-connection-requests/get-my-latest' },
    operation: 'action',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    pacedBucket: 'self_account_sync',
    inputSchema: z.object({
      linkedin_account_sid: ACCOUNT_SID,
      page_size: z.number().int().min(1).max(100).optional()
        .describe('Freshest rows to return / refresh coverage target (1..100, default 50).'),
      cursor: z.string().nullable().optional()
        .describe('Opaque forward cursor; the LinkedIn-side refresh runs only on the first page (cursor null).'),
      ...usageMetaField,
    }),
    outputSchema: McpSearchResponse(LinkedinConnectionRequest),
    annotations: { title: 'Get my latest connection requests', ...LIVE_READ },
  },
  {
    ...base,
    name: 'withdraw_linkedin_connection_request',
    description:
      'Withdraw a pending outbound connection request (outward, destructive). Dispatches the withdraw-invitation browser verb (networking_general bucket); on terminal success the row is soft-deleted (removal_kind=withdrawn) and a 21-day resend cooldown begins. Identify the request by its ln_cr_ sid.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-connection-requests/{sid}/withdraw', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    pacedBucket: 'networking_general',
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: SID, ...usageMetaField }),
    outputSchema: McpActionResponse(LinkedinConnectionRequest),
    annotations: { title: 'Withdraw connection request', ...DANGER },
  },
];
