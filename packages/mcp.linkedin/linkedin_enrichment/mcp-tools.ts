// Entity: LinkedIn Enrichment (gtm.service.linkedin)
// Source of truth: product/research/gtm.service.linkedin/entities/linkedin_enrichment.md
// Format: registry v2, where each tool carries route metadata so the generic
// dispatcher can drive it. 22 verb-only tools on the /api/linkedin-enrichment/*
// surface: one-shot pulls of ONE known target's OWN data, run on the team's
// own connected accounts.
//
// Stateless surface over the DataRequest ledger (kind='enrich'): every accepted
// call is a thin pass through DataRequestExecutionService (§9.5 executor
// resolution, 2026-08-14 rework: pinned account only, or an auto-picked own
// account; cache, idempotency, §5.9 stub guard) and lands as one
// ledger row, embedded in the response as `result.data_request`. Execution is
// SYNC inline (≤120 s, §9.6); every response is a sync action envelope
// (`async: true` never appears here: the controller uses mcpAction for all 22).
//
// All 22 methods are live (GA) as of 2026-08-27: person-languages, the last
// §5.9 blocked-on-plugin 501 stub, went live with node get-languages (post
// details had gone live 2026-08-14 with node get-post). The §5.9 mechanism
// stays for future reserved rows: the 501 is raised by
// DataRequestExecutionService when the method enum's wireGetter() is null
// (DataRequestMethodEnum::isImplemented()), availability: 'stub_501'.
//
// 2026-08-06, rows 60 / 61 / 62 (reaction-activity, interests, services) went
// live and their reserved shapes were rewritten to the node's own, per the
// § CONTRACT AUTHORITY rule: the wire is the contract, so an invented field
// goes (`post_text_preview`), a renamed one takes the wire's name back
// (followers_number to followers_count, services/services_page_url to the
// ProfileServices object) and the tab that selects WHICH interests list is read
// became a real request member instead of an aggregate we cannot ask for.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import { usageMetaField, McpActionResponse } from '@gtm/mcp-shared';

// ─── Shared input fragments ────────────────────────────────────────────────

// Executor + replay controls, shared by all 22 methods (§9.5, own-accounts-only
// contract, 2026-08-14): runs always land on one of the team's own connected
// accounts: pinned when linkedin_account_sid is given, auto-picked otherwise.
const executorFields = {
  linkedin_account_sid: z.string().length(18).startsWith('ln_ac_').nullable().optional()
    .describe('Executor account (ln_ac_...). Given: the call runs on that account ONLY; a saturated or held enrichment bucket refuses 429 bucket_saturated (with retry_after). Omitted: the service auto-picks one of your connected accounts with remaining capacity (422 no_connected_accounts when none is ready, 429 when all are at capacity).'),
  idempotency_key: z.string().max(128).nullable().optional()
    .describe('Replay guard (team_sid, idempotency_key). A repeat with the same key returns the stored ledger outcome without running again, except a failure that answered with retry_after: once that time has passed, a repeat under the same key runs again.'),
  trust_cache_max_age_days: z.number().int().min(1).max(3650).nullable().optional()
    .describe('Accept a stored payload this many days old instead of fetching (probe tier 2, §9.5): a hit answers with served_from_cache / cache_source "data_cluster", spending no browser run and no bucket slot. Omitted, the stored payload is never consulted and the call always dispatches.'),
};

// Person target: EXACTLY ONE of the two (both/neither → 422, backend-validated).
const personTargetFields = {
  profile_id: z.string().max(128).optional()
    .describe('ln_id (ACoAA…) or sn_id (ACwAA…), interchangeable for dispatch. Provide profile_id XOR public_identifier.'),
  public_identifier: z.string().max(2048).optional()
    .describe('Vanity slug from /in/…, or the whole profile URL it comes from (any linkedin.com host, locale or mwlite prefix, query and trailing slash included): the URL is reduced to the slug before dispatch, and both forms share one ledger entry. A linkedin.com URL that is NOT a profile URL is refused 422 public_identifier_not_resolvable instead of being sent as a slug. Provide public_identifier XOR profile_id. On sub-record methods a slug-only call needs a stored URN (run person-lite-profile first) or is refused not_dispatchable.'),
};

// Pagination for sub-record list methods (wire offset cursor, opaque to callers).
const pageFields = {
  page_size: z.number().int().min(1).max(100).optional()
    .describe('Items per page, 1..100 (wire default 10).'),
  cursor: z.string().nullable().optional()
    .describe('Opaque cursor: pass back paging.next_page_cursor verbatim; omitted = first page.'),
};

// Company target (company-profile / company-lite-profile): `company_url` XOR
// `domain`, both backend-validated by a required_without + prohibits pair, so
// neither given and both given are each a 422.
const companyTargetFields = {
  company_url: z.string().max(2048).nullable().optional()
    .describe('https://www.linkedin.com/company/{slug}/ (or a Sales Nav company URL). Provide company_url XOR domain.'),
  domain: z.string().max(191).nullable().optional()
    .describe('The company website instead of its LinkedIn URL (`acme.com`, `www.acme.com` and `https://acme.com/pricing` all fold to the same host): resolved to a LinkedIn identity through the stored corpus, so a miss is refused company_not_resolvable rather than searched for live. This is the way to turn a domain you already have into the company profile. Provide domain XOR company_url.'),
};

// Company target, company-posts only: NESTED and id-first. The wire getter has
// no vanity addressing, so a bare company_url is accepted by validation and then
// refused not_dispatchable; company_ln_id is the path that works. Exactly one of
// the two (the FormRequest `prohibits` the other).
const companyPostsTargetField = {
  company: z.object({
    company_ln_id: z.string().max(64).nullable().optional()
      .describe('Numeric LinkedIn company id: the `company_id` returned by enrich_linkedin_company_profile. THIS is the dispatchable form.'),
    company_url: z.string().max(512).startsWith('https://www.linkedin.com/').nullable().optional()
      .describe('Vanity company URL. Ledgered, then refused not_dispatchable: only pass it if you deliberately want that. Provide company_ln_id instead.'),
  }).describe('Company target; exactly one of company_ln_id / company_url (both or neither is a 422).'),
};

// ─── Shared output fragments ────────────────────────────────────────────────
// Item projections tightened to the research field set (source of truth:
// research linkedin_enrichment.md §MCP Tools) and cross-checked against the
// actual emitted JSON in LinkedinEnrichmentController. Every item keeps a
// trailing .passthrough() so unmodeled wire fields still validate. The paging
// envelope stays loose: its wire key set is not modeled here (envelope, not item).

// The kind="enrich" DataRequestDomain ledger row: its full field set is owned
// by data_requests.md, so it stays loose here (not this surface's projection).
const DataRequestRow = z.object({}).passthrough()
  .describe('The kind="enrich" DataRequest journal row (status / served_from_cache / cached_from_sid). The public audit anchor for this call. A receipt: its result_ref is null here, the payload is the item next to it; get_data_request by sid reads the stored payload back.');

// Generic loose item, used for full-profile's RAW-WIRE truncated sub-record
// heads, which diverge from the dedicated methods' projected shapes (the head
// skills carry the wire `id`; the posts head left the profile on 2026-11-03).
const LooseItem = z.object({}).passthrough();

// Paged wrapper factory ({elements, paging}). The element shape is supplied per
// method so each list validates its own item projection. Paging stays loose.
const PagedList = (item: z.ZodTypeAny) => z.object({
  elements: z.array(item),
  paging: z.object({}).passthrough(),
}).passthrough();

// The cursor paging block the three SDUI-paged methods (comment-activity,
// reaction-activity, interests) all answer with, verbatim and identical. One
// definition, because three copies would be three places to drift.
const CursorPaging = z.object({
  page_size: z.number().int().nullable(),
  page_cursor: z.string().nullable(),
  next_page_cursor: z.string().nullable()
    .describe('Pass back as `cursor` for the next page. NULL means the feed is over. There is deliberately no total.'),
});

// Canonical identifier quad (KNOWLEDGE §3) returned by person-addressed methods.
const PersonRef = z.object({
  ln_member_id: z.string().nullable(),
  ln_id: z.string().nullable(),
  sn_id: z.string().nullable(),
  nickname: z.string().nullable(),
}).passthrough();

// person-experience item (row 50): raw-wire work-history row (no per-item projection).
const ExperienceItem = z.object({
  company_name: z.string().nullable(),
  company_public_identifier: z.string().nullable(),
  company_id: z.string().nullable(),
  position: z.string().nullable(),
  employment_type: z.string().nullable(),
  location: z.string().nullable(),
  start_date: z.string().nullable(),
  end_date: z.string().nullable(),
  description: z.string().nullable(),
  position_id: z.string().nullable().optional()
    .describe("The connected account's OWN profile only: the numeric id behind urn:li:fsd_profilePosition, the key of the position editing verbs. Absent on other members' profiles."),
}).passthrough();

// person-skills item (row 51): controller renames the wire `id` to `skill_id`.
const SkillItem = z.object({
  name: z.string(),
  skill_id: z.string().nullable(),
  urn: z.string().nullable(),
  endorsement_count: z.number().nullable(),
}).passthrough();

// person-education item (row 52): a row of the whole "Show all educations"
// list (2026-11-11; before it the profile page's card, its first two schools).
const EducationItem = z.object({
  school_name: z.string().nullable(),
  company_id: z.string().nullable(),
  school_public_identifier: z.string().nullable().describe("The vanity of the school's LinkedIn page; null for a school with no page."),
  school_logo_url: z.string().nullable().describe("The school's logo, a signed LinkedIn CDN link that expires."),
  degree: z.string().nullable().describe("As the member wrote it ('Bachelor’s Degree')."),
  field_of_study: z.string().nullable(),
  start_date: z.string().nullable(),
  end_date: z.string().nullable(),
  description: z.string().nullable(),
}).passthrough();

// Author ref embedded in post + activity items.
const PostAuthorRef = z.object({
  name: z.string(),
  headline: z.string().nullable(),
  profile_id: z.string().nullable(),
  public_identifier: z.string().nullable(),
  profile_url: z.string().nullable(),
  picture_url: z.string().nullable(),
}).passthrough();

// The group a post was published in (wire Post.group, 2026-08-21). Only on
// group posts; null everywhere else. ⚠️ On a group post the CARD ACTOR is the
// group itself, so `author` is reconstructed from the card's description line:
// a bare name with profile_url / picture_url / ids all null - do not read a
// null profile_url there as "organization author" (that inference belongs to
// content-search rows, not group posts).
const PostGroupRef = z.object({
  group_id: z.string().nullable(),
  name: z.string(),
  url: z.string().nullable(),
  logo_url: z.string().nullable(),
}).passthrough();

// person-posts item (row 53): controller rewrites created_at (top-level + the
// nested reshared_post) from epoch-ms to ISO 8601; every other field passes
// through - which is how `group` reaches this surface on all four post
// readers (person-posts / company-posts / post-details / get-post-by-link).
// `.optional()` because §9.5 TTL-cached payloads written before 2026-08-21
// predate the key.
const PostItem = z.object({
  activity_urn: z.string(),
  post_urn: z.string().nullable(),
  url: z.string().nullable(),
  created_at: z.string().nullable(),
  text: z.string(),
  author: PostAuthorRef,
  images: z.array(z.string()),
  is_reshare: z.boolean(),
  reshared_post: z.object({
    activity_urn: z.string().nullable(),
    url: z.string().nullable(),
    created_at: z.string().nullable(),
    text: z.string(),
    author: PostAuthorRef,
    images: z.array(z.string()),
  }).passthrough().nullable(),
  group: PostGroupRef.nullable().optional(),
  num_likes: z.number(),
  num_comments: z.number(),
  num_shares: z.number(),
  num_impressions: z.number().nullable(),
  reactions: z.record(z.number()),
}).passthrough();

// person-featured item (row 54): element of the bare wire array payload.
const FeaturedItem = z.object({
  type: z.string().nullable(),
  url: z.string().nullable(),
  activity_urn: z.string().nullable(),
  title: z.string().nullable(),
  subtitle: z.string().nullable(),
  text: z.string().nullable(),
  image_url: z.string().nullable(),
  num_likes: z.number().nullable(),
  num_comments: z.number().nullable(),
}).passthrough();

// The degree the wire returns is relative to whichever account ran the fetch, so
// it is surfaced ONLY when the caller pinned linkedin_account_sid AND that account
// is the one that actually executed (a cached payload from another executor stays
// null). Otherwise null. It used to be stripped outright, which made the caller
// spend a second dispatch on linkedin-connections.check-degree for a value this
// call had already fetched.
const NETWORK_DISTANCE = z.string().nullable()
  .describe("Relationship degree relative to the pinned executor account ('1st' / '2nd' / '3rd'…). Null when no linkedin_account_sid was pinned, when the payload came from a cache another account filled, or when the wire did not report one. Never a degree relative to an account you did not name.");

// person-contact-info result (row 55): LinkedIn's contact card, as the wire carries it.
const ContactInfoResult = z.object({
  // Wire shape from LinkedinContactInfoMapper::fromWireProfile: singular email,
  // typed phones/websites objects (richer than the flat string[] sketch). The
  // birthday, the address, the messengers and WeChat are the rest of the same
  // card; the node parses them since plugin 1.8.0 (2026-11-10), and a body
  // stored before that reads them as null / []. `connected_at` of the first
  // sketch is not a contact: check_linkedin_connection_degree answers it.
  email: z.string().nullable(),
  phones: z.array(z.object({ type: z.string().nullable(), number: z.string() }).passthrough()),
  websites: z.array(z.object({ url: z.string(), category: z.string().nullable(), label: z.string().nullable() }).passthrough()),
  twitter_handles: z.array(z.string()),
  birthday: z.object({ day: z.number(), month: z.number() }).nullable()
    .describe('The day and month the member shares with connections. LinkedIn sends no year. Null when hidden.'),
  address: z.string().nullable().describe("The contact card's free-text address. Null when empty."),
  instant_messengers: z.array(z.object({ provider: z.string().nullable(), id: z.string() }).passthrough())
    .describe('Messenger handles: provider as LinkedIn names it (SKYPE, ...) and the handle.'),
  wechat: z.object({ name: z.string().nullable(), qr_url: z.string().nullable(), qr_image_url: z.string().nullable() }).nullable()
    .describe('The WeChat name and its QR links. Null when the member set none.'),
}).passthrough();

// person-full-profile result (row 49): scalar contract tightened (incl. the
// picture_url→avatar_url rework); network_distance rides along when attributable
// to the pinned executor (A8, 2026-08-14). Sub-record heads stay loose: they are
// RAW WIRE truncated heads, distinct from the dedicated methods' projected items.
const LiteProfileLocalized = z.object({
  locale: z.string(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  maiden_name: z.string().nullable(),
  headline: z.string().nullable(),
}).passthrough();

// The member's profile header, the same facts under the same names in the lite,
// basic and full answers. Locales are the profile's own language settings, not
// spoken languages.
const ProfileHeaderFacts = {
  maiden_name: z.string().nullable(),
  localized: z.array(LiteProfileLocalized).describe('The name and the headline in every language the member wrote them in.'),
  background_picture_url: z.string().nullable().describe('The cover image, a signed LinkedIn CDN link that expires.'),
  location: z.string().nullable().describe("The location as LinkedIn shows it ('Redmond, Washington, United States')."),
  location_without_country: z.string().nullable().describe("The location without its country ('Redmond, Washington')."),
  location_geo_id: z.string().nullable().describe("The location's geo id, the value LinkedIn's location search filter takes."),
  country: z.string().nullable(),
  country_geo_id: z.string().nullable(),
  postal_code: z.string().nullable(),
  primary_locale: z.string().nullable().describe("The profile's primary locale ('en_US'), not a spoken language."),
  primary_language: z.string().nullable().describe('Profile LOCALE language, not a spoken language.'),
  supported_locales: z.array(z.string()),
  supported_languages: z.array(z.string()).describe('Profile locales, not spoken languages, and no proficiency.'),
  is_premium: z.boolean().nullable(),
  has_premium_subscriber_badge: z.boolean().nullable(),
  has_verified_profile: z.boolean().nullable().describe('The verification badge.'),
  is_influencer: z.boolean().nullable(),
  is_creator: z.boolean().nullable(),
  is_open_to_work: z.boolean().nullable().describe("The public #OpenToWork frame on the photo; false = no public frame (not 'not looking'); null with no photo."),
  is_hiring: z.boolean().nullable().describe("The public #Hiring frame on the photo; false = no #Hiring frame (not 'not hiring'); null with no photo."),
  top_voice_badge: z.string().nullable().describe("LinkedIn's Top Voice badge text; null without one."),
  creator_hashtags: z.array(z.string()),
  creator_website: z.string().nullable(),
  pronoun: z.string().nullable(),
  status: z.object({ text: z.string().nullable(), emoji: z.string().nullable(), expires_at: z.string().nullable() }).nullable(),
  birthday: z.object({ day: z.number().nullable(), month: z.number().nullable(), year: z.number().nullable() }).nullable().describe('Shared with the reading account only.'),
};

const PendingInvitation = z.object({
  direction: z.enum(['sent', 'received']).nullable(),
  invitation_id: z.string().nullable(),
}).nullable().describe('The invitation pending between the pinned account and the member, with its exact id (what a withdrawal or a reply names). Null when none, or when the read was not the pinned account\'s.');

const FullProfileResult = z.object({
  ln_member_id: z.string().nullable(),
  ln_id: z.string().nullable(),
  sn_id: z.string().nullable(),
  nickname: z.string().nullable(),
  // The name in its parts (2026-11-10, plugin 1.8.0): absent on a body stored
  // before that, hence optional. The node glues nothing since then: full_name
  // is computed by the service, the stated line else the parts joined.
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  full_name: z.string().describe("The name as one line: the line the stored body states, else first_name and last_name joined; '' when unknown."),
  network_distance: NETWORK_DISTANCE,
  connected_at: z.string().nullable().optional(),
  pending_invitation: PendingInvitation.optional(),
  headline: z.string().nullable(),
  // Every fact of the lite read (2026-11-11): the full read starts from it.
  // Optional, absent on a body stored before that day.
  ...Object.fromEntries(Object.entries(ProfileHeaderFacts).map(([key, schema]) => [key, schema.optional()])) as {
    [K in keyof typeof ProfileHeaderFacts]: z.ZodOptional<(typeof ProfileHeaderFacts)[K]>
  },
  position: z.string().nullable(),
  company_name: z.string().nullable(),
  company_public_identifier: z.string().nullable(),
  about: z.string().nullable(),
  avatar_url: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  twitter: z.string().nullable(),
  facebook: z.string().nullable(),
  contact_info: ContactInfoResult,
  connections_number: z.number().nullable(),
  followers_number: z.number().nullable(),
  has_open_profile: z.boolean().nullable(),
  has_premium: z.boolean().nullable(),
  is_open_to_work: z.boolean().nullable().optional()
    .describe('True when the member shows the public #OpenToWork photo frame. False when the profile photo has no such frame: a member who shares Open to Work with recruiters only reads false too. Absent or null when unknown (no photo in the answer, or a payload cached before this field existed).'),
  is_hiring: z.boolean().nullable().optional()
    .describe('True when the member shows the public #Hiring photo frame. False when the profile photo has no such frame: the frame is optional, so false does not mean the member is not hiring. Never true together with is_open_to_work (a photo carries one frame). Absent or null when unknown (no photo in the answer, or a payload cached before this field existed).'),
  experience: z.array(LooseItem),   // the whole list, 100 rows read (2026-11-11); paged: person-experience
  educations: z.array(LooseItem),   // the whole list, the same rows person-education reads
  skills: z.array(LooseItem),       // the whole list, 100 rows read (carries wire `id`, not skill_id)
  // No `posts` since 2026-11-03: the feed is person-posts; the head left the node's live profile read.
  top_voices: z.array(LooseItem),   // followed Top Voices; open-ended wire shape
  featured: z.array(LooseItem),     // pinned Featured head; raw-wire
}).passthrough();

// person-lite-profile result (row 48): the identifier quad, then everything ONE
// request of LinkedIn's basic profile query states about the member (2026-11-11,
// Eugene: whatever we can give, we give): the name in its parts and in every
// locale, the headline, the photo and the cover, the location with its geo ids,
// the locales, the premium, verification, creator and Top Voice marks, the
// status, and the reading account's relationship to the member. That query
// takes a slug, a profile id or a Sales Navigator id alike, which is how this
// read turns one identifier into the others. No contact card (LinkedIn's
// contact card query is asked for the card alone): person-contact-info.
const LiteProfileResult = PersonRef.extend({
  first_name: z.string().nullable().describe('The first name as LinkedIn returns it. Null when the answer came from a body that has no name parts (a cached full profile, a body stored before 2026-11-10); never a split of full_name.'),
  last_name: z.string().nullable().describe('The last name as LinkedIn returns it. Null on the same bodies as first_name.'),
  full_name: z.string().describe("The name as one line: the line the stored body states, else first_name and last_name joined; '' when unknown."),
  headline: z.string().nullable().describe("The profile's headline. Null when LinkedIn states none for the member."),
  avatar_url: z.string().nullable().describe('The photo, re-hosted on our storage (a durable link), for any member who shows one, whatever the degree. Null when the member shows none.'),
  ...ProfileHeaderFacts,
  is_memorialized: z.boolean().nullable().describe("LinkedIn's mark on the account of a member who died (the profile reads 'In memoriam'): do not contact. Null when unknown."),
  is_email_required_to_connect: z.boolean().nullable().describe("LinkedIn asks for the member's email address before a connection request can be sent to them, as it told the reading account. Stated only while the two are not connected and no invitation is pending; null otherwise."),
  network_distance: NETWORK_DISTANCE,
  connected_at: z.string().nullable().describe('ISO 8601 of the moment the pinned account and the member connected; null unless 1st degree, or when the read was not the pinned account\'s.'),
  pending_invitation: PendingInvitation,
});

// person-languages item (row 56, LIVE 2026-08-27; shape finalized against the wire).
const LanguageItem = z.object({
  name: z.string(),
  proficiency: z.string().nullable(),
}).passthrough();

// person-certifications item (row 57, live; shape finalized against the wire).
const CertificationItem = z.object({
  name: z.string(),
  authority: z.string().nullable(),
  license_number: z.string().nullable(),
  issued_at: z.string().nullable(),
  expires_at: z.string().nullable(),
  url: z.string().nullable(),
}).passthrough();

// person-recommendations item (row 58 stub; reserved shape).
const RecommendationItem = z.object({
  direction: z.enum(['received', 'given']),
  counterpart: PersonRef.extend({
    full_name: z.string().nullable(),
    headline: z.string().nullable(),
  }),
  relationship: z.string().nullable(),
  text: z.string(),
  created_at: z.string().nullable(),
}).passthrough();

// person-comment-activity item (row 59 stub; reserved shape).
const CommentActivityItem = z.object({
  comment_urn: z.string(),
  activity_urn: z.string(),
  post_url: z.string().nullable(),
  post_author: PostAuthorRef.nullable(),
  text: z.string(),
  created_at: z.string().nullable(),
  num_impressions: z.number().int().nullable()
    .describe('How many times LinkedIn showed the comment. Filled only when the executing account is the member whose comments are read: LinkedIn tells impressions for one\'s own comments alone, so a read of another member carries null throughout.'),
}).passthrough();

// person-reaction-activity item (row 60), mirroring the node's `ProfileReaction`
// (linkedinApiSdk reactions/types.ts) as the backend projects it.
//
// The reserved shape declared a `post_text_preview` that exists on no wire, put
// the reaction time under `created_at`, and typed reaction_type non-nullable.
// All three are corrected here: LinkedIn ships NO structured member-reaction
// field, so the node derives the type from the element header phrase and
// degrades to null on an unmapped phrase, and the parent post comes back WHOLE
// rather than as a preview string.
const ReactionActivityItem = z.object({
  reaction_type: z.string().nullable()
    .describe('LIKE / PRAISE / EMPATHY / INTEREST / APPRECIATION / ENTERTAINMENT / MAYBE, or null when the header phrase did not map. Null is the wire being honest, not a parse failure.'),
  reacted_at: z.string().nullable()
    .describe('ISO 8601 with milliseconds: when the TARGET reacted, which is not the post\'s own time (post.created_at, kept in wire epoch-ms).'),
  activity_urn: z.string().nullable(),
  post_url: z.string().nullable(),
  post_author: PostAuthorRef.nullable(),
  post: LooseItem.nullable()
    .describe('The parent post passed through whole, so you can read what they reacted to without a second call.'),
}).passthrough();

// person-interests card (row 61), the node's `ProfileInterest` field for field.
// The reserved item carried name / url / followers_number only; six of the nine
// wire fields were dropped and the follower count was renamed. Widened here.
const InterestItem = z.object({
  type: z.string().nullable(),
  urn: z.string().nullable(),
  name: z.string(),
  subtitle: z.string().nullable(),
  url: z.string().nullable(),
  public_identifier: z.string().nullable(),
  image_url: z.string().nullable()
    .describe('LinkedIn CDN link, wire passthrough: it carries LinkedIn\'s own expiry (roughly 30 days).'),
  followers_text: z.string().nullable(),
  followers_count: z.number().nullable()
    .describe('Null on a group card by design: a group renders a members line, a different metric that is not laundered into the followers fields.'),
}).passthrough();

// person-services result (row 62): the node's `ProfileServices`, or NULL.
const ProfileServicesResult = z.object({
  page_id: z.string().nullable()
    .describe('The page\'s vanity slug for a published page (the tail of /services/page/<slug>; an older capture carried a numeric id). The whole result is null while the owner keeps the page unpublished.'),
  page_url: z.string().nullable(),
  business_name: z.string().nullable(),
  provider_name: z.string().nullable(),
  provider_public_identifier: z.string().nullable(),
  pricing_text: z.string().nullable(),
  services_provided: z.array(z.string()),
}).passthrough();

// company-profile result (row 70 stub; reserved shape).
const CompanyProfileResult = z.object({
  company_id: z.string().nullable(),
  universal_name: z.string().nullable(),
  name: z.string().nullable(),
  url: z.string().nullable(),
  website: z.string().nullable(),
  industry: z.string().nullable(),
  headquarters: z.string().nullable(),
  employee_count_range: z.string().nullable(),
  followers_number: z.number().nullable(),
  founded_year: z.number().nullable(),
  about: z.string().nullable(),
  specialities: z.array(z.string()),
  logo_url: z.string().nullable(),
}).passthrough();

// item is ALWAYS null on this stateless surface (controller passes item: null).
const NullItem = z.null();

// ─── Shared annotations ─────────────────────────────────────────────────────
// Live pulls: not read-only (they trigger a live fetch on one of your own
// accounts), not idempotent (a repeat outside the cache TTL re-executes), not destructive
// (enrichment reads data). Matches research per-method annotations.
const LIVE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const base = {
  service: 'linkedin',
  // Every tool of this package dispatches a read to the account's browser.
  pacedBucket: 'enrichment',
  entity: 'linkedin_enrichment',
  mount: 'linkedin.enrichment',
} as const;

const STUB = '⛔ NOT SHIPPED YET. Contract locked, capability not built; returns not_implemented, do not retry. ';

export const linkedinEnrichmentTools: ToolDefinition[] = [
  {
    ...base,
    name: 'enrich_linkedin_person_lite_profile',
    description:
      "Cheapest person read, ONE LinkedIn request, and everything it states: existence check + full identifier resolution. THE tool for turning a vanity slug (/in/…) into the URNs, or a bare URN (a profile id or a Sales Navigator id) into the slug: it returns the canonical identifier quad (ln_member_id + both URNs + nickname). Also the name (full_name computed), the headline, the photo and cover, the location with its geo ids (location_geo_id feeds the location search filter), the locales, the premium, verified, creator, open-to-work, hiring and Top Voice marks, the status, is_memorialized (do not contact) and is_email_required_to_connect. Pin linkedin_account_sid and network_distance, connected_at and pending_invitation are that account's; unpinned they are null. No contact card: enrich_linkedin_person_contact_info. cached 24h. Address by profile_id XOR public_identifier.",
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-enrichment/person-lite-profile' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ ...personTargetFields, ...executorFields, ...usageMetaField }),
    outputSchema: McpActionResponse(NullItem, z.object({ profile: LiteProfileResult, data_request: DataRequestRow }).passthrough()),
    annotations: { title: 'Enrich person lite profile', ...LIVE },
  },
  {
    ...base,
    name: 'enrich_linkedin_person_basic_profile',
    description:
      "The same ONE LinkedIn request and the same facts as enrich_linkedin_person_lite_profile, under the wire's own names (id, urn, public_identifier, picture_url): the name, headline, location with its geo ids, locales, cover, the premium / influencer / creator / verified / Top Voice marks, the status, and the pinned account's degree, connection date and pending invitation (null when the read was not that account's). cached 24h. Address by profile_id XOR public_identifier. NOTE primary_language and supported_languages are the profile's LOCALE settings, i.e. which language the profile is written in. They are NOT the Languages section and carry no proficiency; do not read them as 'this person speaks these languages'.",
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-enrichment/person-basic-profile' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ ...personTargetFields, ...executorFields, ...usageMetaField }),
    outputSchema: McpActionResponse(NullItem, z.object({
      profile: z.object({
        id: z.string(),
        urn: z.string(),
        member_id: z.string().nullable(),
        member_urn: z.string().nullable(),
        public_identifier: z.string(),
        first_name: z.string(),
        last_name: z.string(),
        full_name: z.string(),
        headline: z.string().nullable(),
        picture_url: z.string().nullable(),
        ...ProfileHeaderFacts,
        is_memorialized: z.boolean().nullable(),
        is_email_required_to_connect: z.boolean().nullable(),
        network_distance: NETWORK_DISTANCE,
        connected_at: z.string().nullable(),
        pending_invitation: PendingInvitation,
      }).passthrough(),
      data_request: DataRequestRow,
    }).passthrough()),
    annotations: { title: 'Enrich person basic profile', ...LIVE },
  },
  {
    ...base,
    name: 'enrich_linkedin_company_lite_profile',
    description:
      "The cheap company read: id, vanity, name and logo, nothing else. Deliberately sparse, the company twin of the lite person profile. Use it to confirm a company exists and to pin its identifiers before joining data; use enrich_linkedin_company_profile when you actually need industry, size, HQ or the about text. cached 7d. COST NOTE: a /company/<slug>/ URL is ONE small request on LinkedIn's side, while a Sales Navigator /sales/company/<id> URL costs TWO, because the vanity has to be resolved first (measured: 433 ms vs 2479 ms). Prefer the vanity URL, or resolve the id once with enrich_linkedin_company_public_identifier and reuse it.",
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-enrichment/company-lite-profile' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      ...companyTargetFields,
      ...executorFields,
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(NullItem, z.object({
      company: z.object({
        id: z.string(),
        urn: z.string(),
        public_identifier: z.string(),
        name: z.string(),
        logo_url: z.string().nullable(),
      }).passthrough(),
      data_request: DataRequestRow,
    }).passthrough()),
    annotations: { title: 'Enrich company lite profile', ...LIVE },
  },
  {
    ...base,
    name: 'enrich_linkedin_company_public_identifier',
    description:
      "Resolve a numeric LinkedIn company id to its vanity slug. Its own method because this resolution is the single most expensive company request LinkedIn serves: a ~164KB organizational-page download, the only id-native request that reveals the vanity. Cached 30d, since the mapping does not change. The pattern that keeps company work cheap: resolve the id ONCE here, then call every other company read by vanity.",
    toolClass: 'trivial',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-enrichment/company-public-identifier' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      company_id: z.string().regex(/^\d+$/).max(32).describe('Numeric LinkedIn company id, e.g. from a Sales Navigator URL or an organization urn.'),
      ...executorFields,
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(NullItem, z.object({
      public_identifier: z.string().nullable().describe('The vanity slug, or null when the id resolves to nothing.'),
      data_request: DataRequestRow,
    }).passthrough()),
    annotations: { title: 'Resolve company vanity', ...LIVE },
  },
  {
    ...base,
    name: 'enrich_linkedin_person_full_profile',
    description:
      'The complete person dossier: every fact enrich_linkedin_person_lite_profile states (identity, headline, location with geo ids, locales, cover, premium / verified / creator / open-to-work / hiring / Top Voice marks), plus position/company, about, follower/connection counts, the contact card as LinkedIn shows it to the reading account (contact_info, in person-contact-info\'s shape), and the WHOLE experience, education and skills lists (up to 100 rows each; no posts since 2026-11-03: the feed is person-posts). Eight or nine LinkedIn requests (the education list one of them), cached 24h. One full profile beats separate subset calls when you need profile + 2 or more sections. picture_url is normalized to avatar_url.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-enrichment/person-full-profile' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ ...personTargetFields, ...executorFields, ...usageMetaField }),
    outputSchema: McpActionResponse(NullItem, z.object({ profile: FullProfileResult, data_request: DataRequestRow }).passthrough()),
    annotations: { title: 'Enrich person full profile', ...LIVE },
  },
  {
    ...base,
    name: 'enrich_linkedin_person_experience',
    description:
      'Complete, paginated work history ("Show all experiences"), unlike the truncated head on full-profile. One call = one page; loop cursor until paging.next_page_cursor is absent. cached 7d. A public_identifier-only call needs a stored URN (run person-lite-profile first) or is refused not_dispatchable. On the connected account\'s OWN profile each entry also carries position_id, the key of the position editing verbs.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-enrichment/person-experience' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ ...personTargetFields, ...pageFields, ...executorFields, ...usageMetaField }),
    outputSchema: McpActionResponse(NullItem, z.object({ experience: PagedList(ExperienceItem), data_request: DataRequestRow }).passthrough()),
    annotations: { title: 'Enrich person experience', ...LIVE },
  },
  {
    ...base,
    name: 'enrich_linkedin_person_skills',
    description:
      'Complete, paginated skills list ("Show all skills") with endorsement counts (skill_id is the endorse handle). cached 7d. Use to see/reason over skills; to simply ENDORSE, use linkedin-accounts.endorse-skill (auto-discovers skills, no enrich call needed). A public_identifier-only call needs a stored URN.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-enrichment/person-skills' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ ...personTargetFields, ...pageFields, ...executorFields, ...usageMetaField }),
    outputSchema: McpActionResponse(NullItem, z.object({ skills: PagedList(SkillItem), data_request: DataRequestRow }).passthrough()),
    annotations: { title: 'Enrich person skills', ...LIVE },
  },
  {
    ...base,
    name: 'enrich_linkedin_person_education',
    description:
      'Education history only, every school (the whole Show all educations list): ONE LinkedIn request by profile_id, two by public_identifier (the list takes the id alone, so the slug is resolved first). Each school: name, its page vanity and id, logo, degree and field of study apart, the years, the texts under it. cached 7d under its own method key (a cached full profile does NOT satisfy it). Not paginated.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-enrichment/person-education' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ ...personTargetFields, ...executorFields, ...usageMetaField }),
    outputSchema: McpActionResponse(NullItem, z.object({ educations: z.array(EducationItem), data_request: DataRequestRow }).passthrough()),
    annotations: { title: 'Enrich person education', ...LIVE },
  },
  {
    ...base,
    name: 'enrich_linkedin_person_posts',
    description:
      "Posts authored or reshared by the target, newest-first: the personalization goldmine before outreach. Reshares carry the original in reshared_post; created_at is ISO 8601. cached 7d. This is the target's OWN feed; to harvest who ENGAGED with a post use the scraping surface. A public_identifier-only call needs a stored URN.",
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-enrichment/person-posts' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ ...personTargetFields, ...pageFields, ...executorFields, ...usageMetaField }),
    outputSchema: McpActionResponse(NullItem, z.object({ posts: PagedList(PostItem), data_request: DataRequestRow }).passthrough()),
    annotations: { title: 'Enrich person posts', ...LIVE },
  },
  {
    ...base,
    name: 'enrich_linkedin_person_featured',
    description:
      "The Featured section: what the target chose to pin (posts, links, media). Small, cheap, high-signal for personalization: pinned content is what the person WANTS noticed. cached 7d. Not paginated. A public_identifier-only call needs a stored URN.",
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-enrichment/person-featured' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ ...personTargetFields, ...executorFields, ...usageMetaField }),
    outputSchema: McpActionResponse(NullItem, z.object({ featured: z.array(FeaturedItem), data_request: DataRequestRow }).passthrough()),
    annotations: { title: 'Enrich person featured', ...LIVE },
  },
  {
    ...base,
    name: 'enrich_linkedin_person_contact_info',
    description:
      "Contact details for ONE person, LinkedIn's whole contact card: email, phones (typed, so HOME/WORK is kept, unlike the lossy flat `phone` on person-full-profile), websites, twitter handles, the birthday (day and month, LinkedIn sends no year), the address, messenger handles and WeChat. One LinkedIn request, cached 24h. IMPORTANT: LinkedIn reveals contacts to 1st-degree connections ONLY, so this runs from whichever of YOUR accounts is connected to the target (picked automatically, respecting limits; linkedin_account_sid is only a preference). If none of your accounts is connected it refuses 422 no_connected_account, so connect first (linkedin_connection_requests send), then retry after the invite is accepted. An empty block means the connected account still cannot see them.",
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-enrichment/person-contact-info' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ ...personTargetFields, ...executorFields, ...usageMetaField }),
    outputSchema: McpActionResponse(NullItem, z.object({ contact_info: ContactInfoResult, data_request: DataRequestRow }).passthrough()),
    annotations: { title: 'Enrich person contact info', ...LIVE },
  },
  {
    ...base,
    name: 'enrich_linkedin_person_languages',
    description:
      'The Languages section: spoken languages with self-declared proficiency. Cheap localization signal: write the opener in the prospect\'s native language. cached 7d. Most profiles declare NONE, so an empty list is a real answer about the person rather than a failed read. proficiency is the RAW string LinkedIn renders, suffix included ("Native or bilingual proficiency", "Full professional proficiency", ...), localized on non-English sessions and null when the member declared the language without a level. Address by profile_id XOR public_identifier; like certifications, the screen behind this one needs the vanity slug AND the member urn at once, so the backend resolves whichever half you did not send.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-enrichment/person-languages' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ ...personTargetFields, ...executorFields, ...usageMetaField }),
    outputSchema: McpActionResponse(NullItem, z.object({ languages: z.array(LanguageItem), data_request: DataRequestRow }).passthrough()),
    annotations: { title: 'Enrich person languages', ...LIVE },
  },
  {
    ...base,
    name: 'enrich_linkedin_person_certifications',
    description:
      'Licenses and certifications from the target profile: issuing authority, license number, validity window. A qualification and compliance signal for recruiting and technical ICP fit. cached 7d. Most profiles have NONE, so an empty list is a real answer about the person rather than a failed read. license_number and url are frequently null even on real entries (LinkedIn own certifications carry neither). Address by profile_id XOR public_identifier, the same exactly-one-of rule as every other person read: passing both is a 422, they prohibit each other. The screen behind this one is the exception that needs the vanity slug AND the member urn at once, so the backend resolves whichever half you did not send. Addressing by public_identifier skips even that resolve once this team has enriched the person before, because the urn is then already on an earlier ledger row.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-enrichment/person-certifications' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ ...personTargetFields, ...executorFields, ...usageMetaField }),
    outputSchema: McpActionResponse(NullItem, z.object({ certifications: z.array(CertificationItem), data_request: DataRequestRow }).passthrough()),
    annotations: { title: 'Enrich person certifications', ...LIVE },
  },
  {
    ...base,
    name: 'enrich_linkedin_person_recommendations',
    description:
      "Recommendations on the target profile: who vouches for them and in what words. `direction` picks received (the default, what LinkedIn opens on) or given; these are two SEPARATE reads of the same screen, so asking for both runs the method twice. cached 7d. The counterpart carries a nickname, name, headline and network distance but NO ln_id: LinkedIn does not put the member urn in this payload, so enrich the nickname separately if you need the urn. created_at is parsed out of the free-text context line and is null when that line has no date. Address by profile_id XOR public_identifier, the same exactly-one-of rule as every other person read: passing both is a 422, they prohibit each other. The screen behind this one is the exception that needs the vanity slug AND the member urn at once, so the backend resolves whichever half you did not send.",
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-enrichment/person-recommendations' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      ...personTargetFields,
      direction: z.enum(['received', 'given']).nullable().optional()
        .describe('received (default) = written ABOUT the target; given = written BY the target. Separate reads, so each spends the method.'),
      ...executorFields,
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(NullItem, z.object({ recommendations: z.array(RecommendationItem), data_request: DataRequestRow }).passthrough()),
    annotations: { title: 'Enrich person recommendations', ...LIVE },
  },
  {
    ...base,
    name: 'enrich_linkedin_person_comment_activity',
    description:
      "The target's recent comments across OTHER people's posts (activity feed, Comments tab): where the target spends attention, and warm entry points for an opener. Each item carries the PARENT POST too, so you can read what they were reacting to without a second call. cached 7d, paginated. Addressed by profile_id alone. PAGING: the end of the feed is a MISSING paging.next_page_cursor, never an empty page, because member filtering can empty a page mid-feed; there is no total, LinkedIn reports 0 for this feed whatever is in it. The target's OWN posts are person-posts; the commenters OF a post are scraping.",
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-enrichment/person-comment-activity' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ ...personTargetFields, ...pageFields, ...executorFields, ...usageMetaField }),
    outputSchema: McpActionResponse(NullItem, z.object({
      comments: z.array(CommentActivityItem),
      paging: CursorPaging,
      data_request: DataRequestRow,
    }).passthrough()),
    annotations: { title: 'Enrich person comment activity', ...LIVE },
  },
  {
    ...base,
    name: 'enrich_linkedin_person_reaction_activity',
    description:
      "The target's recent reactions on OTHER people's posts (activity feed, Reactions tab): topical interest signal, cheaper to act on than comments. Each item carries the reaction type, when they reacted, and the PARENT POST whole. cached 7d, paginated. Addressed by profile_id alone. PAGING: the end of the feed is a MISSING paging.next_page_cursor, never an empty page; there is no total, LinkedIn reports 0 for this feed whatever is in it. reaction_type is null when the header phrase did not map, which is normal. The reactors OF a post are scraping (get-post-reactors).",
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-enrichment/person-reaction-activity' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ ...personTargetFields, ...pageFields, ...executorFields, ...usageMetaField }),
    outputSchema: McpActionResponse(NullItem, z.object({
      reactions: z.array(ReactionActivityItem),
      paging: CursorPaging,
      data_request: DataRequestRow,
    }).passthrough()),
    annotations: { title: 'Enrich person reaction activity', ...LIVE },
  },
  {
    ...base,
    name: 'enrich_linkedin_person_interests',
    description:
      'ONE tab of the Interests section per call: top_voices (the default), companies, groups, newsletters or schools. Cheap ICP-fit and conversation-hook signal. cached 7d, paginated. The wire pages a single tab, so reading all five spends the method five times; the requested tab is echoed at result.tab so a caller looping the vocabulary can tell the responses apart. Addressed by public_identifier ONLY: a urn-only call is ledgered and then refused not_dispatchable, so run person-lite-profile first if all you have is the urn.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-enrichment/person-interests' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      ...personTargetFields,
      tab: z.enum(['top_voices', 'companies', 'groups', 'newsletters', 'schools']).nullable().optional()
        .describe('Which interests tab to read; top_voices when omitted. One tab per call, each its own read.'),
      ...pageFields,
      ...executorFields,
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(NullItem, z.object({
      tab: z.string().describe('The tab this response is for, echoed back from the request.'),
      interests: z.array(InterestItem),
      paging: CursorPaging,
      data_request: DataRequestRow,
    }).passthrough()),
    annotations: { title: 'Enrich person interests', ...LIVE },
  },
  {
    ...base,
    name: 'enrich_linkedin_person_services',
    description:
      'The "Providing services" marketplace page of one service-provider profile: business name, pricing line, page URL and the standardized services they list. Complements scraping-side search-service-providers (that discovers providers, this reads one provider\'s own page). cached 7d, no pagination. result.services is NULL when the member sells no services at all, which is a different fact from a page whose services_provided is empty, and both are a normal completed read. A page its owner has UNPUBLISHED reads as null too (LinkedIn drops the link the read follows), which looks the same as never having had one.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-enrichment/person-services' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ ...personTargetFields, ...executorFields, ...usageMetaField }),
    outputSchema: McpActionResponse(NullItem, z.object({ services: ProfileServicesResult.nullable(), data_request: DataRequestRow }).passthrough()),
    annotations: { title: 'Enrich person services', ...LIVE },
  },
  {
    ...base,
    name: 'enrich_linkedin_company_profile',
    description:
      "One company page's own data: name, industry, size, HQ, about, website, followers. URL-addressed (ledgered input_kind='url'). cached 7d. To LIST a company's people use scraping (company-employees / company-decision-makers).",
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-enrichment/company-profile' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ ...companyTargetFields, ...executorFields, ...usageMetaField }),
    outputSchema: McpActionResponse(NullItem, z.object({ company: CompanyProfileResult, data_request: DataRequestRow }).passthrough()),
    annotations: { title: 'Enrich company profile', ...LIVE },
  },
  {
    ...base,
    name: 'enrich_linkedin_company_posts',
    description:
      "The company page's own feed, newest-first: the company-side twin of person-posts (author = the company page). Addressed by NUMERIC company id, nested: {company:{company_ln_id}}. If all you have is a company URL or slug, call enrich_linkedin_company_profile first and take company_id off its result; passing {company:{company_url}} here validates and is then refused not_dispatchable, having still opened a ledger row. cached 7d, paginated.",
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-enrichment/company-posts' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ ...companyPostsTargetField, ...pageFields, ...executorFields, ...usageMetaField }),
    outputSchema: McpActionResponse(NullItem, z.object({ posts: PagedList(PostItem), data_request: DataRequestRow }).passthrough()),
    annotations: { title: 'Enrich company posts', ...LIVE },
  },
  {
    ...base,
    name: 'enrich_linkedin_post_details',
    description:
      "One post's own data by its urn: full text, author, media, engagement counters, per-reaction breakdown, is_reshare with the original post embedded. LIVE since 2026-08-14 (node get-post). Accepts post_urn XOR url. result.post is null when the post is deleted or unavailable - a delivered answer, not an error, so do not retry it. Cached 7d. WHO engaged is scraping (get-post-comments / get-post-reactors / get-post-resharers); impressions exist only on the executor's own posts.",
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-enrichment/post-details' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      post_urn: z.string().max(128).optional()
        .describe('The post handle, in any family the wire takes: urn:li:activity:<id>, urn:li:share:<id>, urn:li:ugcPost:<id>, urn:li:groupPost:<group>-<post>, or a bare id (digits = activity, digits-digits = groupPost). Provide post_urn XOR url.'),
      url: z.string().max(2048).optional()
        .describe('Any post URL, a lnkd.in shortlink included. A feed permalink or a slug link carrying the id (activity or ugcPost family) resolves locally, one round trip; a shortlink is expanded server-side first (this is the form Copy link to post mints) and then resolves the same way; a linkedin.com link with NO id in it is fetched by the link itself, also one round trip. Provide url XOR post_urn.'),
      ...executorFields,
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(NullItem, z.object({ post: PostItem.nullable(), data_request: DataRequestRow }).passthrough()),
    annotations: { title: 'Enrich post details', ...LIVE },
  },
  {
    ...base,
    name: 'enrich_linkedin_get_activity_urn_by_url',
    description:
      'Resolve any linkedin.com post URL (feed permalink, /posts/ slug) or lnkd.in shortlink to its stable activity URN (urn:li:activity:…). A shortlink is expanded server-side before the page is opened. The URN never changes, so this is a cacheable enrichment lookup at cached 7d. It is the resolver the get-post-* / tracked-post flows build on. Returns activity_urn (null if the URL could not be resolved - notably a shortlink of a ugcPost-threaded post, whose page exposes no activity urn at all; address such posts by post_urn via enrich_linkedin_post_details instead, which takes the shortlink directly).',
    toolClass: 'trivial',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-enrichment/get-activity-urn-by-url' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      url: z.string().max(2048).describe('Any linkedin.com post URL (feed permalink, /posts/ slug, shortlink).'),
      ...executorFields,
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(NullItem, z.object({ activity_urn: z.string().nullable(), data_request: DataRequestRow }).passthrough()),
    annotations: { title: 'Enrich activity URN by URL', ...LIVE },
  },
];
