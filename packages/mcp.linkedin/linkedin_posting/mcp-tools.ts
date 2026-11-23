// Entity: LinkedIn Posting (gtm.service.linkedin)
// Source of truth: product/research/gtm.service.linkedin/entities/linkedin_posting.md
// Format: registry v2, each tool carries route metadata so the generic
// dispatcher can drive it. 18 tools (the linkedin-posting route group), mounted
// on linkedin.content: four writes (create-post, repost, comment, react), the
// undo of each (delete-post takes a post and a repost), the scheduled-posts queue
// pair (a private read + a draft delete, 2026-08-21), check-sent (2026-10-05),
// the article family (2026-11-21: create-article, update-article, publish-article,
// get-articles, get-article, delete-article, get-newsletters; LinkedIn's long-form
// posts and newsletter issues, as drafts, scheduled shares or published, as the
// member or as a company page) and get-administered-companies (2026-11-22: the
// company pages the account may publish as, the source of every
// author_organization_id on this surface).
//
// This is the stateless content-AUTHORING surface: no table, no Domain, no
// events. Each action dispatches the matching plugin wire verb on the account's
// browser under its §9 write bucket (identity-bound, so
// linkedin_account_sid is REQUIRED and there is no §9.5 pool fallback) and
// returns the resulting activity ref plus the linkedin-account-activity-log row
// per §4.12a. Nothing is persisted here but that row: since round 5 of one key,
// one send (2026-10-05) what a comment, a post or a repost made is kept on it, so
// a repeat under the send's key is answered with it.
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
  .describe('The post to comment on. A comment is written on the post\'s social thread, and LinkedIn refuses one sent to any other key (live 2026-09-16: the activity urn of a ugcPost company post answered linkedin_400, its ugcPost urn took the comment), so a post handle is re-addressed at its thread before the wire. urn:li:ugcPost:<id> and urn:li:groupPost:<groupId>-<postId> are the thread and go as is. urn:li:activity:<id> and urn:li:share:<id> cost one post read first (the read enrich_linkedin_post_details makes, on this account, cached 7 days): a share post is commented at its activity urn, a ugcPost post at its ugcPost urn, a repost without commentary at the original. A post the read returns null for (deleted, or not visible to the account) is refused 422 post_not_resolvable. To reply under a comment, pass parent_comment_urn (no post read then); a comment urn given here is a reply under that comment too. A post URL works when the id is in it: the feed permalink, the /posts/<slug>-activity-<id>-<hash> share link, the -ugcPost-<id>- share link. A link WITHOUT an id (a shortlink, a bare slug URL) is refused 422 entity_urn_not_resolvable: call enrich_linkedin_get_activity_urn_by_url first. The post does NOT need to be tracked or owned by us. Renamed from activity_urn on 2026-07-30; the old name is no longer accepted.');

// ─── One key, one send (product KNOWLEDGE §4.9a; gtm.service.linkedin 06a879a, round 5) ───
//
// comment, create-post and repost are under the rule the message sends follow
// (linkedin_messages): under a client_reference the key and its place are ONE
// comment, post or repost, whatever its words say; a repeat is answered with
// what the first send made and never goes out twice. The places: a comment's is
// the post's thread as LinkedIn files it (any urn of the post names it), a
// reply's the comment it answers, a repost's the post it reposts; a post's is
// where it lands (its author's feed, a company page, a group), and its slot
// never splits a key. Without a key the same words at the same place are a
// repeat for an hour after they went out (a post's pictures, video or document too). A
// lost answer is a 409 send_outcome_unknown naming send_decisive_at (a 503
// "retry shortly" before round 5), and LinkedIn is read for the send: the post's
// comments, the account's own comments or feed, a page's feed (it shows a page
// post or proves nothing), the queue of scheduled posts. A group's feed has no
// read, so a group post in doubt waits for a person. react stays outside the
// rule: LinkedIn keeps one reaction per account and post, so a repeat changes
// nothing. check_linkedin_posting_sent asks without sending.
//
// 2026-11-09: a comment made as a company page (author_organization_id) is
// another comment than the member's at the same place, under one key or the
// same words. No read shows a comment as the page's, so a page comment in doubt
// waits for a person, as a group post does.
//
// 2026-11-21: an article's share is under the rule too. create-article with
// state SCHEDULED or PUBLISHED and publish-article take the key (the share is a
// post where it lands: the member's feed or the page's, its slot no part of the
// key, as create-post's); a DRAFT create refuses it, because a draft is in front
// of nobody and a key on it would be a promise the outcome machinery cannot
// keep. update-article and delete-article are keyless like the other undos.
const postingKey = (what: string, place: string, keyless: string) => z.string().max(255).nullable().optional()
  .describe(`Your key for this ONE ${what} (max 255, byte for byte): one key per ${what}, the same key on every repeat of it. The key and its place (${place}) are one ${what} whatever it says, and a repeat never goes out twice: it answers 200 with what the first send made (result.idempotent_replay, result.content_differs when this request says something else) or 409 naming error.context.send_outcome (in_flight, unknown with retry_after and send_decisive_at, or sent; not_sent with blocking_activity_log_sid when another ${what} in doubt holds the place). The same key at another place is another ${what}. Without a key ${keyless} count as a repeat for an hour after they went out. check_linkedin_posting_sent asks by it.`);

const CONFIRMED_NOT_SENT = z.string().length(18).startsWith('ln_al_').nullable().optional()
  .describe("A person's word that an earlier attempt of THIS send is not on LinkedIn: its activity_log_sid (ln_al_...), from the 409 or check_linkedin_posting_sent, given only after someone looked on LinkedIn. Taken once the attempt can no longer land (before that: 409 send_outcome_unknown, waiting_for may_still_land, retry_after and send_decisive_at that moment): it settles that attempt not_sent and this request goes out. Moot when the attempt is no longer in doubt; another send's sid is 422 not_this_message.");

const CONFIRMED_SENT = z.string().length(18).startsWith('ln_al_').nullable().optional()
  .describe("A person's word that an earlier attempt of THIS send IS on LinkedIn: its activity_log_sid, as for confirmed_not_sent (never both). Taken at once; it settles the attempt sent and sends nothing: the answer is 409 concurrent_send_in_flight with send_outcome sent while what it made is not known (LinkedIn is read for it), or 200 with it once a read has found it. Another send's sid is 422 not_this_message; an attempt already proved not sent is 409 confirmed_sent_contradicts.");

/** The one sentence every keyed posting tool's description carries about sending once. */
const sendOnce = (place: string) =>
  `Sends once per client_reference and ${place}: a repeat is answered, never sent twice; on a 409 read error.context.send_outcome, never resend under a new key.`;

// What a comment, a post or a repost made, as check-sent answers it (the verb's
// own answer shape, kept on the attempt as send_details.result): open, since the
// three verbs answer three shapes and a look fills in what it can read.
const PostingSendItem = z.object({
  comment_urn: z.string().nullable().optional().describe('A comment or a reply: the comment it made.'),
  kind: z.string().optional().describe('A repost: instant or with_thoughts.'),
  activity_urn: z.string().nullable().optional().describe('A post or a repost: its feed entry.'),
  post_urn: z.string().nullable().optional().describe('A post or a repost: the publication.'),
  url: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
  text: z.string().optional(),
  parent_post_urn: z.string().nullable().optional().describe('A repost: the post it reposted.'),
  article: z.object({}).passthrough().nullable().optional().describe('An article share: the article read back after it (article_id, state, post_urn, scheduled_at).'),
  post: z.object({}).passthrough().nullable().optional().describe('An article share: the share itself (post_urn; activity_urn and url when published now).'),
}).passthrough()
  .describe('What the send made, in the shape its own verb answers: a comment the comment_urn; a post its urns, url, time and body; a repost its kind, urns, url, time, body and the reposted post; an article share its article and post.');

// check-sent's `result` (LinkedinSendCheckResult::toResult, the shape every family
// answers; the S1 candidates, attempts of a build that kept no key, were removed on
// 2026-10-06): outcome and reason always; retry_after, activity_log_sid and send_decisive_at when known.
// Plain strings rather than z.enum: the values are the service's constants, and
// no PHP enum backs them for the enum-parity gate to pin.
const CheckSentResult = z.object({
  outcome: z.string()
    .describe('sent | not_sent | in_flight | unknown. Send the same request again only on not_sent; on in_flight or unknown ask again after retry_after.'),
  reason: z.string().nullable()
    .describe('Why. sent: null (item is what it made), result_pending (it went out, what it made is read later), caller_confirmed (a person said so; no item). not_sent: no_send_under_key, refused, not_on_linkedin, caller_confirmed. unknown: answer_lost, may_still_land, unreadable, unexplained, unprovable (a group post, a page post its page has not shown, or a comment made as a company page: no read can prove any of them absent).'),
  retry_after: z.string().optional()
    .describe('ISO 8601: for a send in doubt, when LinkedIn is read for it next.'),
  activity_log_sid: z.string().optional()
    .describe('The attempt the answer is about (in flight, in doubt or landed): what confirmed_not_sent / confirmed_sent name on the comment, post and repost tools.'),
  send_decisive_at: z.string().optional()
    .describe("ISO 8601: the moment a send in doubt can no longer land; a person's confirmed_not_sent is taken from then on. A plain repost carries no deadline of its own, so it is an hour after its answer was lost."),
}).passthrough();

// The form check-sent takes a post's place in (InternalLinkedinPostingCheckSentRequest::POST_PLACE_PATTERN, gtm.lib.common 37961fc; article:<id> for publish-article since 2026-11-22).
const POST_PLACE_RE = /^(?:feed:member|feed:org:\d+|group:\d+(?::org:\d+)?|article:\d+)(?::scheduled:\d+)?$/;

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

// One PDF: LinkedIn's document post (2026-11-06; the capture and what was measured
// live are in linkedinApiSdk/src/posts/createPostDocumentExample.ts). There is no
// file_type and no file_byte_size: it is PDF only, and the size always comes from
// the decoded bytes. The title is LinkedIn's rule: a share without one creates
// nothing. No upload slot holds a PDF (a PDF slot is refused while that bucket is
// public), so the url arm means any public https address. A document into a group
// is not verified on the wire.
const LinkedinPostingDocumentValue = z.object({
  title: z.string().min(1)
    .describe('The title LinkedIn shows on the document. Required and never blank: LinkedIn creates nothing without one, so a blank title is a 422 here.'),
  file_base64: z.string().min(1).optional()
    .describe('The PDF bytes: a data:application/pdf;base64,<...> URL or bare base64. Exactly one of file_base64 or url. Typed by content before anything is dispatched: anything but a PDF is a 422 on this member (document_format_unrecognized). Base64 typed out by hand is the usual source of damage: prefer url, or have a tool encode the file.'),
  url: z.string().url().max(2048).optional()
    .describe('An https URL of the PDF file, downloaded by us (public hosts only, the same 35 MB post budget, typed by content). Exactly one of file_base64 or url. A request_media_upload file_url does not hold a PDF, so a local PDF needs a public https url of your own or base64 from a tool. A link to a web page that shows the PDF is refused (document_format_unrecognized); fetch problems are media_url_invalid / media_url_host_forbidden / media_url_fetch_failed / media_too_large.'),
  file_name: z.string().min(1).max(255).optional()
    .describe('The name the file is uploaded under. Its extension and alphabet do not matter to LinkedIn; omit it and one is supplied.'),
});

// One mention of a post: a member OR a company page, exactly one of the two ids
// per entry (the backend refuses both and neither, as the node's builder does).
// A company page (2026-10-29) rides as LinkedIn's companyName text attribute;
// a member as profileMention. Shared by create_linkedin_post and the repost
// with thoughts, which takes create-post's mentions word for word.
const LinkedinPostingMention = z.object({
  profile_id: z.string().min(1).optional()
    .describe('A member to mention: a bare ACoA… profile id or the full urn:li:fsd_profile:<id>. Exactly one of profile_id or company_id.'),
  company_id: z.string().min(1).optional()
    .describe('A company page to mention: the bare numeric company id (same form get_linkedin_company_posts takes) or the full urn:li:fsd_company:<id>. Exactly one of profile_id or company_id.'),
  start: z.number().int().min(0)
    .describe('Span start in text, in UTF-16 code units (JS String offsets).'),
  length: z.number().int().min(1)
    .describe('Span length in UTF-16 code units. start+length must fit inside text - out of bounds is a 422 here, not a spent dispatch.'),
});

// ─── The article family (2026-11-21) ───
//
// An article is LinkedIn's long-form post (urn:li:fsd_firstPartyArticle:<id>,
// the editor at /article/new/), public at /pulse/<permalink> once published. Its
// publication is a SHARE (urn:li:ugcPost:<id>) whose media is the article, so a
// scheduled article is a scheduled share and LinkedIn's own queue
// (get_linkedin_scheduled_posts) lists it as a post. A newsletter is a
// urn:li:fsd_contentSeries:<id> the member or a page owns, and an issue is an
// article whose series is that newsletter. What was captured: the owner's HARs of
// 2026-11-21 (Melnikov's member and page articles, Fabian's page newsletter);
// what was probed live the same day: the one-shot create, the scheduled share
// with an empty commentary, the single read answering no scheduledAt, the share
// delete leaving the article behind, the restli DELETE, latestDraftById on every
// state, the reader by url (wire facts §6 and §7). Not probed: publishing now
// through this surface (the owner's rule: scheduled variants only).
//
// The ids on this surface are the DIGITS of the urns (as company_id is the
// digits of a company urn). The backend takes the urn too and normalizes it
// before the dispatch (TakesArticleIds, design D4), so the two patterns below are
// its regex rules character for character; request-parity holds them against the
// FormRequest, and the public spec carries them as `pattern`.
const ARTICLE_ID_RE = /^(?:urn:li:fsd_firstPartyArticle:)?\d{1,20}$/;
const NEWSLETTER_ID_RE = /^(?:urn:li:fsd_contentSeries:)?\d{1,20}$/;
// A pulse link on any linkedin.com host (a locale host like de.linkedin.com is
// one too); the permalink may be percent-encoded (probe F8), and nothing after a
// query or a fragment is read into it (LinkedinPostingGetArticleRequest::PULSE_URL_PATTERN).
const PULSE_URL_RE = /^https:\/\/(?:[a-z0-9-]+\.)?linkedin\.com\/pulse\/[^\s?#]+/i;

const ARTICLE_ID = z.string().regex(ARTICLE_ID_RE)
  .describe('The article: the digits of urn:li:fsd_firstPartyArticle:<id>, exactly as every article row answers article_id, or that urn.');

// The wire's own read vocabulary (ARTICLE_STATES in the SDK's articleValues.ts,
// LinkedinPostingCreateArticleRequest::STATES): the write sends AUTOSAVED and a
// read answers DRAFT, so AUTOSAVED never appears on this surface. Closed on both
// sides (Rule::in on the backend), which is what resolves it for enum-parity.
const LinkedinPostingArticleState = z.enum(['DRAFT', 'SCHEDULED', 'PUBLISHED']);

// The cover picture of an article (TakesArticleContent::coverImageRules, mirrored
// bound for bound). Image-shaped like LinkedinPostingImageValue, but a schema of
// its own: it carries a caption (the wire's caption.text) in place of alt_text,
// and its file members are not nullable, because request-parity holds every key
// against the FormRequest's enumerated children and alt_text is not one of them.
// Uploaded as PUBLISHING_COVER_IMAGE on LinkedIn's media endpoint.
const LinkedinPostingArticleCoverImage = z.object({
  file_base64: z.string().min(1).optional()
    .describe('The picture bytes of a PNG, JPEG, GIF or WEBP: a data:<mime>;base64,<...> URL or bare base64. Exactly one of file_base64 or url. Checked before anything is dispatched (image_corrupt / image_format_unrecognized / image_not_base64 are 422s on this member). Base64 typed out by hand is the usual source of damage: prefer url.'),
  url: z.string().url().max(2048).optional()
    .describe('An https URL of the picture, downloaded by us (public hosts only, within the 35 MB article media budget the inline pictures share, typed by content). Exactly one of file_base64 or url. A request_media_upload file_url works once its upload is done.'),
  file_byte_size: z.number().int().min(1).optional(),
  file_name: z.string().min(1).optional(),
  file_type: z.string().min(1).optional(),
  caption: z.string().max(1000).nullable().optional()
    .describe('The caption shown under the cover; empty is what LinkedIn\'s editor sends for none.'),
});

// The §4.12a dispatch row (linkedin-account-activity-log). Kept open rather than
// re-declaring LinkedinAccountActivityLogDomain here: that Domain is owned by
// packages/mcp.linkedin/linkedin_account_activity_log, and this file owns no entity.
const ACTIVITY_LOG = z.object({}).passthrough()
  .describe('Full dispatch row (linkedin-account-activity-log) per §4.12a. Poll it there by sid for the terminal outcome.');

const CreatePostResult = z.object({
  activity_urn: z.string().nullable().describe('The published post as an activity urn. Null for a scheduled post, and for a video or document post LinkedIn had not finished processing within the node\'s ~15 s read-back (lifecycle_state MEDIA_PROCESSING): read it later with enrich_linkedin_post_details by post_urn.'),
  post_urn: z.string().nullable().describe('The same post as urn:li:share:<id>, or urn:li:ugcPost:<id> for a video or document post.'),
  url: z.string().nullable().describe('Public post URL, query string already stripped. Null when LinkedIn answered none (scheduled, media still processing).'),
  created_at: z.string().nullable().describe('Publication time, ISO 8601 (from the post id while a video or document post is still processing).'),
  text: z.string().describe('The body LinkedIn actually published, read back off the wire. Empty for a post of media alone and for a video or document post still processing.'),
  lifecycle_state: z.string().nullable().describe('The share\'s lifecycle state: PUBLISHED (LinkedIn said so, or the node\'s read-back found the post live within ~15 s); MEDIA_PROCESSING for a video or document post LinkedIn is still processing past that (the post exists, activity_urn / url come later); null when the answer named no state (a scheduled post).'),
  activity_log: ACTIVITY_LOG,
  idempotent_replay: z.boolean().optional()
    .describe('true when this answers a repeat (under the key, or without one the same words at the same place) with what the first send made: nothing was sent now.'),
  content_differs: z.boolean().optional()
    .describe('With idempotent_replay: true when this request\'s words (or a post\'s pictures, video or document) differ from those of the send that made it.'),
}).passthrough();

const CommentResult = z.object({
  comment_urn: z.string().describe('The created comment ref.'),
  activity_log: ACTIVITY_LOG,
  idempotent_replay: z.boolean().optional()
    .describe('true when this answers a repeat (under the key, or without one the same words at the same place) with what the first send made: nothing was sent now.'),
  content_differs: z.boolean().optional()
    .describe('With idempotent_replay: true when this request\'s words (or a post\'s pictures, video or document) differ from those of the send that made it.'),
  target_resolved_via: z.enum(['ledger', 'corpus', 'browser']).nullable().optional()
    .describe('How the target this call named was resolved to the key the wire takes: null = nothing to resolve, ledger / corpus = known for free, browser = ONE extra LinkedIn request was made for it.'),
}).passthrough();

const DeletePostResult = z.object({
  deleted: z.literal(true).describe('Always true on a 200: a refused delete is a 409, never a success body.'),
  message: z.string().nullable().describe("LinkedIn's own confirmation toast, when it sends one."),
  activity_log: ACTIVITY_LOG,
  target_resolved_via: z.enum(['ledger', 'corpus', 'browser']).nullable().optional()
    .describe('How the target this call named was resolved to the key the wire takes: null = nothing to resolve, ledger / corpus = known for free, browser = ONE extra LinkedIn request was made for it.'),
}).passthrough();

const DeleteCommentResult = z.object({
  deleted: z.literal(true),
  activity_log: ACTIVITY_LOG,
}).passthrough();

const UnreactResult = z.object({
  removed: z.literal(true),
  activity_log: ACTIVITY_LOG,
  target_resolved_via: z.enum(['ledger', 'corpus', 'browser']).nullable().optional()
    .describe('How the target this call named was resolved to the key the wire takes: null = nothing to resolve, ledger / corpus = known for free, browser = ONE extra LinkedIn request was made for it.'),
}).passthrough();

const ReactResult = z.object({
  // The graphql mutation's resourceKey (2026-08-21); null when the response
  // shape drifted - the activity-log row stays the durable record.
  reaction_urn: z.string().nullable(),
  activity_log: ACTIVITY_LOG,
  target_resolved_via: z.enum(['ledger', 'corpus', 'browser']).nullable().optional()
    .describe('How the target this call named was resolved to the key the wire takes: null = nothing to resolve, ledger / corpus = known for free, browser = ONE extra LinkedIn request was made for it.'),
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

// One article as the backend projects the node's Article record (design §2 of
// 2026-11-21; LinkedinPostingService::articleRowOf): the wire's unix ms rendered
// ISO 8601, every member but title and content_html nullable. state is a
// described z.string(), not a z.enum: no PHP enum backs it for the enum-parity
// gate to pin (the CheckSentResult precedent above).
const ArticleRow = z.object({
  article_id: z.string().nullable()
    .describe('The digits of urn:li:fsd_firstPartyArticle:<id>: the handle update_linkedin_article, publish_linkedin_article, get_linkedin_article and delete_linkedin_article take.'),
  article_urn: z.string().nullable().describe('urn:li:fsd_firstPartyArticle:<id>.'),
  linkedin_article_urn: z.string().nullable()
    .describe('urn:li:linkedInArticle:<id>, the same digits: the media urn of the article\'s share.'),
  title: z.string(),
  state: z.string().nullable()
    .describe('DRAFT | SCHEDULED | PUBLISHED, the wire\'s own read vocabulary. Only a DRAFT can be patched or published.'),
  content_html: z.string()
    .describe("LinkedIn's own html of the body, normalized server-side: not an echo of what was sent (a code block comes back as an empty pre, an inline picture gains its src, the editor's link attributes are rewritten)."),
  url: z.string().nullable()
    .describe('https://www.linkedin.com/pulse/<permalink>, PUBLISHED only: the handle get_linkedin_article takes as url.'),
  cover_image_url: z.string().nullable().describe('The largest rendition of the cover picture, when one is set.'),
  cover_image_caption: z.string().nullable(),
  author_profile_id: z.string().nullable()
    .describe("The member's ACoA id when the article is the member's own; null for a page article."),
  author_organization_id: z.string().nullable()
    .describe("The numeric company id when the article is a page's; null for a member article."),
  newsletter_id: z.string().nullable()
    .describe('The digits of the newsletter (content series) this article is an issue of; null when it is none.'),
  post_urn: z.string().nullable()
    .describe('The share LinkedIn made for a SCHEDULED or PUBLISHED article (urn:li:ugcPost:<id>); null on a DRAFT. A scheduled article sits in get_linkedin_scheduled_posts under it.'),
  activity_urn: z.string().nullable()
    .describe('The feed entry of a published article. Only the read by url (the Article Reader) carries it; null on every other read.'),
  created_at: z.string().nullable().describe('ISO 8601; null on a read by url (the reader omits it).'),
  updated_at: z.string().nullable().describe('ISO 8601; null on a read by url.'),
  published_at: z.string().nullable().describe('ISO 8601, PUBLISHED only.'),
  scheduled_at: z.string().nullable()
    .describe("ISO 8601 of the planned publication. Carried by get_linkedin_articles (state SCHEDULED) and by the create or publish answer that scheduled it. LinkedIn's single read by id answers none (probe B5 of 2026-11-21), so a null here on get_linkedin_article does NOT mean unscheduled: read state and post_urn, or list with state SCHEDULED."),
  version: z.number().int().nullable().describe('LinkedIn\'s edit counter: 0 on create, one more per patch.'),
}).passthrough();

// The share step's answer, create-post's shape without the activity-log row
// (LinkedinPostingService::articlePostOf): null for a DRAFT.
const ArticleShare = z.object({
  activity_urn: z.string().nullable().describe('The feed entry, PUBLISHED now only; null for a scheduled share.'),
  post_urn: z.string().nullable()
    .describe('The share, urn:li:ugcPost:<id>: the proof it was made, the same value article.post_urn carries.'),
  url: z.string().nullable().describe('The feed url of the share, query string stripped; null for a scheduled share.'),
  created_at: z.string().nullable().describe('ISO 8601.'),
  text: z.string().describe('The commentary LinkedIn published above the article; empty when none was given.'),
  lifecycle_state: z.string().nullable().describe('PUBLISHED when LinkedIn said so; null for a scheduled share.'),
}).passthrough();

// create-article and publish-article answer the same `{article, post}`: the
// article read back after the last write (latestDraftById) and the share.
const ArticleShareResult = z.object({
  article: ArticleRow.describe('The article read back after the last write.'),
  post: ArticleShare.nullable()
    .describe('The share: null when state was DRAFT (nothing is public yet); for a scheduled share post_urn alone, for one published now its activity_urn and url too.'),
  activity_log: ACTIVITY_LOG,
  idempotent_replay: z.boolean().optional()
    .describe('true when this answers a repeat (under the key, or without one the same commentary and article at the same place) with what the first send made: nothing was sent now.'),
  content_differs: z.boolean().optional()
    .describe('With idempotent_replay: true when this request\'s commentary or article differs from the send that made it.'),
}).passthrough();

const UpdateArticleResult = z.object({
  article: ArticleRow
    .describe('The draft read back after the patch: version moved by one, content_html LinkedIn\'s normalized form of what was sent, post_urn null.'),
  activity_log: ACTIVITY_LOG,
}).passthrough();

const GetArticlesResult = z.object({
  rows: z.array(ArticleRow).describe('Newest edit first: LinkedIn orders the list by updated_at descending.'),
  paging: z.object({
    next_cursor: z.string().nullable().describe('Offset cursor for the next page; null when the list is exhausted.'),
    total: z.number().int().nullable().describe("LinkedIn's total for this author and state; reliable on this finder (probe F1 of 2026-11-21)."),
  }).passthrough(),
  activity_log: ACTIVITY_LOG,
}).passthrough();

const GetArticleResult = z.object({
  article: ArticleRow.nullable()
    .describe("null, in a 200, when LinkedIn has no article under the id or the url (deleted, another account's, a pulse link the reader does not resolve): never an error, as get-post answers a deleted post."),
  activity_log: ACTIVITY_LOG,
}).passthrough();

const DeleteArticleResult = z.object({
  deleted: z.literal(true)
    .describe('Always true on a 200: a refused delete is a 409 article_not_deleted, never a success body.'),
  post_urn: z.string().nullable()
    .describe('The share that was deleted first, when the article had one (SCHEDULED or PUBLISHED); null for a draft.'),
  state_before: z.string().nullable()
    .describe('DRAFT | SCHEDULED | PUBLISHED: what the article was when it was read, before the delete.'),
  activity_log: ACTIVITY_LOG,
}).passthrough();

// One newsletter (content series) as the backend projects the node's record
// (LinkedinPostingService::newsletterRowOf); every member but the title nullable.
const NewsletterRow = z.object({
  newsletter_id: z.string().nullable()
    .describe('The digits of urn:li:fsd_contentSeries:<id>: what create_linkedin_article and update_linkedin_article take as newsletter_id.'),
  newsletter_urn: z.string().nullable().describe('urn:li:fsd_contentSeries:<id>.'),
  title: z.string(),
  description: z.string().nullable(),
  url: z.string().nullable().describe('https://www.linkedin.com/newsletters/<slug>-<id>.'),
  issue_count: z.number().int().nullable(),
  subscriber_count: z.number().int().nullable().describe('From LinkedIn\'s subscribe row, when it rides along.'),
  publish_frequency: z.object({ duration: z.number().int(), unit: z.string() }).nullable()
    .describe('The cadence LinkedIn states for it, such as {duration: 2, unit: MONTH}.'),
  author_profile_id: z.string().nullable().describe("The member's ACoA id when the newsletter is the member's own."),
  author_organization_id: z.string().nullable().describe("The numeric company id when the newsletter is a page's."),
  logo_url: z.string().nullable(),
}).passthrough();

const GetNewslettersResult = z.object({
  rows: z.array(NewsletterRow),
  paging: z.object({
    next_cursor: z.string().nullable().describe('Offset cursor for the next page; null when the list is exhausted: the ONLY end-of-list signal here.'),
    total: z.number().int().nullable()
      .describe('NOT reliable on this finder: LinkedIn answered 0 with two newsletters live (probe F4 of 2026-11-21). Read next_cursor instead.'),
  }).passthrough(),
  creation_enabled: z.boolean().nullable()
    .describe("LinkedIn's metadata.creationEnabled: whether this owner may create newsletters. A product flag, not the entitlement to publish into one: an account with no newsletter answers rows [] with creation_enabled true (probe A6)."),
  activity_log: ACTIVITY_LOG,
}).passthrough();

// One company page the account may publish as, as the backend projects the
// node's record (LinkedinPostingService::administeredCompanyRowOf): every
// member but name and roles nullable.
const AdministeredCompanyRow = z.object({
  company_id: z.string().nullable()
    .describe('The digits of urn:li:fsd_company:<id>: what author_organization_id takes on every verb of this surface.'),
  company_urn: z.string().nullable().describe('urn:li:fsd_company:<id>.'),
  name: z.string(),
  universal_name: z.string().nullable().describe('The vanity in the page url, such as jobs-psa-page.'),
  url: z.string().nullable().describe('https://www.linkedin.com/company/<vanity>/ or /showcase/<vanity>/.'),
  page_type: z.string().nullable().describe('COMPANY or SHOWCASE, as the wire says.'),
  logo_url: z.string().nullable().describe('The largest rendition of the page logo, when it has one.'),
  roles: z.array(z.string())
    .describe("The account's roles on the page as LinkedIn names them (SUPER_ADMINISTRATOR, CONTENT_ADMINISTRATOR); empty when the wire named none."),
  follower_count: z.number().int().nullable()
    .describe("The page's follower count from LinkedIn's following row, when it rides along."),
}).passthrough();

const GetAdministeredCompaniesResult = z.object({
  rows: z.array(AdministeredCompanyRow).describe('In the order LinkedIn lists them: not alphabetical, not by id.'),
  paging: z.object({
    next_cursor: z.string().nullable().describe('Offset cursor for the next page; null when the list is exhausted.'),
    total: z.number().int().nullable()
      .describe('How many pages the account may publish as; reliable on this finder (probes O2 and O3 of 2026-11-22).'),
  }).passthrough(),
  activity_log: ACTIVITY_LOG,
}).passthrough();

// The queue READ drives a real browser dispatch (so not readOnly-pure) but
// mutates nothing - the linkedin-scraping convention, mirrored.
const QUEUE_READ = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

// check-sent: a live-dispatch read. It sends nothing, but a send in doubt has
// LinkedIn read in the request (the post's comments, the account's own comments
// or feed, a page's feed, the scheduled queue) through the account's browser when
// the last look is old enough, so it is not readOnlyHint (the audit report of
// 2026-09-16, item 11).
const LIVE_READ = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

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
      'Repost a LinkedIn post from one of the team accounts (wire create-instant-repost / create-repost-with-thoughts): ONE tool, the body picks which. Without text it is the plain repost (the feed\'s Repost button) and nothing else may be sent. With text it is a repost with your thoughts, a share of your own above the reposted post, which takes visibility, allowed_commenters_scope and mentions exactly as create_linkedin_post does. post_urn is the post being reposted as urn:li:activity, urn:li:share or urn:li:ugcPost (a group post cannot be reposted). Public and outward; retract with delete_linkedin_post on the answered activity_urn. Spends the posting bucket. '
      + sendOnce('reposted post (as LinkedIn files it, whichever of its urns you name)')
      + ' A plain repost has no deadline on LinkedIn\'s side, so one whose answer was lost stays in doubt for an hour.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-posting/repost' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    pacedBucket: 'posting',
    sentCheck: { tool: 'check_linkedin_posting_sent', args: { verb: 'repost' } },
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      linkedin_account_sid: ACCOUNT_SID,
      post_urn: z.string().min(1).max(2048).describe('The post to repost: urn:li:activity:<id>, urn:li:share:<id> or urn:li:ugcPost:<id>, or any link to the post (a lnkd.in shortlink too), which is read into its urn for you.'),
      text: z.string().max(3000).optional().describe('Your own words above the reposted post. Omit (or blank) for a plain repost.'),
      visibility: LinkedinPostingVisibility.optional().describe('With text only. ANYONE (the default) or CONNECTIONS_ONLY.'),
      allowed_commenters_scope: LinkedinPostingAllowedCommentersScope.optional().describe('With text only. ALL (the default), CONNECTIONS_ONLY, or NONE to disable comments.'),
      mentions: z.array(LinkedinPostingMention).optional()
        .describe('With text only: mentions of members (profile_id) and company pages (company_id) as ready positions over text, as create_linkedin_post takes them.'),
      client_reference: postingKey('repost', 'the post it reposts, as LinkedIn files it', 'a repost of the same post with the same words'),
      confirmed_not_sent: CONFIRMED_NOT_SENT,
      confirmed_sent: CONFIRMED_SENT,
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
      idempotent_replay: z.boolean().optional()
        .describe('true when this answers a repeat (under the key, or without one the same words at the same place) with what the first send made: nothing was sent now.'),
      content_differs: z.boolean().optional()
        .describe('With idempotent_replay: true when this request\'s words (or a post\'s pictures, video or document) differ from those of the send that made it.'),
    }).passthrough()),
    annotations: { title: 'Repost LinkedIn post', ...DANGER },
  },
  {
    ...base,
    name: 'create_linkedin_post',
    description:
      'Publish ONE feed post - as the member, AS a company page it administers (author_organization_id), or INTO a group (group_id) - now or scheduled (scheduled_at) - wire create-post. Public; retract with delete_linkedin_post, or delete a scheduled draft with delete_linkedin_scheduled_post. Identity-bound: linkedin_account_sid REQUIRED, spends the posting bucket (20/day in series of 3 at a 1200 s pause; free plan 4), saturation returns 429. text is REQUIRED as a key but may be an EMPTY string when media is attached; no text or media at all is a 422. Media: up to 20 images XOR one video XOR one PDF document, each base64 or https url, 35 MB total. Answers the published post (urn, url, time, body) and the activity-log row. '
      + sendOnce('place (your feed, the page or the group; a new scheduled_at is the same post)')
      + ' 409 post_not_created is send_outcome unknown: repeat after retry_after.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-posting/create-post' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    pacedBucket: 'posting',
    sentCheck: { tool: 'check_linkedin_posting_sent', args: { verb: 'create-post' } },
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      linkedin_account_sid: ACCOUNT_SID,
      text: z.string().max(3000)
        .describe('Post body, always present. Empty is legal ONLY alongside media (an image, a video or a document). 3000 is LinkedIn\'s own cap, refused here rather than burning a posting slot. Published byte for byte, blank lines included, and so is each image\'s alt_text.'),
      images: z.array(LinkedinPostingImageValue).max(20).optional()
        .describe('Up to 20 images (the node\'s own cap; array order = carousel order). Mutually exclusive with video and document. The decoded bytes across ALL media must stay under 35 MB in total; over that is a 422, because a bigger body is refused by the node\'s JSON parser as a bare 413 with no response envelope. For 2+ images the backend supplies the account\'s own member id to the wire itself - no profile_id field exists here. Uploads are sequential node-side, so many large images make a SLOW synchronous call: the post can publish after your client times out, so repeat it only as the same request under the same client_reference, which is answered with the post (or held while LinkedIn is read), never published twice.'),
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
        .describe('ONE video, image-shaped minus alt_text. Mutually exclusive with images and document (LinkedIn does not mix them in a share - 422 here). Shares the 35 MB media budget. Plays 3 seconds to 15 minutes, as its MP4 / MOV / WEBM container states (LinkedIn\'s own rule, checked here before the upload: 422 video_duration on the member otherwise; a container that states no length passes). The upload runs through the browser (one PUT up to 10 MiB, 4 MiB parts above it) and is SLOW: the synchronous call can outlive your client timeout while the post still publishes, so repeat it only under the same client_reference.'),
      document: LinkedinPostingDocumentValue.optional()
        .describe('ONE PDF, posted as a LinkedIn document the feed pages through. PDF only, up to 300 pages, typed by its content, never by a file name or a Content-Type. Exactly one of file_base64 or url. Shares the 35 MB media budget. Mutually exclusive with images and video (LinkedIn does not mix them in a share - 422 here). A request_media_upload file_url does not hold a PDF. A file LinkedIn cannot process (one that asks for a password, damaged, over 300 pages) is a 409 linkedin_refused with plugin_error_code linkedin_422 and send_outcome not_sent: nothing is published, and a repeat of the same file is refused the same way. A document into a group (group_id) is not verified on the wire. The upload runs through the browser and a big file is SLOW: the synchronous call can outlive your client timeout while the post still publishes, so repeat it only under the same client_reference.'),
      scheduled_at: z.string().optional()
        .describe('Schedule the post instead of publishing now: ISO 8601 with timezone, must be in the future (a strictly-past time is a 422; within a minute of now is passed through for LinkedIn to judge). A SCHEDULED share legitimately answers with null activity_urn/url - post_urn is the handle. Read and clean the queue with get_linkedin_scheduled_posts / delete_linkedin_scheduled_post. Scheduling is LinkedIn-side: the draft lives in ITS queue, nothing is stored here. The slot is no part of a key: a retry under the same client_reference that computes a new scheduled_at is the same post. Without a key the slot tells two posts apart.'),
      mentions: z.array(LinkedinPostingMention).optional()
        .describe('Mentions of members (profile_id) and company pages (company_id, 2026-10-29) as READY POSITIONS over text (2026-08-21) - unlike create_linkedin_comment\'s {profile_id, name} search pairs. Each entry names exactly one of the two ids. Require non-blank text.'),
      brand_partnership: z.boolean().optional()
        .describe('true adds LinkedIn\'s "Brand partnership" label (paid endorsement). false and absent both send nothing - the wire\'s own shape.'),
      author_organization_id: z.string().max(2048).optional()
        .describe('Post AS a company page the account administers: its numeric id in any spelling (the digits, a company urn, a /company/<id>/ link), or its page link or slug when a company read of your workspace already knows the id (else 422 company_not_readable). get_linkedin_administered_companies lists the pages this account may post as, with their ids. Omit to post as the member.'),
      group_id: z.string().regex(/^\d+$/).optional()
        .describe('Post INTO a group: the bare numeric group id. Mutually exclusive with visibility - a group post sets container visibility, not member-feed visibility. No read serves a group\'s feed, so a group post whose answer was lost stays in doubt until a person gives their word.'),
      client_reference: postingKey(
        'post',
        'where it lands: your own feed, the company page of author_organization_id or the group of group_id',
        'the same words and pictures, video or document at the same place and slot',
      ),
      confirmed_not_sent: CONFIRMED_NOT_SENT,
      confirmed_sent: CONFIRMED_SENT,
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), CreatePostResult),
    annotations: { title: 'Create LinkedIn post', ...DANGER },
  },
  {
    ...base,
    name: 'create_linkedin_comment',
    description:
      'Leave ONE outbound comment on any LinkedIn post (wire create-comment), as the member or AS a company page it administers (author_organization_id): entity_urn takes a post urn in any family or a post URL carrying one, and the comment is written on the post\'s social thread. The post does NOT need to be tracked or owned by us. Identity-bound: linkedin_account_sid REQUIRED, spends the comment_posts bucket (30/day at a 360 s floor), saturation returns 429. Reply to an existing comment via parent_comment_urn. mentions turns exact substrings of text into clickable links ({profile_id, name} pairs; a name missing or out of order is a 422 with no dispatch spent). Returns the created comment ref plus the activity-log row. '
      + sendOnce('place (the post as LinkedIn files it, or the comment a reply answers)')
      + ' To react use react_linkedin_post; to resolve a post URL use get_activity_urn_by_url.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-posting/comment' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    pacedBucket: 'comment_posts',
    sentCheck: { tool: 'check_linkedin_posting_sent', args: { verb: 'comment' } },
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
        profile_id: z.string().min(1).optional()
          .describe('A member to mention: a bare ACoA… profile id (as get-post-comments and the profile readers return) or the full urn:li:fsd_profile:<id>. Exactly one of profile_id or company_id.'),
        company_id: z.string().min(1).optional()
          .describe('A company page to mention: the bare numeric company id (same form get_linkedin_company_posts takes) or the full urn:li:fsd_company:<id>. Exactly one of profile_id or company_id.'),
        name: z.string().min(1)
          .describe('The exact substring of text that becomes the clickable link (usually the member\'s or the page\'s name).'),
      })).optional()
        .describe('Mentions of members (profile_id) and company pages (company_id, 2026-10-29). Names are matched in text left to right in list order, each search starting after the previous mention. The node computes the character offsets itself.'),
      author_organization_id: z.string().max(2048).optional()
        .describe('Comment AS a company page the account administers: its numeric id in any spelling (the digits, a company urn, a /company/<id>/ link; the company_ln_id enrich_linkedin_company_posts takes), or its link or slug when your workspace already knows the id, for a top-level comment and a reply alike. get_linkedin_administered_companies lists the pages this account may act as, with their ids. Omit to comment as the member. The member and a page are two authors, so their comments at one place are two comments: give each a client_reference of its own, because check_linkedin_posting_sent takes no author and, asked by a key both share, answers for whichever went out. No read lists a comment as made by a page, so a page comment whose answer was lost stays in doubt until a person gives their word (confirmed_sent or confirmed_not_sent). A mass-action comment step does not take this field: a step comments as the member.'),
      client_reference: postingKey('comment', 'the post as LinkedIn files it, named by any of its urns, or for a reply the comment it answers', 'the same words at the same place by the same author'),
      confirmed_not_sent: CONFIRMED_NOT_SENT,
      confirmed_sent: CONFIRMED_SENT,
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), CommentResult),
    annotations: { title: 'Create LinkedIn comment', ...DANGER },
  },
  {
    ...base,
    name: 'react_linkedin_post',
    description:
      'Leave OUR reaction on any LinkedIn post OR comment (wire create-reaction): entity_urn takes a post urn in any family, a post URL carrying one, or a comment urn; a post is reacted on at its social thread (see entity_urn). The social-selling counterpart of create_linkedin_comment. Outward and fire-on-success: the post does NOT need to be tracked, nothing is persisted here. Identity-bound: linkedin_account_sid REQUIRED, spends the react_posts bucket (30/day at a 360 s floor), saturation returns 429. Returns reaction_urn (the reaction\'s key, naming the entity it landed on; null on drift or when LinkedIn ignored it) plus the activity-log row. interested is the EVENT-post reaction: ordinary posts silently ignore it (success envelope, null reaction_urn, nothing lands - verified live). Takes no key: LinkedIn keeps one reaction per account and post, so repeating the same reaction changes nothing; every refusal still names error.context.send_outcome. To comment use create_linkedin_comment.',
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
      author_organization_id: z.string().max(2048).optional()
        .describe("Read a company page's queue instead of the member's own: its numeric id in any spelling (the digits, a company urn, a linkedin.com/company/<id>/ link), or its link or slug when your workspace already knows the id. The account must administer that page or the queue comes back empty; get_linkedin_administered_companies lists those pages and their ids."),
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
  // ─── The article family (2026-11-21; design D10) ───
  //
  // Seven verbs on the same route group, mount and bucket as the posts: the four
  // writes are dangerous (preview then confirm), the three reads are the queue's
  // kind (a browser dispatch, nothing mutated). Two of the writes are sends
  // (create-article with a share, publish-article) and carry the key with the
  // check tool below; a DRAFT create, a patch and a delete are keyless.
  {
    ...base,
    name: 'create_linkedin_article',
    description:
      'Create ONE LinkedIn article (LinkedIn\'s long-form post) as the member or AS a company page it administers (author_organization_id), as a newsletter issue (newsletter_id; excludes visibility), with a cover_image; wire create-article. state decides: DRAFT creates and stops (nothing public, no key); SCHEDULED also schedules its share (scheduled_at REQUIRED, ISO 8601 with timezone, in the future); PUBLISHED shares now. content_html is the HTML subset the field describes; any other tag is a 422 naming it. Spends the posting bucket (20/day in series of 3 at a 1200 s pause; free plan 4). Answers the article read back and its post (a scheduled share has post_urn only). '
      + sendOnce('place (your feed or the page; a new scheduled_at is the same share)')
      + ' 409 article_not_published is send_outcome unknown: repeat after retry_after; context.article_id names a draft left behind.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-posting/create-article' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    pacedBucket: 'posting',
    sentCheck: { tool: 'check_linkedin_posting_sent', args: { verb: 'create-article' } },
    massAction: false,
    stepEligible: false,
    scheduleRequired: false,
    inputSchema: z.object({
      linkedin_account_sid: ACCOUNT_SID,
      title: z.string().min(1)
        .describe('The article\'s title, never blank (a blank one is a 422 here). No cap of ours: a title LinkedIn refuses comes back as its own answer.'),
      content_html: z.string()
        .describe('The body as HTML, always present; "" is legal for a DRAFT (an empty article). The subset: p, h1-h6 (LinkedIn has one heading level), blockquote, pre or pre>code, ul/ol>li, hr, img (a data: URL, or an https url we download) alone or in a figure with a figcaption, iframe[src] embeds LinkedIn can ingest (YouTube and the like), br, and inline strong/b, em/i, a[href]; u, s, code, span and unknown inline tags are unwrapped. table, video, audio, script, style or any other block tag is a 422 naming the tag. Pictures (the cover included) share one 35 MB decoded budget; the html itself is capped at 1,000,000 characters without them.'),
      state: LinkedinPostingArticleState
        .describe('DRAFT: create the draft and stop. SCHEDULED: create it and schedule its share at scheduled_at (REQUIRED then). PUBLISHED: create it, share it now and mark it published. The share is what makes an article public.'),
      scheduled_at: z.string().optional()
        .describe('With state SCHEDULED only (REQUIRED there, refused with DRAFT or PUBLISHED): ISO 8601 with timezone, in the future (a strictly past time is a 422; within a minute of now is passed through for LinkedIn to judge). The share lives in LinkedIn\'s own queue (get_linkedin_scheduled_posts); the article is listed by get_linkedin_articles with state SCHEDULED. The slot is no part of a key: a retry under the same client_reference with a new scheduled_at is the same share.'),
      commentary: z.string().max(3000).optional()
        .describe('The share\'s text above the article (3000, LinkedIn\'s post cap); "" when omitted, which LinkedIn accepts. Meaningless for a DRAFT and ignored there.'),
      visibility: LinkedinPostingVisibility.optional()
        .describe('The share\'s visibility: ANYONE (the node default) or CONNECTIONS_ONLY. Mutually exclusive with newsletter_id: an issue takes container visibility on its newsletter.'),
      allowed_commenters_scope: LinkedinPostingAllowedCommentersScope.optional()
        .describe('Who may comment on the share: ALL (the node default), CONNECTIONS_ONLY, or NONE to disable comments.'),
      author_organization_id: z.string().max(2048).optional()
        .describe('Write AS a company page the account administers: its numeric id in any spelling (the digits, a company urn, a /company/<id>/ link), or its page link or slug when a company read of your workspace already knows the id (else 422 company_not_readable). get_linkedin_administered_companies lists the pages this account may write as, with their ids. The article and its share both go as the page. Omit to write as the member (the backend supplies the member\'s own id; no profile_id field exists here).'),
      newsletter_id: z.string().regex(NEWSLETTER_ID_RE).optional()
        .describe('Make the article an issue of this newsletter: the digits of urn:li:fsd_contentSeries:<id> (rows[].newsletter_id of get_linkedin_newsletters) or that urn. The owner must match author_organization_id (a page\'s newsletter needs the page). Excludes visibility.'),
      cover_image: LinkedinPostingArticleCoverImage.optional()
        .describe('ONE cover picture (file_base64 XOR url, plus an optional caption), uploaded before the create. Shares the 35 MB budget with the inline pictures.'),
      client_reference: postingKey(
        'article share',
        'where it lands: your own feed or the company page of author_organization_id',
        'the same commentary and article at the same place and slot',
      ),
      confirmed_not_sent: CONFIRMED_NOT_SENT,
      confirmed_sent: CONFIRMED_SENT,
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), ArticleShareResult),
    annotations: { title: 'Create LinkedIn article', ...DANGER },
  },
  {
    ...base,
    name: 'update_linkedin_article',
    description:
      "Patch one of the account's DRAFT LinkedIn articles (wire update-article): title, content_html (replaces the whole body; the same HTML subset and pictures as create_linkedin_article), cover_image, newsletter_id, at least one of them. The article is read first: a SCHEDULED or PUBLISHED one is refused 409 article_not_draft (delete it with delete_linkedin_article and create it again, or leave it), an id LinkedIn has nothing under is 404 article_not_found. newsletter_id takes no null: omit it to keep the series as it is (the wire for leaving a newsletter is not captured). Spends the posting bucket (20/day in series of 3 at a 1200 s pause; free plan 4). Not a send: a draft is in front of nobody, so it takes no client_reference. Answers the draft read back after the patch (version moved by one; content_html is LinkedIn's normalized form of what was sent).",
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-posting/update-article' },
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
      article_id: ARTICLE_ID,
      title: z.string().min(1).optional().describe('A new title, never blank. Omit to keep the title.'),
      content_html: z.string().optional()
        .describe('A new body, replacing the whole one: the same HTML subset, pictures and ceilings as create_linkedin_article; "" empties the draft. Omit to keep the body.'),
      newsletter_id: z.string().regex(NEWSLETTER_ID_RE).optional()
        .describe('Move the draft into this newsletter: the digits of urn:li:fsd_contentSeries:<id> or that urn. Not nullable: omit it to keep the series.'),
      cover_image: LinkedinPostingArticleCoverImage.optional()
        .describe('A new cover picture (file_base64 XOR url, plus an optional caption), replacing the current one. Omit to keep it.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), UpdateArticleResult),
    annotations: { title: 'Update LinkedIn article draft', ...DANGER },
  },
  {
    ...base,
    name: 'publish_linkedin_article',
    description:
      "Share one of the account's DRAFT LinkedIn articles, now or at a slot (wire publish-article): scheduled_at (ISO 8601 with timezone, in the future) schedules the share; absent, the share goes out now and the article is marked PUBLISHED. The article is read first and its author (the member or the page) and newsletter come from it, so there is no author field; a SCHEDULED or PUBLISHED article is refused 409 article_not_draft, a gone one 404 article_not_found. commentary is the share's text above the article (empty when omitted); visibility and allowed_commenters_scope as on create_linkedin_post. Public; take it back with delete_linkedin_article. Spends the posting bucket (20/day in series of 3 at a 1200 s pause; free plan 4). "
      + sendOnce('article (a new scheduled_at is the same share)')
      + ' 409 article_not_published is send_outcome unknown: repeat after retry_after.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-posting/publish-article' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    pacedBucket: 'posting',
    sentCheck: { tool: 'check_linkedin_posting_sent', args: { verb: 'publish-article' } },
    massAction: false,
    stepEligible: false,
    scheduleRequired: false,
    inputSchema: z.object({
      linkedin_account_sid: ACCOUNT_SID,
      article_id: ARTICLE_ID,
      scheduled_at: z.string().optional()
        .describe('Schedule the share instead of publishing now: ISO 8601 with timezone, in the future (a strictly past time is a 422; within a minute of now is passed through for LinkedIn to judge). The share lives in LinkedIn\'s own queue. The slot is no part of a key: a retry under the same client_reference with a new scheduled_at is the same share.'),
      commentary: z.string().max(3000).optional()
        .describe('The share\'s text above the article (3000, LinkedIn\'s post cap); "" when omitted, which LinkedIn accepts.'),
      visibility: LinkedinPostingVisibility.optional()
        .describe('ANYONE (the node default) or CONNECTIONS_ONLY. Ignored for a newsletter issue, whose share takes container visibility on its newsletter.'),
      allowed_commenters_scope: LinkedinPostingAllowedCommentersScope.optional()
        .describe('Who may comment on the share: ALL (the node default), CONNECTIONS_ONLY, or NONE to disable comments.'),
      client_reference: postingKey(
        'article share',
        'the article it shares, article:<id> with the slot after it when scheduled, whatever the article\'s author: the author is read from the article after the key is taken, so no feed is named and a lost answer stays unknown until a person confirms it',
        'the same commentary and article at the same place and slot',
      ),
      confirmed_not_sent: CONFIRMED_NOT_SENT,
      confirmed_sent: CONFIRMED_SENT,
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), ArticleShareResult),
    annotations: { title: 'Publish LinkedIn article', ...DANGER },
  },
  {
    ...base,
    name: 'get_linkedin_articles',
    description:
      "One page of the account's own LinkedIn articles in ONE state, DRAFT, SCHEDULED or PUBLISHED (wire get-articles): each row with article_id, title, state, post_urn, url, the timestamps and scheduled_at (this list is the one read that carries it). Pass author_organization_id (the page's numeric id) to read a COMPANY PAGE's articles the account administers instead of the member's own. A PRIVATE read, nobody on LinkedIn sees it, but it spends the one Content bucket, posting (20/day in series of 3 at a 1200 s pause; free plan 4), shared with publishing. Offset-paged, newest edit first: page_size 1-100 (default 20), pass paging.next_cursor back as cursor; paging.total is reliable here. rows[].article_id is the handle the other article verbs take.",
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-posting/get-articles' },
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
      state: LinkedinPostingArticleState
        .describe('Which list: DRAFT (unshared drafts), SCHEDULED (a share is queued) or PUBLISHED. One state per call.'),
      page_size: z.number().int().min(1).max(100).optional()
        .describe("Rows per page, the node's own [1, 100] gate. Defaults to 20."),
      cursor: z.string().min(1).max(200).optional()
        .describe('The previous page\'s paging.next_cursor, verbatim. Omit for the first page.'),
      author_organization_id: z.string().max(2048).optional()
        .describe("Read a company page's articles instead of the member's own: its numeric id in any spelling (the digits, a company urn, a linkedin.com/company/<id>/ link), or its link or slug when your workspace already knows the id. The account must administer that page or the list comes back empty; get_linkedin_administered_companies lists those pages and their ids."),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), GetArticlesResult),
    annotations: { title: 'Get LinkedIn articles', ...QUEUE_READ },
  },
  {
    ...base,
    name: 'get_linkedin_article',
    description:
      "One LinkedIn article by article_id (any state) or by its public pulse url, exactly one of the two (wire get-article). By id, LinkedIn's latestDraftById answers a DRAFT, a SCHEDULED or a PUBLISHED article; by url, the Article Reader answers a PUBLISHED one and is the only read that carries activity_urn (and none of created_at, updated_at, version). result.article is null, in a 200, when LinkedIn has nothing under the id or the url (deleted, another account's, a link that is not a pulse url): never an error. scheduled_at is null on a read by id even for a SCHEDULED article (LinkedIn's single read omits it): read state and post_urn, or list with get_linkedin_articles state SCHEDULED. A PRIVATE read that spends the one Content bucket, posting (20/day in series of 3 at a 1200 s pause; free plan 4).",
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-posting/get-article' },
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
      article_id: ARTICLE_ID.optional()
        .describe('The article by id: the digits of urn:li:fsd_firstPartyArticle:<id> or that urn, every state. Exactly one of article_id or url.'),
      url: z.string().url().max(2048).regex(PULSE_URL_RE).optional()
        .describe('The article by its public link: https://www.linkedin.com/pulse/<permalink> (a locale host such as de.linkedin.com works; the permalink may be percent-encoded). PUBLISHED articles only, the one read with activity_urn. Exactly one of article_id or url.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), GetArticleResult),
    annotations: { title: 'Get LinkedIn article', ...QUEUE_READ },
  },
  {
    ...base,
    name: 'delete_linkedin_article',
    description:
      "Delete one of the account's LinkedIn articles by article_id, a draft, a scheduled or a published one (wire delete-article). The undo of create_linkedin_article and publish_linkedin_article: the article is read, its share is deleted first when it has one (so the queued slot or the public post goes with it), then the article itself. The handle is the ARTICLE, never its share: delete_linkedin_scheduled_post on the share alone leaves a scheduled article behind. Spends the one Content bucket, posting (20/day in series of 3 at a 1200 s pause; free plan 4), paced as an undo so a create and its delete fit back to back. A refusal, not this account's or already gone, comes back as 409 article_not_deleted with context.state_before (null when nothing was found), never as a success; on a 200 result.state_before says what it was.",
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-posting/delete-article' },
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
      article_id: ARTICLE_ID,
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), DeleteArticleResult),
    annotations: { title: 'Delete LinkedIn article', ...DANGER },
  },
  {
    ...base,
    name: 'get_linkedin_newsletters',
    description:
      "One page of the newsletters (LinkedIn content series) the account, or a COMPANY PAGE it administers (author_organization_id), may publish articles into (wire get-newsletters): newsletter_id (what create_linkedin_article takes), title, url, issue_count, subscriber_count, publish_frequency. An account without the newsletter feature answers rows [] (creation_enabled describes the product, not the entitlement). A PRIVATE read that spends the one Content bucket, posting (20/day in series of 3 at a 1200 s pause; free plan 4). Offset-paged: page_size 1-100 (default 20), pass paging.next_cursor back as cursor; paging.total is NOT reliable on this finder (LinkedIn answered 0 with two newsletters live), the end of the list is a null next_cursor.",
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-posting/get-newsletters' },
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
      author_organization_id: z.string().max(2048).optional()
        .describe("Read a company page's newsletters instead of the member's own: its numeric id in any spelling (the digits, a company urn, a linkedin.com/company/<id>/ link), or its link or slug when your workspace already knows the id. The account must administer that page or the list comes back empty; get_linkedin_administered_companies lists those pages and their ids."),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), GetNewslettersResult),
    annotations: { title: 'Get LinkedIn newsletters', ...QUEUE_READ },
  },
  // get-administered-companies (2026-11-22): the one read here that is NOT on the
  // posting bucket. It is the editor's own "which pages may I post as" list, a
  // discovery read before every page post, so it spends self_account_sync (the
  // own account's data, as the get_my_* reads do) and never a posting unit.
  {
    ...base,
    name: 'get_linkedin_administered_companies',
    description:
      "One page of the company pages (COMPANY and SHOWCASE) the account may publish as (wire get-administered-companies): the source of every author_organization_id on this surface (create_linkedin_post, create_linkedin_comment, create_linkedin_article and the three paged reads) and, through get_linkedin_newsletters, of a page's newsletter_id. Each row: company_id (the digits of urn:li:fsd_company:<id>, what author_organization_id takes), company_urn, name, universal_name, url, page_type, logo_url, roles (SUPER_ADMINISTRATOR, CONTENT_ADMINISTRATOR, as LinkedIn names them) and follower_count. The filter is LinkedIn's own (canCreateOrganicShare): a page the account may not post as never lists, an account administering no page answers rows []. A PRIVATE read that spends one self_account_sync unit (the own account's read budget), NOT the posting bucket. Offset-paged: page_size 1-100 (default 10, LinkedIn's own), pass paging.next_cursor back as cursor; paging.total is reliable here.",
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-posting/get-administered-companies' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    pacedBucket: 'self_account_sync',
    massAction: false,
    stepEligible: false,
    scheduleRequired: false,
    inputSchema: z.object({
      linkedin_account_sid: ACCOUNT_SID,
      page_size: z.number().int().min(1).max(100).optional()
        .describe("Rows per page, the node's own [1, 100] gate. Defaults to 10, LinkedIn's own page."),
      cursor: z.string().min(1).max(200).optional()
        .describe('The previous page\'s paging.next_cursor, verbatim. Omit for the first page.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), GetAdministeredCompaniesResult),
    annotations: { title: 'Get the LinkedIn company pages the account administers', ...QUEUE_READ },
  },
  // check-sent (2026-10-05, round 5; product KNOWLEDGE §4.9a): what a comment, a
  // post, a repost or an article share (2026-11-21) came to, asked without sending. No pacedBucket, as
  // check_linkedin_message_sent: the look rides the account's own-sync budget, and
  // a look that budget holds back reads nothing while the call still answers
  // (unknown, with retry_after), never 429.
  {
    ...base,
    name: 'check_linkedin_posting_sent',
    description:
      "Ask what a LinkedIn comment, post, repost or article share came to, without sending: by the client_reference it went out under and its verb (comment, create-post, repost, create-article, publish-article), optionally at one place (entity_urn: the post a comment or a repost went to, or the comment a reply answers; parent_comment_urn for a reply; post_place for a post or an article share), or by the activity_log_sid a 409 named. result.outcome: sent (item is what it made, or null with reason result_pending or caller_confirmed), in_flight, unknown (not shown yet; retry_after, send_decisive_at), or not_sent (no_send_under_key, refused, not_on_linkedin, caller_confirmed). Repeat the send only on not_sent, under the same key. result.activity_log_sid is the attempt confirmed_not_sent / confirmed_sent name on the send. A send in doubt has LinkedIn read now when the last look is old enough. A key sent to several places is 422 place_required, a place LinkedIn could not be read for 422 place_unmatched.",
    toolClass: 'complex',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-posting/check-sent' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      linkedin_account_sid: ACCOUNT_SID.describe('The account that sent (ln_ac_…). A key is looked up on this account only.'),
      client_reference: z.string().min(1).max(255).nullable().optional()
        .describe('The key the send went out under, byte for byte. Exactly one of client_reference / activity_log_sid. Found at any age: a send in doubt never ages out of its key.'),
      activity_log_sid: z.string().length(18).startsWith('ln_al_').nullable().optional()
        .describe('The attempt a 409 or an earlier check named (ln_al_…); it takes no verb and no place. An attempt of another account, or one that is no comment, post, repost or article share, is 404.'),
      verb: z.enum(['comment', 'create-post', 'repost', 'create-article', 'publish-article']).nullable().optional()
        .describe('Required with client_reference: the verb the key was sent by (create_linkedin_comment, create_linkedin_post, repost_linkedin_post, create_linkedin_article with a share, publish_linkedin_article). A key is one send per verb.'),
      entity_urn: z.string().max(512).nullable().optional()
        .describe('Place, next to client_reference: the post a comment or a repost went to, as the send took it or in any other of its forms (it is read for its thread, on the post-details cache), or a comment urn for a reply. Not with create-post, create-article or publish-article.'),
      parent_comment_urn: z.string().max(512).nullable().optional()
        .describe('Place, next to client_reference and verb comment: the comment a reply answers, in either of its forms.'),
      post_place: z.string().max(128).regex(POST_PLACE_RE).nullable().optional()
        .describe('Place, next to client_reference and verb create-post, create-article or publish-article: where the post or the article share landed: feed:member (your own feed), feed:org:<id> (a company page it was posted as), group:<id> (a group; group:<id>:org:<id> when a page posted into it), and for publish-article article:<id> (the article shared: its author is read by the node, so no feed is named and a lost answer stays unknown until confirmed_sent or confirmed_not_sent), optionally :scheduled:<unix ms> after any of them. A key is read at the feed, page, group or article whatever its slot.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(PostingSendItem, CheckSentResult),
    annotations: { title: 'Check whether a LinkedIn comment, post, repost or article share went out', ...LIVE_READ },
  },
];
