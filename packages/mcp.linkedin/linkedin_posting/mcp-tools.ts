// Entity: LinkedIn Posting (gtm.service.linkedin)
// Source of truth: product/research/gtm.service.linkedin/entities/linkedin_posting.md
// Format: registry v2, each tool carries route metadata so the generic
// dispatcher can drive it. 8 tools (the linkedin-posting route group), mounted
// on linkedin.content: three writes, the undo of each, and the scheduled-posts
// queue pair (a private read + a draft delete, 2026-08-21).
//
// This is the stateless content-AUTHORING surface: no table, no Domain, no
// events. Each action dispatches the matching plugin wire verb on the account's
// browser under its §9 write bucket (identity-bound, so
// linkedin_account_sid is REQUIRED and there is no §9.5 pool fallback) and
// returns the resulting activity ref plus the linkedin-account-activity-log row
// per §4.12a. Nothing is persisted here.
//
// 2026-07-24 service split: the outbound `comment` / `react` verbs moved here
// from linkedin-comments / linkedin-engagements, and `create-post` moved here
// from linkedin-posts. The persisted lifecycle of a post (tracked posts, their
// comments and reactions, our-vs-native attribution) left for gs.service.signals
// on getsales.io, so linkedin-tracked-posts / -comments / -engagements /
// -searches / -search-results no longer exist on this backend. Post READING is
// linkedin-scraping (get-post-comments / -reactors / -resharers)
// and linkedin-enrichment (post-details).

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import { usageMetaField, McpActionResponse } from '@gtm/mcp-shared';

const ACCOUNT_SID = z.string().length(18).startsWith('ln_ac_')
  .describe('LinkedIn account sid (ln_ac_…), the authoring account. Identity-bound: REQUIRED, posts publish AS this account.');

// Every verb that targets an existing post addresses it by its social-thread urn.
// No local row is required or created (LinkedinPostingCommentRequest /
// LinkedinPostingReactRequest: required|string|min:1|max:512).
//
// Two urn families since the plugin widened create-comment / create-reaction
// (2026-07-28). BREAKING 2026-07-30: the field was `activity_urn` and now carries
// the wire's own name, because it stopped carrying only activity urns. There is no
// alias: a call with the old key fails `required`, and a stored mass-action plan
// whose step args still say `activity_urn` no longer resolves a target.
//
// Note this is NOT the same field as the `activity_urn` these tools RETURN
// (create_linkedin_post's published-post urn, get_activity_urn_by_url's result):
// those really are activity urns and keep the name.
const ENTITY_URN = z.string().min(1).max(512)
  .describe('The post handle: urn:li:activity:<id> for a member post, or urn:li:ugcPost:<id> for a company-page post or a newsletter issue (LinkedIn threads those as ugcPost, not activity). Either form is passed to the wire verbatim. A post URL is also accepted when the id is in it: the feed permalink and the share link (/posts/<slug>-activity-<id>-<hash>) are both converted locally. A link WITHOUT an id (a shortlink, a bare slug URL) is refused 422 entity_urn_not_resolvable: reading those means opening the page, so call get_activity_urn_by_url first rather than have a write verb open a page silently. The post does NOT need to be tracked or owned by us. Renamed from activity_urn on 2026-07-30; the old name is no longer accepted.');

// BREAKING, 2026-08-06: create-post went live and its reserved contract was
// rewritten to the node's express-validator chain, which disagreed with it in
// five ways (§ CONTRACT AUTHORITY: the wire is the contract, our reserved shape
// was a guess). `media` (up to 9 items, content_base64 XOR url) is gone with no
// alias: the wire member is `images`, at most ONE, base64 only, and there is no
// url arm anywhere on it. `visibility` moved from lowercase to the wire's own
// uppercase vocabulary. `allowed_commenters_scope` and `images[].alt_text` were
// missing and are now taken. `text` may be EMPTY when an image is attached.
const LinkedinPostingVisibility = z.enum(['ANYONE', 'CONNECTIONS_ONLY']);

const LinkedinPostingAllowedCommentersScope = z.enum(['ALL', 'CONNECTIONS_ONLY', 'NONE']);

const LinkedinPostingImageValue = z.object({
  file_base64: z.string().min(1)
    .describe('The image bytes: a data:<mime>;base64,<...> URL or bare base64. The only way to attach an image; there is no fetch-by-url arm.'),
  file_byte_size: z.number().int().min(1).nullable().optional(),
  file_name: z.string().min(1).max(255).nullable().optional(),
  file_type: z.string().min(1).max(255).nullable().optional(),
  alt_text: z.string().nullable().optional().describe('Accessibility alt text; may be empty.'),
});

// The §4.12a dispatch row (linkedin-account-activity-log). Kept open rather than
// re-declaring LinkedinAccountActivityLogDomain here: that Domain is owned by
// packages/mcp.linkedin/linkedin_account_activity_log, and this file owns no entity.
const ACTIVITY_LOG = z.object({}).passthrough()
  .describe('Full dispatch row (linkedin-account-activity-log) per §4.12a. Poll it there by sid for the terminal outcome.');

const CreatePostResult = z.object({
  activity_urn: z.string().nullable().describe('The published post as an activity urn.'),
  post_urn: z.string().nullable().describe('The same post as urn:li:share:<id>.'),
  url: z.string().nullable().describe('Public post URL, query string already stripped.'),
  created_at: z.string().nullable().describe('Publication time, ISO 8601.'),
  text: z.string().describe('The body LinkedIn actually published, read back off the wire. Empty for an image-only post.'),
  activity_log: ACTIVITY_LOG,
}).passthrough();

const CommentResult = z.object({
  comment_urn: z.string().describe('The created comment ref.'),
  activity_log: ACTIVITY_LOG,
}).passthrough();

const DeletePostResult = z.object({
  deleted: z.literal(true).describe('Always true on a 200: a refused delete is a 409, never a success body.'),
  message: z.string().nullable().describe("LinkedIn's own confirmation toast, when it sends one."),
  activity_log: ACTIVITY_LOG,
}).passthrough();

const DeleteCommentResult = z.object({
  deleted: z.literal(true),
  activity_log: ACTIVITY_LOG,
}).passthrough();

const UnreactResult = z.object({
  removed: z.literal(true),
  activity_log: ACTIVITY_LOG,
}).passthrough();

const ReactResult = z.object({
  activity_log: ACTIVITY_LOG,
}).passthrough();

// One SCHEDULED (unpublished) share from the queue. The identity field is the
// urn; the rest is best-effort off LinkedIn's preview objects.
const ScheduledPostRow = z.object({
  post_urn: z.string().nullable()
    .describe('The queued share\'s BACKEND urn (urn:li:share:/ugcPost:/groupPost:) - the exact handle delete_linkedin_scheduled_post takes. NOT an activity urn: an unpublished post has no activity yet.'),
  scheduled_at: z.string().nullable()
    .describe('Planned publication time, ISO 8601; null when the preview did not carry it (best-effort field).'),
  text: z.string().describe('Draft body; empty string when the draft has no text.'),
  error_message: z.string().nullable()
    .describe("LinkedIn's own preview error (e.g. failed media processing); normally null."),
}).passthrough();

const GetScheduledPostsResult = z.object({
  rows: z.array(ScheduledPostRow),
  paging: z.object({
    next_cursor: z.string().nullable().describe('Offset cursor for the next page; null when the queue is exhausted.'),
    total: z.number().int().nullable().describe("The wire's total queue size, when it sends one."),
  }).passthrough(),
  activity_log: ACTIVITY_LOG,
}).passthrough();

const DeleteScheduledPostResult = z.object({
  deleted: z.literal(true)
    .describe('Always true on a 200: a refused delete is a 409 scheduled_post_not_deleted, never a success body.'),
  activity_log: ACTIVITY_LOG,
}).passthrough();

// The queue READ drives a real browser dispatch (so not readOnly-pure) but
// mutates nothing - the linkedin-scraping convention, mirrored.
const QUEUE_READ = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

// Every verb here writes outward to LinkedIn under a real identity and spends a
// §9 write bucket, so destructiveHint is true. That is also the registry
// invariant for dangerous: true.
//
// The three creates ARE now undoable through this API (2026-08-20), which is a
// change of fact but not of hint: destructiveHint marks an outward write, and an
// undo is itself one. The undo spends the bucket of the create it reverses, and
// those buckets burst 2 so the pair fits back-to-back.
const DANGER = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const base = {
  service: 'linkedin',
  entity: 'linkedin_posting',
  mount: 'linkedin.content',
} as const;

export const linkedinPostingTools: ToolDefinition[] = [
  {
    ...base,
    name: 'create_linkedin_post',
    description:
      'Publish ONE feed post under the account\'s own identity (wire create-post). Public and irreversible through this API: there is no delete verb here. Identity-bound: linkedin_account_sid REQUIRED, spends the posting bucket (the tightest write limit, 1200 s between posts), saturation returns 429. text is REQUIRED as a key but may be an EMPTY string when an image is attached; a call with neither non-blank text nor an image is a 422. At most ONE image, base64 only, no fetch-by-url. Body and alt text are published byte for byte, blank lines included. Nothing is stored here: the response carries the published post (urn, url, time, the body LinkedIn kept) plus the activity-log row.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-posting/create-post' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      linkedin_account_sid: ACCOUNT_SID,
      text: z.string().max(3000)
        .describe('Post body, always present. Empty is legal ONLY alongside an image. 3000 is LinkedIn\'s own cap, refused here rather than burning a posting slot.'),
      images: z.array(LinkedinPostingImageValue).max(1).optional()
        .describe('At most one image. The wire refuses a second, so a longer array is a 422 here instead of a spent browser dispatch. The decoded bytes across all images must also stay under 35 MB in total; over that is a 422, because a bigger body is refused by the node\'s JSON parser as a bare 413 with no response envelope.'),
      visibility: LinkedinPostingVisibility.optional()
        .describe('ANYONE (the node default) or CONNECTIONS_ONLY. Omit to let the node apply its own default.'),
      allowed_commenters_scope: LinkedinPostingAllowedCommentersScope.optional()
        .describe('Who may comment: ALL (the node default), CONNECTIONS_ONLY, or NONE to disable comments.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), CreatePostResult),
    annotations: { title: 'Create LinkedIn post', ...DANGER },
  },
  {
    ...base,
    name: 'create_linkedin_comment',
    description:
      'Leave ONE outbound comment on any LinkedIn post, addressed by its post-thread URN in entity_urn (wire create-comment): member posts by urn:li:activity:<id>, company-page posts and newsletter issues by urn:li:ugcPost:<id>. Outward and fire-on-success: the post does NOT need to be tracked or owned by us, and nothing is persisted on this service. Identity-bound: linkedin_account_sid REQUIRED, spends the comment_posts bucket (30/day at a 360 s floor), saturation returns 429. Reply to an existing comment by passing parent_comment_urn. The comment text comes in text; templates and AI generation are outside this API. Returns the created comment ref plus the activity-log row. To react instead use react_linkedin_post; to read a post\'s existing comments and who wrote them use the linkedin-scraping get-post-comments tool (one read, both halves); to resolve a post URL to its activity URN use get_activity_urn_by_url.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-posting/comment' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    massAction: true,
    stepEligible: true,
    scheduleRequired: false,
    inputSchema: z.object({
      linkedin_account_sid: ACCOUNT_SID,
      entity_urn: ENTITY_URN,
      text: z.string().min(1).max(1250).describe('The comment body (caller-supplied, no templates or AI in-app).'),
      parent_comment_urn: z.string().max(512).nullable().optional()
        .describe('Reply target: the comment URN to reply under. Omit or null for a top-level comment.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), CommentResult),
    annotations: { title: 'Create LinkedIn comment', ...DANGER },
  },
  {
    ...base,
    name: 'react_linkedin_post',
    description:
      'Leave OUR reaction on any LinkedIn post, addressed by its post-thread URN in entity_urn (wire create-reaction): member posts by urn:li:activity:<id>, company-page posts and newsletter issues by urn:li:ugcPost:<id>. The social-selling counterpart of create_linkedin_comment, e.g. warm a prospect up by reacting to their post before a connect. Outward and fire-on-success: the post does NOT need to be tracked, and nothing is persisted on this service. Identity-bound: linkedin_account_sid REQUIRED, spends the react_posts bucket (30/day at a 360 s floor), saturation returns 429. Two different managed accounts reacting to the same post are two independent calls. Returns the activity-log row. To comment use create_linkedin_comment; to read who already reacted use the linkedin-scraping get-post-reactors tool.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-posting/react' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    massAction: true,
    stepEligible: true,
    scheduleRequired: false,
    inputSchema: z.object({
      linkedin_account_sid: ACCOUNT_SID,
      entity_urn: ENTITY_URN,
      reaction_type: z.enum(['like', 'celebrate', 'support', 'love', 'insightful', 'funny']).nullable().optional()
        .describe('The reaction to leave, mapped to the plugin wire ReactionType. Defaults to like.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), ReactResult),
    annotations: { title: 'React to LinkedIn post', ...DANGER },
  },
  {
    ...base,
    name: 'delete_linkedin_post',
    description:
      'Delete one of OUR OWN LinkedIn posts, addressed by activity_urn (wire delete-post). The counterpart of create_linkedin_post and the way to retract a post an agent published: pass the activity_urn that create_linkedin_post returned, or the post URL. LinkedIn only deletes the account\'s own posts and we do not pre-validate that. Identity-bound: linkedin_account_sid REQUIRED, spends the SAME posting bucket as publishing (5/day at a 1200 s floor, bursting 2 so a publish and its delete fit back-to-back), saturation returns 429. Backend urns (urn:li:share:, urn:li:ugcPost:) are NOT accepted here even though create_linkedin_post returns one: the wire builds its payload from the numeric activity id. A refusal - not your post, already gone - comes back as 409 post_not_deleted with LinkedIn\'s own toast in error.context, never as a success. Nothing is stored on this service, so nothing local is deleted either.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-posting/delete-post' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    massAction: false,
    stepEligible: false,
    scheduleRequired: false,
    inputSchema: z.object({
      linkedin_account_sid: ACCOUNT_SID,
      activity_urn: z.string().min(1).max(512)
        .describe('The post to delete: urn:li:activity:<id>, a bare numeric activity id, or a post URL carrying the id (converted locally, same rule as entity_urn on the write verbs). urn:li:share: / urn:li:ugcPost: are refused by the wire.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), DeletePostResult),
    annotations: { title: 'Delete LinkedIn post', ...DANGER },
  },
  {
    ...base,
    name: 'delete_linkedin_comment',
    description:
      'Delete one of OUR OWN LinkedIn comments, addressed by comment_urn (wire delete-comment). The counterpart of create_linkedin_comment. You already hold the handle: create_linkedin_comment returns comment_urn, and the linkedin-scraping get-post-comments rows carry the same compound urn, so a comment can be removed without any extra read. LinkedIn only deletes the account\'s own comments and we do not pre-validate that. Identity-bound: linkedin_account_sid REQUIRED, spends the SAME comment_posts bucket as commenting (30/day at a 360 s floor, bursting 2 so a comment and its delete fit back-to-back), saturation returns 429. Nothing is stored on this service.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-posting/delete-comment' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    massAction: false,
    stepEligible: false,
    scheduleRequired: false,
    inputSchema: z.object({
      linkedin_account_sid: ACCOUNT_SID,
      comment_urn: z.string().min(1).max(512)
        .describe('The comment to delete, as our comment readers return it: urn:li:comment:(<thread>,<id>) over any post family. The fsd form urn:li:fsd_comment:(<id>,<full thread urn>) that LinkedIn\'s own responses carry is accepted too and normalized on the wire side.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), DeleteCommentResult),
    annotations: { title: 'Delete LinkedIn comment', ...DANGER },
  },
  {
    ...base,
    name: 'unreact_linkedin_post',
    description:
      'Remove OUR reaction from a LinkedIn post or comment, addressed by the same entity_urn react_linkedin_post took (wire delete-reaction). Undo a reaction left by mistake or by a play that has been retargeted. Takes no reaction_type: LinkedIn holds at most one reaction per account per entity, so removal is unambiguous. Identity-bound: linkedin_account_sid REQUIRED, spends the SAME react_posts bucket as reacting (30/day at a 360 s floor, bursting 2 so a reaction and its removal fit back-to-back), saturation returns 429. Removing a reaction that was never there is not a documented success on the wire, so it comes back as 409 reaction_not_removed rather than a cheerful no-op.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-posting/unreact' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    massAction: false,
    stepEligible: false,
    scheduleRequired: false,
    inputSchema: z.object({
      linkedin_account_sid: ACCOUNT_SID,
      entity_urn: ENTITY_URN,
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), UnreactResult),
    annotations: { title: 'Remove LinkedIn reaction', ...DANGER },
  },
  {
    ...base,
    name: 'get_linkedin_scheduled_posts',
    description:
      "One page of the account's SCHEDULED-posts queue: drafts waiting for their publication time, each with post_urn, scheduled_at, text and LinkedIn's own error_message (wire get-scheduled-posts). A PRIVATE read - nobody on LinkedIn sees it - but it spends the one Content bucket, posting (20/day in series of 3 with a 1200 s pause; free plan 4/day), shared with publishing. Pass author_organization_id (the bare numeric company id) to read a COMPANY PAGE's queue the account administers instead of the member's own. Offset-paged: page_size 1-100 (default 20), pass paging.next_cursor back as cursor. rows[].post_urn is the exact handle delete_linkedin_scheduled_post takes. Scheduling itself is not exposed through this API yet - posts are scheduled in LinkedIn's own UI; this pair reads and cleans the queue.",
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-posting/get-scheduled-posts' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    stepEligible: false,
    scheduleRequired: false,
    inputSchema: z.object({
      linkedin_account_sid: ACCOUNT_SID,
      page_size: z.number().int().min(1).max(100).optional()
        .describe("Rows per page, the node's own [1, 100] gate. Defaults to 20."),
      cursor: z.string().min(1).max(200).optional()
        .describe('The previous page\'s paging.next_cursor, verbatim. Omit for the first page.'),
      author_organization_id: z.string().regex(/^\d+$/).max(30).optional()
        .describe("Read a company page's queue instead of the member's own: the bare numeric organization id (as in linkedin.com/company/<id>). The account must administer that page or the queue comes back empty."),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), GetScheduledPostsResult),
    annotations: { title: 'Get scheduled LinkedIn posts', ...QUEUE_READ },
  },
  {
    ...base,
    name: 'delete_linkedin_scheduled_post',
    description:
      "Delete one SCHEDULED (never published) post from the account's queue, addressed by the BACKEND urn get_linkedin_scheduled_posts returns as rows[].post_urn (wire delete-scheduled-post). NOT a variant of delete_linkedin_post: an unpublished share has no activity urn, and this verb runs a graphql mutation against the queue while delete-post drives an SDUI action on a live feed post - the two handles are not interchangeable. Spends the one Content bucket, posting (20/day in series of 3 with a 1200 s pause; free plan 4/day) - the same bucket publishing spends, sized so queue cleanup and publishing fit together. A refusal - not this account's draft, or already gone - comes back as 409 scheduled_post_not_deleted, never as a success.",
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-posting/delete-scheduled-post' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    massAction: false,
    stepEligible: false,
    scheduleRequired: false,
    inputSchema: z.object({
      linkedin_account_sid: ACCOUNT_SID,
      post_urn: z.string().min(1).max(512)
        .describe('The queued share to delete: urn:li:share:<id>, urn:li:ugcPost:<id> or urn:li:groupPost:<groupId>-<postId>, exactly as rows[].post_urn hands it back. The grammar is enforced on the wire.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), DeleteScheduledPostResult),
    annotations: { title: 'Delete scheduled LinkedIn post', ...DANGER },
  },
];
