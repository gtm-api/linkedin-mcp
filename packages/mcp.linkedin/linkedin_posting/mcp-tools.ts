// Entity: LinkedIn Posting (gtm.service.linkedin)
// Source of truth: product/research/gtm.service.linkedin/entities/linkedin_posting.md
// Format: registry v2, each tool carries route metadata so the generic
// dispatcher can drive it. 3 tools (the linkedin-posting route group), mounted
// on linkedin.content.
//
// This is the stateless content-AUTHORING surface: no table, no Domain, no
// events. Each action dispatches the matching plugin wire verb on the account's
// browser under its §9 write bucket (identity-bound, non-creditable, so
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
// linkedin-scraping (get-post-comments / -commenters / -reactors / -resharers)
// and linkedin-enrichment (post-details).

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import { usageMetaField, McpActionResponse } from '@gtm/mcp-shared';

const ACCOUNT_SID = z.string().length(18).startsWith('ln_ac_')
  .describe('LinkedIn account sid (ln_ac_…), the authoring account. Identity-bound and non-creditable: REQUIRED, never a pool account.');

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
  .describe('The post handle: urn:li:activity:<id> for a member post, or urn:li:ugcPost:<id> for a company-page post or a newsletter issue (LinkedIn threads those as ugcPost, not activity). Either form is passed to the wire verbatim. The post does NOT need to be tracked or owned by us. Resolve a linkedin.com post URL first with get_activity_urn_by_url. Renamed from activity_urn on 2026-07-30; the old name is no longer accepted.');

const FORCE_DEDUP = z.boolean().nullable().optional()
  .describe('Accepted for contract compatibility and NOT enforced by this service today: per-post dedup left with the content trio (gs.service.signals). Passing it changes nothing.');

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

const ReactResult = z.object({
  activity_log: ACTIVITY_LOG,
}).passthrough();

// All three verbs write outward to LinkedIn under a real identity, spend a §9
// write bucket, and cannot be undone through this API, so destructiveHint is
// true. That is also the registry invariant for dangerous: true.
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
      'Publish ONE feed post under the account\'s own identity (wire create-post). Public and irreversible through this API: there is no delete verb here. Identity-bound and non-creditable: linkedin_account_sid REQUIRED, spends the posting bucket (the tightest write limit, 1200 s between posts), saturation returns 429 with no pool fallback. text is REQUIRED as a key but may be an EMPTY string when an image is attached; a call with neither non-blank text nor an image is a 422. At most ONE image, base64 only, no fetch-by-url. Body and alt text are published byte for byte, blank lines included. Nothing is stored here: the response carries the published post (urn, url, time, the body LinkedIn kept) plus the activity-log row.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-posting/create-post' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      linkedin_account_sid: ACCOUNT_SID,
      text: z.string().max(3000)
        .describe('Post body, always present. Empty is legal ONLY alongside an image. 3000 is LinkedIn\'s own cap, refused here rather than burning a posting slot.'),
      images: z.array(LinkedinPostingImageValue).max(1).optional()
        .describe('At most one image. The wire refuses a second, so a longer array is a 422 here instead of a spent browser dispatch.'),
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
      'Leave ONE outbound comment on any LinkedIn post, addressed by its post-thread URN in entity_urn (wire create-comment): member posts by urn:li:activity:<id>, company-page posts and newsletter issues by urn:li:ugcPost:<id>. Outward and fire-on-success: the post does NOT need to be tracked or owned by us, and nothing is persisted on this service. Identity-bound and non-creditable: linkedin_account_sid REQUIRED, spends the messaging_general bucket, saturation returns 429 with no pool fallback. Reply to an existing comment by passing parent_comment_urn. The comment text comes in text; templates and AI generation are outside this API. Returns the created comment ref plus the activity-log row. To react instead use react_linkedin_post; to read a post\'s existing comments or commenters use the linkedin-scraping get-post-comments / get-post-commenters tools; to resolve a post URL to its activity URN use get_activity_urn_by_url.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-posting/comment' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    creditable: false,
    massAction: true,
    scheduleRequired: false,
    inputSchema: z.object({
      linkedin_account_sid: ACCOUNT_SID,
      entity_urn: ENTITY_URN,
      text: z.string().min(1).max(1250).describe('The comment body (caller-supplied, no templates or AI in-app).'),
      parent_comment_urn: z.string().max(512).nullable().optional()
        .describe('Reply target: the comment URN to reply under. Omit or null for a top-level comment.'),
      force_dedup: FORCE_DEDUP,
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), CommentResult),
    annotations: { title: 'Create LinkedIn comment', ...DANGER },
  },
  {
    ...base,
    name: 'react_linkedin_post',
    description:
      'Leave OUR reaction on any LinkedIn post, addressed by its post-thread URN in entity_urn (wire create-reaction): member posts by urn:li:activity:<id>, company-page posts and newsletter issues by urn:li:ugcPost:<id>. The social-selling counterpart of create_linkedin_comment, e.g. warm a prospect up by reacting to their post before a connect. Outward and fire-on-success: the post does NOT need to be tracked, and nothing is persisted on this service. Identity-bound and non-creditable: linkedin_account_sid REQUIRED, spends the messaging_general bucket, saturation returns 429 with no pool fallback. Two different managed accounts reacting to the same post are two independent calls. Returns the activity-log row. To comment use create_linkedin_comment; to read who already reacted use the linkedin-scraping get-post-reactors tool.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-posting/react' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    creditable: false,
    massAction: true,
    stepEligible: true,
    scheduleRequired: false,
    inputSchema: z.object({
      linkedin_account_sid: ACCOUNT_SID,
      entity_urn: ENTITY_URN,
      reaction_type: z.enum(['like', 'celebrate', 'support', 'love', 'insightful', 'funny']).nullable().optional()
        .describe('The reaction to leave, mapped to the plugin wire ReactionType. Defaults to like.'),
      force_dedup: FORCE_DEDUP,
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), ReactResult),
    annotations: { title: 'React to LinkedIn post', ...DANGER },
  },
];
