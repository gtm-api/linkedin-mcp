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
  .describe('The post to comment on. A comment is written on the post\'s social thread, and LinkedIn refuses one sent to any other key (live 2026-09-16: the activity urn of a ugcPost company post answered linkedin_400, its ugcPost urn took the comment), so a post handle is re-addressed at its thread before the wire. urn:li:ugcPost:<id> and urn:li:groupPost:<groupId>-<postId> are the thread and go as is. urn:li:activity:<id> and urn:li:share:<id> cost one post read first (the read enrich_linkedin_post_details makes, on this account, cached 7 days): a share post is commented at its activity urn, a ugcPost post at its ugcPost urn, a repost without commentary at the original. A post the read returns null for (deleted, or not visible to the account) is refused 422 post_not_resolvable. To reply under a comment, pass parent_comment_urn (no post read then). A post URL works when the id is in it: the feed permalink, the /posts/<slug>-activity-<id>-<hash> share link, the -ugcPost-<id>- share link. A link WITHOUT an id (a shortlink, a bare slug URL) is refused 422 entity_urn_not_resolvable: call enrich_linkedin_get_activity_urn_by_url first. The post does NOT need to be tracked or owned by us. Renamed from activity_urn on 2026-07-30; the old name is no longer accepted.');

// react / unreact take the same handles as a comment, but a POST handle is
// re-addressed at the post's social thread before the wire (2026-09-16, live
// capture: a reaction sent to the activity urn of a ugcPost post answered success,
// a null reaction_urn, and landed nowhere).
const REACTION_ENTITY_URN = z.string().min(1).max(512)
  .describe('The post or comment to react on. LinkedIn files a reaction under the post\'s social thread and silently drops one sent to any other key (success, null reaction_urn, nothing lands: captured live on the activity urn of a ugcPost company post), so a post handle is re-addressed at its thread before the wire. urn:li:ugcPost:<id> and urn:li:groupPost:<groupId>-<postId> are the thread and go as is. urn:li:activity:<id> and urn:li:share:<id> cost one post read first (the read enrich_linkedin_post_details makes, on this account, cached 7 days): a share post is reacted on at its activity urn, a ugcPost post at its ugcPost urn, a repost without commentary at the original. A post the read returns null for (deleted, or not visible to the account) is refused 422 post_not_resolvable. A COMMENT key targets a comment and passes verbatim, either form: urn:li:comment:((activity|share|ugcPost|groupPost):<id>,<id>) or urn:li:fsd_comment:(<commentId>,<full thread urn>). A post URL works when the id is in it: the feed permalink, the /posts/<slug>-activity-<id>-<hash> share link, the -ugcPost-<id>- share link. A link WITHOUT an id (a shortlink, a bare slug URL) is refused 422 entity_urn_not_resolvable: call enrich_linkedin_get_activity_urn_by_url first. A malformed urn is refused 422 before any dispatch. The post does NOT need to be tracked or owned by us.');

// BREAKING, 2026-08-06: create-post went live and its reserved contract was
// rewritten to the node's express-validator chain, which disagreed with it in
// five ways (§ CONTRACT AUTHORITY: the wire is the contract, our reserved shape
// was a guess). `media` (up to 9 items, content_base64 XOR url) is gone with no
// alias: the wire member is `images` (at most ONE then, 20 since 2026-08-21),
// base64-only on the wire; the backend's own `url` arm (2026-09-16) downloads and
// converts before dispatch. `visibility` moved from lowercase to the wire's own
// uppercase vocabulary. `allowed_commenters_scope` and `images[].alt_text` were
// missing and are now taken. `text` may be EMPTY when an image is attached.
const LinkedinPostingVisibility = z.enum(['ANYONE', 'CONNECTIONS_ONLY']);

const LinkedinPostingAllowedCommentersScope = z.enum(['ALL', 'CONNECTIONS_ONLY', 'NONE']);

const LinkedinPostingImageValue = z.object({
  file_base64: z.string().min(1).optional()
    .describe('The image bytes of a PNG, JPEG, GIF or WEBP: a data:<mime>;base64,<...> URL or bare base64. Exactly one of file_base64 or url. Checked before anything is dispatched: a damaged file, a non-image or invalid base64 is a 422 on this member (image_corrupt / image_format_unrecognized / image_not_base64) and spends nothing. Base64 typed out by hand is the usual source of damage: prefer url.'),
  url: z.string().url().max(2048).optional()
    .describe('An https URL of the image file, downloaded by us (public hosts only, the same 35 MB post budget, typed and checked by content). Exactly one of file_base64 or url. A request_media_upload file_url works once its upload is done. A link to a web page that shows the image is refused (image_format_unrecognized); fetch problems are media_url_invalid / media_url_host_forbidden / media_url_fetch_failed / media_too_large.'),
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
  // The graphql mutation's resourceKey (2026-08-21); null when the response
  // shape drifted - the activity-log row stays the durable record.
  reaction_urn: z.string().nullable(),
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
// it is paced 2 s, not the bucket's delay, so the pair fits back to back.
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
    name: 'repost_linkedin_post',
    description:
      'Repost a LinkedIn post from one of the team accounts (wire create-instant-repost / create-repost-with-thoughts): ONE tool, the body picks which. Without text it is the plain repost (the feed\'s Repost button) and nothing else may be sent. With text it is a repost with your thoughts, a share of your own above the reposted post, which takes visibility, allowed_commenters_scope and mentions exactly as create_linkedin_post does. post_urn is the post being reposted as urn:li:activity, urn:li:share or urn:li:ugcPost (a group post cannot be reposted). Public and outward; retract with delete_linkedin_post on the answered activity_urn. Spends the posting bucket.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-posting/repost' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    pacedBucket: 'posting',
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      linkedin_account_sid: ACCOUNT_SID,
      post_urn: z.string().regex(/^urn:li:(activity|share|ugcPost):\d+$/).describe('The post to repost: urn:li:activity:<id>, urn:li:share:<id> or urn:li:ugcPost:<id>.'),
      text: z.string().max(3000).optional().describe('Your own words above the reposted post. Omit (or blank) for a plain repost.'),
      visibility: LinkedinPostingVisibility.optional().describe('With text only. ANYONE (the default) or CONNECTIONS_ONLY.'),
      allowed_commenters_scope: LinkedinPostingAllowedCommentersScope.optional().describe('With text only. ALL (the default), CONNECTIONS_ONLY, or NONE to disable comments.'),
      mentions: z.array(z.object({
        profile_id: z.string().min(1).describe('The mentioned member\'s profile id (ACoA... or urn:li:fsd_profile:<id>).'),
        start: z.number().int().min(0).describe('Offset of the mention in text, UTF-16 code units.'),
        length: z.number().int().min(1).describe('Length of the mention span in UTF-16 code units.'),
      })).optional().describe('With text only: profile mentions as ready positions over text, as create_linkedin_post takes them.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), z.object({
      kind: z.string().describe('instant (a plain repost) or with_thoughts (a share with your text).'),
      activity_urn: z.string().nullable().describe('The feed entry the repost became: what delete_linkedin_post takes.'),
      post_urn: z.string().nullable().describe('The publication: urn:li:instantRepost:(<root>,<id>) for a plain repost, the share (urn:li:ugcPost:<id> live, urn:li:share:<id> on older shares) for one with thoughts.'),
      url: z.string().nullable().describe('Public URL of the repost, query string stripped.'),
      created_at: z.string().nullable().describe('ISO 8601.'),
      text: z.string().describe('The commentary LinkedIn published; empty for a plain repost.'),
      parent_post_urn: z.string().nullable().describe('The backend urn (share / ugcPost) that was reposted.'),
      message: z.string().nullable().describe('The plain repost\'s success toast, when LinkedIn showed one.'),
      activity_log: ACTIVITY_LOG,
    }).passthrough()),
    annotations: { title: 'Repost LinkedIn post', ...DANGER },
  },
  {
    ...base,
    name: 'create_linkedin_post',
    description:
      'Publish ONE feed post - as the member, AS a company page it administers (author_organization_id), or INTO a group (group_id) - now or scheduled (scheduled_at) - wire create-post. Public; retract with delete_linkedin_post, or delete a scheduled draft with delete_linkedin_scheduled_post. Identity-bound: linkedin_account_sid REQUIRED, spends the posting bucket (20/day in series of 3 at a 1200 s pause; free plan 4), saturation returns 429. text is REQUIRED as a key but may be an EMPTY string when media is attached; no text, images or video at all is a 422. Media: up to 20 images XOR one video, each base64 or an https url (see request_media_upload), 35 MB total. Body and alt text publish byte for byte, blank lines included. mentions makes spans of text clickable profile links (positions in UTF-16 code units); brand_partnership adds the "Brand partnership" flag; group_id excludes visibility. Nothing is stored here: the response carries the published post (urn, url, time, body) plus the activity-log row.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-posting/create-post' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    pacedBucket: 'posting',
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      linkedin_account_sid: ACCOUNT_SID,
      text: z.string().max(3000)
        .describe('Post body, always present. Empty is legal ONLY alongside an image. 3000 is LinkedIn\'s own cap, refused here rather than burning a posting slot.'),
      images: z.array(LinkedinPostingImageValue).max(20).optional()
        .describe('Up to 20 images (the node\'s own cap; array order = carousel order). Mutually exclusive with video. The decoded bytes across ALL media must stay under 35 MB in total; over that is a 422, because a bigger body is refused by the node\'s JSON parser as a bare 413 with no response envelope. For 2+ images the backend supplies the account\'s own member id to the wire itself - no profile_id field exists here. Uploads are sequential node-side, so many large images make a SLOW synchronous call - the post can publish even if your client times out first, so do not blind-retry a timeout (a duplicate public post is the cost).'),
      visibility: LinkedinPostingVisibility.optional()
        .describe('ANYONE (the node default) or CONNECTIONS_ONLY. Omit to let the node apply its own default. Mutually exclusive with group_id.'),
      allowed_commenters_scope: LinkedinPostingAllowedCommentersScope.optional()
        .describe('Who may comment: ALL (the node default), CONNECTIONS_ONLY, or NONE to disable comments. Works on group posts too.'),
      video: z.object({
        file_base64: z.string().min(1).optional()
          .describe('The video bytes: a data:<mime>;base64,<...> URL or bare base64. Exactly one of file_base64 or url.'),
        url: z.string().url().max(2048).optional()
          .describe('An https URL of an MP4, MOV or WEBM file, downloaded by us (public hosts only, within the 35 MB budget). Exactly one of file_base64 or url; a request_media_upload file_url works once uploaded.'),
        file_byte_size: z.number().int().min(1).nullable().optional(),
        file_name: z.string().min(1).max(255).nullable().optional(),
        file_type: z.string().min(1).max(255).nullable().optional(),
      }).optional()
        .describe('ONE video, image-shaped minus alt_text. Mutually exclusive with images (LinkedIn does not mix them in a share - 422 here). Shares the 35 MB media budget. The upload is a single large PUT through the browser and is SLOW: the synchronous call can outlive your client timeout while the post still publishes - do not blind-retry.'),
      scheduled_at: z.string().optional()
        .describe('Schedule the post instead of publishing now: ISO 8601 with timezone, must be in the future (a strictly-past time is a 422; within a minute of now is passed through for LinkedIn to judge). A SCHEDULED share legitimately answers with null activity_urn/url - post_urn is the handle. Read and clean the queue with get_linkedin_scheduled_posts / delete_linkedin_scheduled_post. Scheduling is LinkedIn-side: the draft lives in ITS queue, nothing is stored here.'),
      mentions: z.array(z.object({
        profile_id: z.string().min(1)
          .describe('Who to mention: a bare ACoA… profile id or the full urn:li:fsd_profile:<id>.'),
        start: z.number().int().min(0)
          .describe('Span start in text, in UTF-16 code units (JS String offsets).'),
        length: z.number().int().min(1)
          .describe('Span length in UTF-16 code units. start+length must fit inside text - out of bounds is a 422 here, not a spent dispatch.'),
      })).optional()
        .describe('Profile mentions as READY POSITIONS over text (2026-08-21) - unlike create_linkedin_comment\'s {profile_id, name} search pairs. Require non-blank text.'),
      brand_partnership: z.boolean().optional()
        .describe('true adds LinkedIn\'s "Brand partnership" label (paid endorsement). false and absent both send nothing - the wire\'s own shape.'),
      author_organization_id: z.string().regex(/^\d+$/).optional()
        .describe('Post AS a company page the account administers: the bare numeric company id (same form get_linkedin_company_posts takes). Omit to post as the member.'),
      group_id: z.string().regex(/^\d+$/).optional()
        .describe('Post INTO a group: the bare numeric group id. Mutually exclusive with visibility - a group post sets container visibility, not member-feed visibility.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), CreatePostResult),
    annotations: { title: 'Create LinkedIn post', ...DANGER },
  },
  {
    ...base,
    name: 'create_linkedin_comment',
    description:
      'Leave ONE outbound comment on any LinkedIn post (wire create-comment): entity_urn takes a post urn in any family or a post URL carrying one, and the comment is written on the post\'s social thread, which an activity or share urn costs one cached post read to name (see entity_urn). Outward and fire-on-success: the post does NOT need to be tracked or owned by us; nothing is persisted here. Identity-bound: linkedin_account_sid REQUIRED, spends the comment_posts bucket (30/day at a 360 s floor), saturation returns 429. Reply to an existing comment via parent_comment_urn. mentions turns exact substrings of text into clickable profile links ({profile_id, name} pairs, matched left to right in list order - a name missing or out of order is a 422 with no dispatch spent). Returns the created comment ref plus the activity-log row. To react use react_linkedin_post; to read a post\'s comments and who wrote them use the scraping get-post-comments tool; to resolve a post URL use get_activity_urn_by_url.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-posting/comment' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    pacedBucket: 'comment_posts',
    massAction: true,
    stepEligible: true,
    scheduleRequired: false,
    inputSchema: z.object({
      linkedin_account_sid: ACCOUNT_SID,
      entity_urn: ENTITY_URN,
      text: z.string().min(1).max(1250).describe('The comment body (caller-supplied, no templates or AI in-app).'),
      parent_comment_urn: z.string().max(512).nullable().optional()
        .describe('Reply target: the comment URN to reply under. Omit or null for a top-level comment.'),
      mentions: z.array(z.object({
        profile_id: z.string().min(1)
          .describe('Who to mention: a bare ACoA… profile id (as get-post-comments and the profile readers return) or the full urn:li:fsd_profile:<id>.'),
        name: z.string().min(1)
          .describe('The exact substring of text that becomes the clickable link (usually the profile name).'),
      })).optional()
        .describe('Profile mentions (2026-08-21). Names are matched in text left to right in list order, each search starting after the previous mention. The node computes the character offsets itself.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), CommentResult),
    annotations: { title: 'Create LinkedIn comment', ...DANGER },
  },
  {
    ...base,
    name: 'react_linkedin_post',
    description:
      'Leave OUR reaction on any LinkedIn post OR comment (wire create-reaction): entity_urn takes a post urn in any family, a post URL carrying one, or a comment urn. A post is reacted on at its social thread; an activity or share urn costs one cached post read to name it (see entity_urn). The social-selling counterpart of create_linkedin_comment. Outward and fire-on-success: the post does NOT need to be tracked, nothing is persisted here. Identity-bound: linkedin_account_sid REQUIRED, spends the react_posts bucket (30/day at a 360 s floor), saturation returns 429. Returns reaction_urn (the reaction\'s key, naming the entity it landed on; null on drift or when LinkedIn ignored it) plus the activity-log row. interested is the EVENT-post reaction: ordinary posts silently ignore it (success envelope, null reaction_urn, nothing lands - verified live), so a null urn after an interested react is the no-op tell. To comment use create_linkedin_comment; to read who already reacted use the scraping get-post-reactors tool.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-posting/react' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    pacedBucket: 'react_posts',
    massAction: true,
    stepEligible: true,
    scheduleRequired: false,
    inputSchema: z.object({
      linkedin_account_sid: ACCOUNT_SID,
      entity_urn: REACTION_ENTITY_URN,
      reaction_type: z.enum(['like', 'celebrate', 'support', 'love', 'insightful', 'funny', 'interested']).nullable().optional()
        .describe('The reaction to leave, mapped to the plugin wire ReactionType. Defaults to like. interested (wire MAYBE) works on EVENT posts; ordinary posts silently ignore it (null reaction_urn back).'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), ReactResult),
    annotations: { title: 'React to LinkedIn post', ...DANGER },
  },
  {
    ...base,
    name: 'delete_linkedin_post',
    description:
      'Delete one of OUR OWN LinkedIn posts, addressed by activity_urn (wire delete-post). The counterpart of create_linkedin_post and the way to retract a post an agent published: pass the activity_urn that create_linkedin_post returned, or the post URL. LinkedIn only deletes the account\'s own posts and we do not pre-validate that. Identity-bound: linkedin_account_sid REQUIRED, spends the SAME posting bucket as publishing (20/day in series of 3 at a 1200 s pause; free plan 4 - the series is what lets a publish and its delete fit back-to-back), saturation returns 429. Backend urns (urn:li:share:, urn:li:ugcPost:) are NOT accepted here even though create_linkedin_post returns one: the wire builds its payload from the numeric activity id. A refusal - not your post, already gone - comes back as 409 post_not_deleted with LinkedIn\'s own toast in error.context, never as a success. Nothing is stored on this service, so nothing local is deleted either.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-posting/delete-post' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    pacedBucket: 'posting',
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
      'Delete one of OUR OWN LinkedIn comments, addressed by comment_urn (wire delete-comment). The counterpart of create_linkedin_comment. You already hold the handle: create_linkedin_comment returns comment_urn, and the linkedin-scraping get-post-comments rows carry the same compound urn, so a comment can be removed without any extra read. LinkedIn only deletes the account\'s own comments and we do not pre-validate that. Identity-bound: linkedin_account_sid REQUIRED, spends the SAME comment_posts bucket as commenting (30/day), but an undo is paced 2 s, not the bucket delay, so a comment and its delete fit back to back; saturation returns 429. Nothing is stored on this service.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-posting/delete-comment' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    pacedBucket: 'comment_posts',
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
      'Remove OUR reaction from a LinkedIn post or comment, addressed by the same entity_urn react_linkedin_post took (wire delete-reaction). Undo a reaction left by mistake or by a play that has been retargeted. Takes no reaction_type: LinkedIn holds at most one reaction per account per entity, so removal is unambiguous. Identity-bound: linkedin_account_sid REQUIRED, spends the SAME react_posts bucket as reacting (30/day), but an undo is paced 2 s, not the bucket delay, so a reaction and its removal fit back to back; saturation returns 429. A post is addressed at its social thread exactly like react_linkedin_post, so undoing with the value you reacted with removes the reaction that landed. removed: true means LinkedIn accepted the delete, not that a reaction existed (a delete with nothing to remove answered true live, 2026-09-16); a refused removal comes back 409 reaction_not_removed.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-posting/unreact' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    pacedBucket: 'react_posts',
    massAction: false,
    stepEligible: false,
    scheduleRequired: false,
    inputSchema: z.object({
      linkedin_account_sid: ACCOUNT_SID,
      entity_urn: REACTION_ENTITY_URN,
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
    pacedBucket: 'posting',
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
    pacedBucket: 'posting',
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
