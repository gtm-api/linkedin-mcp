// Entity: LinkedIn Scraping surface (gtm.service.linkedin)
// Source of truth: product/research/gtm.service.linkedin/entities/linkedin_scraping.md
// Format: registry v2, where each tool carries route metadata so the generic
// dispatcher can drive it. 21 run-now discovery verbs (one per matrix row) on
// the stateless /api/linkedin-scraping/* surface. Each pulls a one-shot LIVE
// list of OTHER entities off LinkedIn and returns it sync inline (≤120 s).
//
// Availability is code-authoritative: DataRequestMethodEnum::isImplemented()
// (== wireGetter() !== null) gates the §5.9 stub guard in
// DataRequestExecutionService (501 before any ledger insert). 18 of the 21
// methods are GA today; the remaining 3 ship as 501 stubs until their plugin
// verbs land (search-service-providers, get-post-comments, param-id-lookup).
// Every verb is creditable (§9.5 flagless: own scraping bucket free,
// pool fallback debits credits); the credits block attaches at runtime.
// Envelope is always 'action' (synchronous mcpAction; no async on this
// surface). Nothing is dangerous: scraping reads data (dangerous:false).

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import { usageMetaField, McpActionResponse } from '@gtm/mcp-shared';

// ═══════════════════════════════════════════════════════════════
// Shared request machinery (§9.5), spread into every verb.
// ═══════════════════════════════════════════════════════════════

const requestBase = {
  linkedin_account_sid: z.string().length(18).startsWith('ln_ac_').nullable().optional()
    .describe('Preferred executor account (ln_ac_…). OPTIONAL everywhere on this surface: omitted → platform pool + credits (reason infra_pool); given with scraping-bucket budget → own account, charged 0; given but the bucket is saturated/held → automatic pool fallback (reason limit_fallback), never a 429 (§9.5).'),
  idempotency_key: z.string().max(128).nullable().optional()
    .describe('Ledger replay guard: a repeat call with the same (team, key) returns the stored outcome; no re-execution, no double charge. Recommended on every paid call.'),
} as const;

// ═══════════════════════════════════════════════════════════════
// Input value objects: by-params filter vocabularies (LinkedIn-ready
// wire values, passed through untranslated). At least one member non-empty.
// ═══════════════════════════════════════════════════════════════

const PeopleSearchFilters = z.object({
  keywords: z.string().max(256).nullable().optional().describe('Free-text query.'),
  first_name: z.string().max(100).nullable().optional(),
  last_name: z.string().max(100).nullable().optional(),
  title: z.string().max(256).nullable().optional().describe('Current-title keywords.'),
  company: z.string().max(256).nullable().optional().describe('Current-company keywords (free text; prefer current_companies).'),
  school: z.string().max(256).nullable().optional().describe('School free-text (the wire has no school-id facet).'),
  network: z.array(z.enum(['F', 'S', 'O'])).max(3).nullable().optional().describe('Relationship-degree facet; wire codes F=1st, S=2nd, O=3rd+.'),
  locations: z.array(z.string()).max(10).nullable().optional().describe('geo facet ids from param-id-lookup("geo").'),
  industries: z.array(z.string()).max(10).nullable().optional().describe('industry facet ids.'),
  current_companies: z.array(z.string()).max(10).nullable().optional().describe('company facet ids.'),
  past_companies: z.array(z.string()).max(10).nullable().optional().describe('past_company facet ids.'),
  service_categories: z.array(z.string()).max(10).nullable().optional().describe('service_category facet ids.'),
  connections_of: z.array(z.string()).max(10).nullable().optional().describe('Profile ids (ACoA…): people in these profiles’ connections.'),
  followers_of: z.array(z.string()).max(10).nullable().optional().describe('Profile ids (ACoA…): people following these profiles.'),
  profile_languages: z.array(z.string()).max(10).nullable().optional().describe('ISO 639-1 language codes.'),
  open_to_volunteer: z.boolean().nullable().optional(),
}).describe('Regular people-search filters. At least one member must be non-empty. Members are LinkedIn-ready wire values (passed through untranslated); facet-id members resolve via param-id-lookup.');

// One selected chip in an SN typeahead facet - the node FilterValue verbatim.
// id comes from scrape_linkedin_sales_nav_param_id_lookup (the member's describe
// names the lookup type); text is a free-text label SN matches server-side (no
// id needed); exclude flips the chip to a negative filter.
const SnFacetValue = z.object({
  id: z.string().max(128).nullable().optional().describe('Opaque SN facet id, VERBATIM from scrape_linkedin_sales_nav_param_id_lookup.'),
  text: z.string().max(256).nullable().optional().describe('Free-text label - SN matches it server-side; use when no id is at hand.'),
  exclude: z.boolean().nullable().optional().describe('true → EXCLUDED (negative filter); omitted/false → INCLUDED.'),
}).describe('One facet value: at least one of id / text.');

const snFacet = (desc: string) => z.array(SnFacetValue).max(10).nullable().optional().describe(desc);

const TENURE_LEGEND = "'1' <1 year, '2' 1-2, '3' 3-5, '4' 6-10, '5' 10+ years";
const TENURE_IDS = ['1', '2', '3', '4', '5'] as const;
const SN_FUNCTION_IDS = Array.from({ length: 26 }, (_, i) => String(i + 1)) as [string, ...string[]];
const SN_FUNCTION_LEGEND =
  "'1' Accounting, '2' Administrative, '3' Arts and Design, '4' Business Development, '5' Community and Social Services, "
  + "'6' Consulting, '7' Education, '8' Engineering, '9' Entrepreneurship, '10' Finance, '11' Healthcare Services, "
  + "'12' Human Resources, '13' Information Technology, '14' Legal, '15' Marketing, '16' Media and Communication, "
  + "'17' Military and Protective Services, '18' Operations, '19' Product Management, '20' Program and Project Management, "
  + "'21' Purchasing, '22' Quality Assurance, '23' Real Estate, '24' Research, '25' Sales, '26' Customer Success and Support";

const SalesNavPeopleSearchFilters = z.object({
  keywords: z.string().max(256).nullable().optional(),
  first_name: z.string().max(100).nullable().optional().describe('Text-only wire facet (no id space).'),
  last_name: z.string().max(100).nullable().optional().describe('Text-only wire facet (no id space).'),
  // Typeahead facets - [{id, text, exclude}] values; lookup type named per member.
  current_titles: snFacet('Current job titles. Ids via lookup(type: "TITLE") (numeric, e.g. "5" Director) - or just free text: [{text: "VP Marketing"}].'),
  past_titles: snFacet('Past job titles. Ids via lookup(type: "TITLE") or free text.'),
  locations: snFacet('Person geography. Ids via lookup(type: "BING_GEO") (e.g. "103644278" United States); regions like DACH/EMEA exist too.'),
  company_headquarters: snFacet('CURRENT COMPANY HQ region (not the person’s own location). Ids via lookup(type: "BING_GEO").'),
  industries: snFacet('Industries. Ids via lookup(type: "INDUSTRY") (numeric).'),
  current_companies: snFacet('Current employer. Ids via lookup(type: "COMPANY_WITH_LIST") - id shape urn:li:organization:N. exclude: true is the classic "not my customers" move.'),
  past_companies: snFacet('Past employer. Ids via lookup(type: "COMPANY_WITH_LIST").'),
  groups: snFacet('LinkedIn group membership. Ids via lookup(type: "GROUP").'),
  schools: snFacet('Schools attended. Ids via lookup(type: "SCHOOL") or free text.'),
  // Static closed-enum facets - full id sets inline, NO lookup call needed. A negative
  // selection is expressed by including the complement (the sets are closed).
  seniority_levels: z.array(z.enum(['100', '110', '120', '130', '200', '210', '220', '300', '310', '320'])).max(10).nullable().optional()
    .describe("SENIORITY_V2: '100' In Training, '110' Entry Level, '120' Senior, '130' Strategic, '200' Entry Level Manager, '210' Experienced Manager, '220' Director, '300' Vice President, '310' CXO, '320' Owner/Partner."),
  functions: z.array(z.enum(SN_FUNCTION_IDS)).max(10).nullable().optional().describe(`Job function: ${SN_FUNCTION_LEGEND}.`),
  years_in_current_company: z.array(z.enum(TENURE_IDS)).max(5).nullable().optional().describe(`Tenure at current company: ${TENURE_LEGEND}.`),
  years_in_current_position: z.array(z.enum(TENURE_IDS)).max(5).nullable().optional().describe(`Tenure in current position: ${TENURE_LEGEND}.`),
  years_of_experience: z.array(z.enum(TENURE_IDS)).max(5).nullable().optional().describe(`Total career length: ${TENURE_LEGEND}.`),
  company_headcounts: z.array(z.enum(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'])).max(10).nullable().optional()
    .describe("Company size: 'A' Self-employed, 'B' 1-10, 'C' 11-50, 'D' 51-200, 'E' 201-500, 'F' 501-1000, 'G' 1001-5000, 'H' 5001-10000, 'I' 10001+."),
  company_types: z.array(z.enum(['C', 'P', 'N', 'D', 'S', 'E', 'O', 'G'])).max(10).nullable().optional()
    .describe("Company type: 'C' Public, 'P' Privately Held, 'N' Non-profit, 'D' Educational, 'S' Partnership, 'E' Self-Employed, 'O' Self-Owned, 'G' Government."),
  profile_languages: z.array(z.enum(['ar', 'en', 'es', 'pt', 'zh', 'fr', 'it', 'ru', 'de', 'nl', 'tr', 'tl', 'pl', 'ko', 'ja', 'ms', 'no', 'da', 'ro', 'sv', 'in', 'cs'])).max(10).nullable().optional()
    .describe('Profile language, ISO 639-1.'),
  network: z.array(z.enum(['F', 'S', 'A', 'O'])).max(4).nullable().optional()
    .describe("Relationship degree: 'F' 1st, 'S' 2nd, 'A' group members, 'O' 3rd+."),
  connections_of: z.array(z.string().max(64)).max(10).nullable().optional()
    .describe('People connected to these members. Tokens (ACwA…) via lookup(type: "CONNECTION_OF").'),
}).describe('Sales Navigator people-search filters - the COMPLETE SN facet vocabulary. At least one member must be non-empty. lookup = scrape_linkedin_sales_nav_param_id_lookup.');

const CompanySearchFilters = z.object({
  keywords: z.string().max(256).nullable().optional(),
  geo_ids: z.array(z.string()).max(10).nullable().optional(),
  industry_ids: z.array(z.string()).max(10).nullable().optional(),
  company_sizes: z.array(z.string()).max(10).nullable().optional().describe('LinkedIn size-bucket ids ("B"=1-10 … "I"=10001+).'),
}).describe('Regular company-search filters. At least one member must be non-empty.');

const SN_DEPARTMENT_FIELD = z.enum(SN_FUNCTION_IDS)
  .describe('Numeric SN department id - the same taxonomy as the people-search functions facet (see its legend, or lookup(type: "FUNCTION")).');

const SalesNavCompanySearchFilters = z.object({
  keywords: z.string().max(256).nullable().optional(),
  // Typeahead facets - [{id, text, exclude}] values.
  company_headquarters: snFacet('HQ region. Ids via lookup(type: "BING_GEO"); exclude supported (e.g. exclude APAC).'),
  industries: snFacet('Industries. Ids via lookup(type: "INDUSTRY").'),
  account_lists: snFacet('Your SN account lists. Ids via lookup(type: "ACCOUNT_LIST") - numeric list ids or the "ALL" sentinel; exclude: true skips a list (e.g. current book of business).'),
  // Static closed-enum facets - full id sets inline, NO lookup call needed.
  company_headcounts: z.array(z.enum(['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'])).max(10).nullable().optional()
    .describe("Company size: 'B' 1-10, 'C' 11-50, 'D' 51-200, 'E' 201-500, 'F' 501-1000, 'G' 1001-5000, 'H' 5001-10000, 'I' 10001+ (account search has no 'A')."),
  num_of_followers: z.array(z.enum(['NFR1', 'NFR2', 'NFR3', 'NFR4', 'NFR5'])).max(5).nullable().optional()
    .describe('LinkedIn page followers: NFR1 1-50, NFR2 51-100, NFR3 101-1000, NFR4 1001-5000, NFR5 5001+.'),
  fortune: z.array(z.enum(['1', '2', '3', '4'])).max(4).nullable().optional()
    .describe("Fortune 500 tier: '1' Fortune 50, '2' 51-100, '3' 101-250, '4' 251-500."),
  account_activities: z.array(z.enum(['SLC', 'RFE'])).max(2).nullable().optional()
    .describe("Buying signals: 'SLC' senior-leadership changes in the last 3 months, 'RFE' funding event in the past 12 months."),
  // Range facets (ints, min ≤ max).
  annual_revenue: z.object({
    min: z.number().int().min(0).max(100000000),
    max: z.number().int().min(0).max(100000000),
    currency: z.string().regex(/^[A-Z]{3}$/).nullable().optional().describe('ISO-4217 code; default USD.'),
  }).nullable().optional().describe('Annual revenue range in MILLIONS (e.g. {min: 10, max: 100} = $10M-$100M).'),
  company_headcount_growth: z.object({
    min: z.number().int().min(-100).max(1000),
    max: z.number().int().min(-100).max(1000),
  }).nullable().optional().describe('Company-wide headcount growth range, percent (negative = shrinking).'),
  department_headcount: z.object({
    department: SN_DEPARTMENT_FIELD,
    min: z.number().int().min(0).max(1000000),
    max: z.number().int().min(0).max(1000000),
  }).nullable().optional().describe('Headcount of ONE department (e.g. department "25" Sales, {min: 20, max: 99999}).'),
  department_headcount_growth: z.object({
    department: SN_DEPARTMENT_FIELD,
    min: z.number().int().min(-100).max(1000),
    max: z.number().int().min(-100).max(1000),
  }).nullable().optional().describe('Growth of ONE department, percent - e.g. engineering team growing 10%+.'),
  // Single-chip toggles (true dispatches the chip; false dispatches nothing).
  hiring_on_linkedin: z.boolean().nullable().optional().describe('true → only accounts currently hiring on LinkedIn.'),
  first_degree_connection: z.boolean().nullable().optional().describe('true → only accounts where you have a 1st-degree connection.'),
  saved_accounts_only: z.boolean().nullable().optional().describe('true → only your saved SN accounts.'),
}).describe('Sales Navigator account-search filters - the COMPLETE SN vocabulary. At least one member must be non-empty (a false toggle counts as empty). lookup = scrape_linkedin_sales_nav_param_id_lookup.');

const PostSearchFilters = z.object({
  keywords: z.string().max(256).describe('REQUIRED: content search needs a query.'),
  date_posted: z.enum(['past_24h', 'past_week', 'past_month']).nullable().optional(),
  sort_by: z.enum(['relevance', 'date_posted']).nullable().optional().describe('Default relevance.'),
  content_type: z.array(z.enum(['videos', 'images', 'photos', 'liveVideos', 'collaborativeArticles', 'documents', 'jobPosts'])).max(10).nullable().optional().describe('Post media/format facet; wire-ready content-type tokens.'),
  posted_by: z.array(z.enum(['following', 'me', 'first'])).max(3).nullable().optional().describe('Author-relationship facet: following / me / first (1st-degree).'),
  author_job_title: z.string().max(256).nullable().optional().describe('Author current-title keywords.'),
  from_member: z.array(z.string()).max(10).nullable().optional().describe('Posts authored by these members (facet ids/urns). This is the real author-by-member facet.'),
  from_organization: z.array(z.string()).max(10).nullable().optional().describe('Posts authored by these organizations (facet ids/urns).'),
  author_company: z.array(z.string()).max(10).nullable().optional().describe('Author-company facet ids.'),
  author_industry: z.array(z.string()).max(10).nullable().optional().describe('Author-industry facet ids.'),
  mentions_member: z.array(z.string()).max(10).nullable().optional().describe('Posts mentioning these members (facet ids/urns).'),
  mentions_organization: z.array(z.string()).max(10).nullable().optional().describe('Posts mentioning these organizations (facet ids/urns).'),
}).describe('Content-search filters; keywords required.');

// Wire member names, verbatim. The pre-landing sketch called these service_ids
// and geo_ids; the node has always called them service_categories and
// locations. Both old names are `prohibited` backend-side rather than mapped:
// a filter that lands in a param the node ignores comes back as an empty result
// set, which reads like "nobody matches" instead of like a mistake.
const ServiceProviderSearchFilters = z.object({
  keywords: z.string().max(256).nullable().optional(),
  service_categories: z.array(z.string().regex(/^\d+$/)).max(10).nullable().optional()
    .describe("LinkedIn's own numeric service-category ids. Not resolvable through this API: read them off a services-search URL, or use the by-url tool."),
  locations: z.array(z.string().regex(/^\d+$/)).max(10).nullable().optional()
    .describe('Numeric LinkedIn geo ids.'),
}).describe('Service-provider marketplace filters. At least one member must be non-empty. Anything these three cannot express is reachable by pasting the UI URL into scrape_linkedin_search_service_providers_by_url.');

const ProfileTarget = z.object({
  ln_id: z.string().max(128).nullable().optional().describe('Regular-profile URN (ACoAA…).'),
  sn_id: z.string().max(64).nullable().optional().describe('Sales Navigator URN (ACwAA…).'),
  nickname: z.string().max(100).nullable().optional().describe('Vanity slug.'),
}).describe('Target profile: exactly one of ln_id / sn_id / nickname (ln_member_id is not dispatchable, KNOWLEDGE §3d).');

const CompanyTarget = z.object({
  company_url: z.string().max(512).nullable().optional().describe('https://www.linkedin.com/company/{slug}/'),
  company_ln_id: z.string().max(64).nullable().optional().describe('Numeric LinkedIn company id.'),
}).describe('Target company: exactly one of company_url / company_ln_id.');

const LookupFacet = z.enum(['geo', 'industry', 'company', 'past_company', 'school', 'title', 'service'])
  .describe('The facet axis to resolve (mirrors the id-bearing by-params filter members).');

const SalesNavTypeaheadType = z.enum([
  'COMPANY_WITH_LIST', 'BING_GEO', 'INDUSTRY', 'TITLE', 'GROUP', 'SCHOOL', 'CONNECTION_OF',
  'COMPANY_SIZE', 'FUNCTION', 'SENIORITY_V2', 'RELATIONSHIP', 'COMPANY_TYPE', 'TENURE', 'PROFILE_LANGUAGE',
  'PERSONA', 'ACCOUNT_LIST', 'LEAD_LIST', 'LEAD_INTERACTIONS', 'SAVED_LEADS_AND_ACCOUNTS',
]).describe('The Sales Navigator facet kind to resolve (node salesApiFacetTypeahead `type`, passed through verbatim). The first seven are text facets that resolve `query`; the rest return their fixed / account-scoped list and ignore it.');

// ═══════════════════════════════════════════════════════════════
// Output schemas: preview item projections are tightened to their
// documented field sets (research §Transient preview objects, confirmed
// against the backend preview mappers); every item keeps .passthrough()
// for forward-compat. The embedded ledger row is another entity's Domain
// (data_requests), so it is left passthrough here, not restated.
// ═══════════════════════════════════════════════════════════════

const DataRequestLedgerRow = z.object({}).passthrough()
  .describe('The kind="scrape" data_requests ledger row for this call (terminal completed), embedded as result.data_request; served_from_cache always false. Full DataRequestDomain shape owned by ./data_requests.md, so it is left passthrough here.');

const PageNumberPaging = z.object({
  page: z.number().int(),
  page_size: z.number().int(),
  has_more: z.boolean(),
  total: z.number().int().nullable(),
}).passthrough().describe('Page-numbered paging: re-call with page + 1 while has_more.');

const CursorPaging = z.object({
  page_size: z.number().int(),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
  total: z.number().int().nullable(),
}).passthrough().describe('Cursor paging: feed next_cursor back verbatim; null = terminal page.');

const ResolvedPost = z.object({
  post_ln_id: z.string(),
  is_tracked: z.boolean(),
  linkedin_tracked_post_sid: z.string().nullable(),
}).passthrough().describe('The resolved post target the getter ran against.');

// Projection field set per research §Transient preview objects (LinkedinPersonPreview)
// + backend LinkedinPersonPreviewMapper: every key is always emitted (null when the
// search wire does not expose it), so fields are .nullable() but never .optional().
const LinkedinPersonPreview = z.object({
  ln_member_id: z.string().nullable().describe('Canonical member id (decoded in-process).'),
  ln_id: z.string().nullable(),
  sn_id: z.string().nullable(),
  nickname: z.string().nullable(),
  full_name: z.string().nullable(),
  headline: z.string().nullable(),
  position: z.string().nullable(),
  company_name: z.string().nullable(),
  location: z.string().nullable(),
  avatar_url: z.string().nullable(),
  connection_degree: z.string().nullable(),
}).passthrough();

// The services screen answers with the SAME card shape as the people search,
// so a provider preview IS a person preview. It used to be declared with
// `services`, `rating` and `reviews_count` on top; none of those are on the
// wire, and promising them made the tool describe data it could never return.
const LinkedinServiceProviderPreview = LinkedinPersonPreview;

const LinkedinCompanyPreview = z.object({
  company_ln_id: z.string().nullable(),
  nickname: z.string().nullable(),
  name: z.string().nullable(),
  industry: z.string().nullable(),
  employees_size: z.string().nullable(),
  followers: z.number().int().nullable(),
  location: z.string().nullable(),
  tagline: z.string().nullable(),
  logo_url: z.string().nullable(),
  website: z.string().nullable(),
}).passthrough();

const LinkedinPostPreview = z.object({
  post_ln_id: z.string().nullable(),
  author_ln_member_id: z.string().nullable(),
  author_ln_id: z.string().nullable(),
  author_company_ln_id: z.string().nullable(),
  author_nickname: z.string().nullable(),
  author_full_name: z.string().nullable(),
  author_headline: z.string().nullable(),
  content: z.string().nullable(),
  posted_at: z.string().nullable(),
  reactions_count: z.number().int().nullable(),
  comments_count: z.number().int().nullable(),
  reshares_count: z.number().int().nullable(),
}).passthrough();

const LinkedinCommenterPreview = z.object({
  commenter_ln_member_id: z.string(),
  commenter_ln_id: z.string().nullable(),
  commenter_nickname: z.string().nullable(),
  commenter_full_name: z.string().nullable(),
  commenter_headline: z.string().nullable(),
  commenter_picture_url: z.string().nullable(),
  comment_ln_id: z.string(),
  content: z.string(),
  posted_at: z.string().nullable(),
  reactions_count: z.number().int(),
  is_own: z.boolean().describe('Commenter matches one of the team’s managed accounts (same rule as sync).'),
  is_stored: z.boolean().describe('Already persisted as a linkedin-comments row (resolvable only for a tracked post).'),
  linkedin_comment_sid: z.string().nullable(),
}).passthrough();

const LinkedinEngagerPreview = z.object({
  reactor_ln_member_id: z.string(),
  reactor_ln_id: z.string().nullable(),
  reactor_nickname: z.string().nullable(),
  reactor_full_name: z.string().nullable(),
  reactor_headline: z.string().nullable(),
  reactor_picture_url: z.string().nullable(),
  reaction_type: z.enum(['like', 'celebrate', 'support', 'love', 'insightful', 'funny'])
    .describe('Normalized reaction type (MAYBE → like + WARN, as on sync), per LinkedinEngagementReactionTypeEnum.'),
  reacted_at: z.string().nullable(),
  is_own: z.boolean(),
  is_stored: z.boolean().describe('Already persisted as a linkedin-engagements row (resolvable only for a tracked post).'),
  linkedin_engagement_sid: z.string().nullable(),
}).passthrough();

const LinkedinResharerPreview = z.object({
  resharer_ln_member_id: z.string(),
  resharer_ln_id: z.string().nullable(),
  resharer_nickname: z.string().nullable(),
  resharer_full_name: z.string().nullable(),
  resharer_headline: z.string().nullable(),
  resharer_picture_url: z.string().nullable(),
  resharer_commentary: z.string().nullable().describe('Text added when resharing (empty for a plain reshare).'),
  reshare_urn: z.string().nullable().describe('The reshare’s own activity URN. Feed it back into get-post-commenters/-reactors to scrape the reshare itself.'),
  is_own: z.boolean(),
}).passthrough();

const LinkedinCommentThreadNodePreview = LinkedinCommenterPreview.extend({
  parent_comment_ln_id: z.string().nullable().describe('null = top-level comment; non-null = reply (LinkedIn nests one level).'),
  replies_count: z.number().int(),
}).passthrough();

const LinkedinParamIdPreview = z.object({
  facet: z.enum(['geo', 'industry', 'company', 'past_company', 'school', 'title', 'service']),
  id: z.string().describe('LinkedIn facet id (e.g. geo "103644278"). Feed it into the *_ids filter members.'),
  display_name: z.string(),
  headline: z.string().nullable(),
}).passthrough();

const LinkedinSalesNavParamIdPreview = z.object({
  type: z.string(),
  id: z.string().describe('Opaque SN facet id. Feed it VERBATIM into the SN search-by-params filters (company "urn:li:organization:1441", geo "100506914", …).'),
  display_name: z.string().nullable(),
  headline: z.string().nullable(),
  entity_urn: z.string().nullable(),
  image_url: z.string().nullable(),
}).passthrough();

// Result envelope factory: item is always null; the transient list + paging +
// ledger row live in result. `paging` schema varies (page-numbered / cursor /
// null for single-shot lookups); `extra` carries per-verb response fields.
const runResult = (
  rowSchema: z.ZodTypeAny,
  pagingSchema: z.ZodTypeAny,
  extra: z.ZodRawShape = {},
) => z.object({
  rows: z.array(rowSchema).describe('The transient result list, in LinkedIn’s order; NOTHING persisted.'),
  paging: pagingSchema,
  data_request: DataRequestLedgerRow,
  ...extra,
}).passthrough();

// All 19 verbs share these annotations (research §Shared per-call semantics):
// not read-only (spends rate budget, writes the ledger, may debit credits),
// not idempotent (a repeat call without idempotency_key re-executes/re-charges).
const SCRAPE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

const STUB = '⛔ NOT SHIPPED YET. The contract is locked and validated now but the plugin verb is not built. Every valid, allowed call returns 501 not_implemented (context.reason=blocked_on_plugin) with no ledger row and no credit spend; do not retry.';

const base = {
  service: 'linkedin',
  entity: 'linkedin_scraping',
  mount: 'linkedin.scraping',
} as const;

const rt = (path: string) => ({ service: 'linkedin' as const, method: 'POST' as const, pathTemplate: `/api/linkedin-scraping/${path}` });

export const linkedinScrapingTools: ToolDefinition[] = [
  {
    ...base,
    name: 'scrape_linkedin_search_people_by_url',
    description:
      'Run ONE page of a regular LinkedIn people-search URL right now and return the people on it. This is the direct, stateless form of the get-linkedin-profiles-search getter. Paste any people-search URL built in the LinkedIn UI; page through by re-calling with page + 1 while paging.has_more. Costs 2 credits on the pool path (free on an own account with scraping budget). If commercial_use_limit_hit fires, switch to the Sales Navigator engine. Use for run-now list-building; for monitored/large drains create a saved search (linkedin-searches) instead.',
    toolClass: 'typical',
    route: rt('search-people-by-url'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      ...requestBase,
      url: z.string().max(2048).describe('MUST start with https://www.linkedin.com/search/results/people/ (422 invalid_search_url otherwise).'),
      page: z.number().int().min(1).max(100).optional().describe('LinkedIn page number, default 1; one page per call.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), runResult(LinkedinPersonPreview, PageNumberPaging, {
      commercial_use_limit_hit: z.boolean().describe('LinkedIn’s people-search commercial-use-limit upsell fired (wire wasStrike), so rows may be truncated; switch to the SN engine or wait for the monthly reset.'),
    })),
    annotations: { title: 'Scrape people by search URL', ...SCRAPE },
  },
  {
    ...base,
    name: 'scrape_linkedin_search_people_by_params',
    description:
      'The URL-free form of the people search: pass a structured filter object instead of a UI-built URL. The backend composes the engine query and delegates to the same by-url core (background tab + SDUI parse). Facet ids come from param-id-lookup; free-text members (keywords/first_name/last_name/title/company/school) and network (F/S/O) work today. Same result shape and cost (2 credits) as search-people-by-url. Prefer by-params when the agent constructs the search programmatically.',
    toolClass: 'typical',
    route: rt('search-people-by-params'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      ...requestBase,
      filters: PeopleSearchFilters,
      page: z.number().int().min(1).max(100).optional().describe('Default 1.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), runResult(LinkedinPersonPreview, PageNumberPaging, {
      commercial_use_limit_hit: z.boolean(),
    })),
    annotations: { title: 'Scrape people by params', ...SCRAPE },
  },
  {
    ...base,
    name: 'scrape_linkedin_search_sales_nav_people_by_url',
    description:
      'Run ONE page of a Sales Navigator people-search URL: richer facets (seniority, function, headcount, tenure), no commercial-use limit, SN URNs (sn_id) in the previews. Requires an SN-capable executor (a non-SN own account → 422 sales_nav_required; the pool claim filters to SN-capable accounts). Costs 2 credits. Page through with page + 1 while paging.has_more.',
    toolClass: 'typical',
    route: rt('search-sales-nav-people-by-url'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      ...requestBase,
      url: z.string().max(2048).describe('MUST start with https://www.linkedin.com/sales/search/people (422 invalid_search_url otherwise).'),
      page: z.number().int().min(1).max(100).optional().describe('Default 1.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), runResult(LinkedinPersonPreview, PageNumberPaging)),
    annotations: { title: 'Scrape Sales Navigator people by URL', ...SCRAPE },
  },
  {
    ...base,
    name: 'scrape_linkedin_search_sales_nav_people_by_params',
    description:
      'Structured-filter form of the SN people search, carrying the COMPLETE Sales Navigator facet vocabulary (22 members): titles (current/past), seniority, function, tenure (company/position/career), geography, company HQ, current/past employers, company size and type, industries, groups, schools, profile languages, relationship degree, connections-of, first/last name. HOW TO BUILD A SEARCH: (1) typeahead facets take [{id, text, exclude}] values - resolve ids with scrape_linkedin_sales_nav_param_id_lookup (each member description names its lookup type), or skip the lookup and pass {text: "..."} free text; (2) static-enum members list their FULL id sets inline - never call the lookup for those; (3) exclude: true on a value negates it (closed enums negate by including the complement). Same engine and cost (2 credits) as the by-url variant; SN-capable executor required.',
    toolClass: 'typical',
    route: rt('search-sales-nav-people-by-params'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      ...requestBase,
      filters: SalesNavPeopleSearchFilters,
      page: z.number().int().min(1).max(100).optional().describe('Default 1.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), runResult(LinkedinPersonPreview, PageNumberPaging)),
    annotations: { title: 'Scrape Sales Navigator people by params', ...SCRAPE },
  },
  {
    ...base,
    name: 'scrape_linkedin_search_service_providers',
    description:
      "Search LinkedIn's service-provider marketplace (freelancers and agencies) by filters. Returns the same person previews as the people search: the services screen carries no ratings or service labels in its results, only provider profiles. 2 credits per page. Filters are keywords plus LinkedIn's own numeric service-category and geo ids; anything else on that screen is reachable by pasting the UI URL into the by-url twin.",
    toolClass: 'typical',
    route: rt('search-service-providers'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      ...requestBase,
      filters: ServiceProviderSearchFilters,
      page: z.number().int().min(1).max(100).optional().describe('Default 1.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), runResult(LinkedinServiceProviderPreview, PageNumberPaging)),
    annotations: { title: 'Scrape service providers', ...SCRAPE },
  },
  {
    ...base,
    name: 'scrape_linkedin_search_service_providers_by_url',
    description:
      "Run ONE page of a pasted LinkedIn services-search URL. Use this when the marketplace facets you need are not in the by-filters tool: build the search in LinkedIn's own UI, copy the /search/results/services/ URL, and page through it here. A URL from any other search screen is refused, because it would silently scrape the wrong thing. 2 credits per page, same person-preview rows as the by-filters tool.",
    toolClass: 'typical',
    route: rt('search-service-providers-by-url'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      ...requestBase,
      url: z.string().max(2048).describe('Must start with https://www.linkedin.com/search/results/services/'),
      page: z.number().int().min(1).max(100).optional().describe('Default 1.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), runResult(LinkedinServiceProviderPreview, PageNumberPaging)),
    annotations: { title: 'Scrape service providers by URL', ...SCRAPE },
  },
  {
    ...base,
    name: 'scrape_linkedin_similar_profiles',
    description:
      'LinkedIn’s "people also viewed" browsemap for ONE seed profile: lookalike expansion from a known-good persona. IMPORTANT: address by profile.nickname (the vanity slug) ONLY, because the wire navigates by vanityName, so a ln_id/sn_id URN is refused not_dispatchable (resolve it via enrich_linkedin_person_lite_profile first, then pass the nickname). Returns ~20 cards; rows carry ln_member_id + nickname + full_name + headline (no ACoAA id, no avatar, no degree). One-shot list (no pagination); limit caps the cards. Cost 2 credits.',
    toolClass: 'typical',
    route: rt('similar-profiles'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      ...requestBase,
      profile: ProfileTarget,
      limit: z.number().int().min(1).max(100).optional().describe('Default 25.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), runResult(LinkedinPersonPreview, z.null())),
    annotations: { title: 'Scrape similar profiles', ...SCRAPE },
  },
  {
    ...base,
    name: 'scrape_linkedin_search_companies_by_url',
    description:
      `Run ONE page of a regular LinkedIn company-search URL and return the companies on it. Cost 2 credits.`,
    toolClass: 'typical',
    route: rt('search-companies-by-url'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      ...requestBase,
      url: z.string().max(2048).describe('MUST start with https://www.linkedin.com/search/results/companies/ (422 invalid_search_url otherwise).'),
      page: z.number().int().min(1).max(100).optional().describe('Default 1.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), runResult(LinkedinCompanyPreview, PageNumberPaging)),
    annotations: { title: 'Scrape companies by search URL', ...SCRAPE },
  },
  {
    ...base,
    name: 'scrape_linkedin_search_companies_by_params',
    description:
      `Structured-filter form of the company search. Same engine and cost (2 credits) as search-companies-by-url.`,
    toolClass: 'typical',
    route: rt('search-companies-by-params'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      ...requestBase,
      filters: CompanySearchFilters,
      page: z.number().int().min(1).max(100).optional().describe('Default 1.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), runResult(LinkedinCompanyPreview, PageNumberPaging)),
    annotations: { title: 'Scrape companies by params', ...SCRAPE },
  },
  {
    ...base,
    name: 'scrape_linkedin_search_sales_nav_companies_by_url',
    description:
      `Run ONE page of a Sales Navigator account-search URL (SN company facets: headcount, revenue, growth). SN-capable executor required. Cost 2 credits.`,
    toolClass: 'typical',
    route: rt('search-sales-nav-companies-by-url'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      ...requestBase,
      url: z.string().max(2048).describe('MUST start with https://www.linkedin.com/sales/search/company (422 invalid_search_url otherwise).'),
      page: z.number().int().min(1).max(100).optional().describe('Default 1.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), runResult(LinkedinCompanyPreview, PageNumberPaging)),
    annotations: { title: 'Scrape Sales Navigator companies by URL', ...SCRAPE },
  },
  {
    ...base,
    name: 'scrape_linkedin_search_sales_nav_companies_by_params',
    description:
      'Structured-filter form of the SN account search, carrying the COMPLETE node vocabulary (15 members) - the one engine that filters on annual revenue (range, in millions), company AND per-department headcount growth (ranges, percent), department headcount, follower buckets, Fortune tier, buying signals (leadership changes / funding events), hiring status, 1st-degree relationship, saved accounts and account lists. Typeahead facet ids come from scrape_linkedin_sales_nav_param_id_lookup (type named per member); static-enum members carry their full id sets inline; exclude: true negates a typeahead value. SN-capable executor required. Cost 2 credits.',
    toolClass: 'typical',
    route: rt('search-sales-nav-companies-by-params'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      ...requestBase,
      filters: SalesNavCompanySearchFilters,
      page: z.number().int().min(1).max(100).optional().describe('Default 1.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), runResult(LinkedinCompanyPreview, PageNumberPaging)),
    annotations: { title: 'Scrape Sales Navigator companies by params', ...SCRAPE },
  },
  {
    ...base,
    name: 'scrape_linkedin_similar_companies',
    description:
      `LinkedIn’s "similar companies / pages people also viewed" list for ONE target company: lookalike account expansion. One-shot list. Cost 2 credits.`,
    toolClass: 'typical',
    route: rt('similar-companies'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      ...requestBase,
      company: CompanyTarget,
      limit: z.number().int().min(1).max(50).optional().describe('Default 10.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), runResult(LinkedinCompanyPreview, z.null())),
    annotations: { title: 'Scrape similar companies', ...SCRAPE },
  },
  {
    ...base,
    name: 'scrape_linkedin_company_employees',
    description:
      `List the people currently working at ONE company (the company page’s "employees" people-search, page-numbered). Heavy list, so it costs 3 credits per page.`,
    toolClass: 'typical',
    route: rt('company-employees'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      ...requestBase,
      company: CompanyTarget,
      page: z.number().int().min(1).max(100).optional().describe('Default 1.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), runResult(LinkedinPersonPreview, PageNumberPaging)),
    annotations: { title: 'Scrape company employees', ...SCRAPE },
  },
  {
    ...base,
    name: 'scrape_linkedin_company_decision_makers',
    description:
      `Sales Navigator’s decision-makers panel for ONE company: the bounded, seniority-weighted leadership/buying-committee list SN computes. SN-capable executor required. Cost 3 credits.`,
    toolClass: 'typical',
    route: rt('company-decision-makers'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      ...requestBase,
      company: CompanyTarget,
      limit: z.number().int().min(1).max(50).optional().describe('Default 25.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), runResult(LinkedinPersonPreview, z.null())),
    annotations: { title: 'Scrape company decision makers', ...SCRAPE },
  },
  {
    ...base,
    name: 'scrape_linkedin_search_posts',
    description:
      `LinkedIn content search: find POSTS by keywords / recency / author. This is the discovery front-door for post-engagement plays (feed the returned post_ln_id into get-post-commenters / -reactors / -resharers). Takes a structured filter object (keywords required); to search from a pasted content-search URL use scrape_linkedin_search_posts_by_url. Cost 2 credits.`,
    toolClass: 'typical',
    route: rt('search-posts'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      ...requestBase,
      filters: PostSearchFilters.describe('Structured content-search filters (keywords required).'),
      page_size: z.number().int().min(1).max(100).nullable().optional().describe('Rows per page (1..100); default 10.'),
      cursor: z.string().max(2048).nullable().optional().describe('Opaque resume token from paging.next_cursor; null/omitted = first page.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), runResult(LinkedinPostPreview, CursorPaging)),
    annotations: { title: 'Scrape posts', ...SCRAPE },
  },
  {
    ...base,
    name: 'scrape_linkedin_search_posts_by_url',
    description:
      'Run ONE page of a LinkedIn content-search URL: paste a built /search/results/content/ URL and get the posts on it (the node parses the URL into the same filter object as search-posts). Cursor-paginated; page on with paging.next_cursor. Cost 2 credits.',
    toolClass: 'typical',
    route: rt('search-posts-by-url'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      ...requestBase,
      url: z.string().max(2048).describe('MUST start with https://www.linkedin.com/search/results/content/ (422 invalid_search_url otherwise).'),
      page_size: z.number().int().min(1).max(100).nullable().optional().describe('Rows per page (1..100); default 10.'),
      cursor: z.string().max(2048).nullable().optional().describe('Opaque resume token from paging.next_cursor; null/omitted = first page.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), runResult(LinkedinPostPreview, CursorPaging)),
    annotations: { title: 'Scrape posts by URL', ...SCRAPE },
  },
  {
    ...base,
    name: 'scrape_linkedin_get_post_commenters',
    description:
      'Direct LinkedIn read (bypasses our DB): live pull of who is commenting on ONE post right now. Returns transient commenter objects (member id, nickname, name, headline, comment text, posted_at, reactions_count) annotated with is_own and is_stored / linkedin_comment_sid. Target a tracked post by linkedin_tracked_post_sid XOR any post by URL / activity URN; the post does NOT need to be tracked. One wire page per call; page on with cursor. For the reconciled list with counts / groups / q, track the post and use linkedin-comments.search. Cost 2 credits.',
    toolClass: 'complex',
    route: rt('get-post-commenters'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      ...requestBase,
      linkedin_tracked_post_sid: z.string().length(18).startsWith('ln_tp_').nullable().optional().describe('A tracked post (activity URN taken from the stored row). Exactly one of linkedin_tracked_post_sid / post.'),
      post: z.string().max(512).nullable().optional().describe('A linkedin.com post URL OR an activity URN, auto-detected; a URL is resolved via get_activity_urn_by_url. The post does NOT need to be tracked. Exactly one of linkedin_tracked_post_sid / post.'),
      page_size: z.number().int().min(1).max(100).optional().describe('Default 50; one wire page per call.'),
      cursor: z.string().nullable().optional().describe('Opaque resume token from paging.next_cursor; null = first page.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), runResult(LinkedinCommenterPreview, CursorPaging, {
      post: ResolvedPost,
      skipped_invalid_rows: z.number().int().describe('Wire comments with urn=null / no decodable author skipped.'),
    })),
    annotations: { title: 'Scrape post commenters', ...SCRAPE },
  },
  {
    ...base,
    name: 'scrape_linkedin_get_post_reactors',
    description:
      'Direct LinkedIn read (bypasses our DB): live pull of who is reacting to ONE post right now, as transient reactor objects with normalized reaction_type (MAYBE → like + WARN), annotated with is_own and is_stored / linkedin_engagement_sid. Target by linkedin_tracked_post_sid XOR post URL / activity URN; tracking not required. One wire page per call; page on with cursor. For the reconciled list use linkedin-engagements.search on a tracked post. Cost 2 credits.',
    toolClass: 'complex',
    route: rt('get-post-reactors'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      ...requestBase,
      linkedin_tracked_post_sid: z.string().length(18).startsWith('ln_tp_').nullable().optional().describe('Exactly one of linkedin_tracked_post_sid / post.'),
      post: z.string().max(512).nullable().optional().describe('Post URL OR activity URN, auto-detected; a URL is resolved via get_activity_urn_by_url. Exactly one of linkedin_tracked_post_sid / post.'),
      page_size: z.number().int().min(1).max(100).optional().describe('Default 50.'),
      cursor: z.string().nullable().optional().describe('Opaque resume token; null = first page.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), runResult(LinkedinEngagerPreview, CursorPaging, {
      post: ResolvedPost,
      skipped_null_actors: z.number().int().describe('Banned/suspended reactor slots skipped (KNOWLEDGE §7a).'),
    })),
    annotations: { title: 'Scrape post reactors', ...SCRAPE },
  },
  {
    ...base,
    name: 'scrape_linkedin_get_post_resharers',
    description:
      'Direct LinkedIn read (bypasses our DB): live pull of the profiles that RESHARED one post, the third and typically highest-intent leg of the engagement trio. Same targeting (linkedin_tracked_post_sid XOR post URL / activity URN); is_own annotated, no is_stored (reshares have no persisted entity). When exposed, resharer_commentary carries the added text and reshare_urn is the reshare’s own activity URN (feed it back into get-post-commenters / -reactors). One wire page per call; page on with cursor. Cost 2 credits.',
    toolClass: 'complex',
    route: rt('get-post-resharers'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      ...requestBase,
      linkedin_tracked_post_sid: z.string().length(18).startsWith('ln_tp_').nullable().optional().describe('Exactly one of linkedin_tracked_post_sid / post.'),
      post: z.string().max(512).nullable().optional().describe('Post URL OR activity URN, auto-detected; a URL is resolved via get_activity_urn_by_url. Exactly one of linkedin_tracked_post_sid / post.'),
      page_size: z.number().int().min(1).max(100).optional().describe('Default 50.'),
      cursor: z.string().nullable().optional().describe('Opaque resume token; null = first page.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), runResult(LinkedinResharerPreview, CursorPaging, {
      post: ResolvedPost,
    })),
    annotations: { title: 'Scrape post resharers', ...SCRAPE },
  },
  {
    ...base,
    name: 'scrape_linkedin_get_post_comments',
    description:
      `${STUB} Full comment THREADS of one post: top-level comments AND their replies as a flat list with parent pointers (parent_comment_ln_id; LinkedIn nests one level). Distinct from get-post-commenters (which returns the PEOPLE for qualification): this returns the CONVERSATION for content analysis (unanswered questions, objection mining). Same targeting and annotations. Cost 2 credits.`,
    toolClass: 'complex',
    route: rt('get-post-comments'),
    operation: 'action',
    envelope: 'action',
    availability: 'stub_501',
    dangerous: false,
    creditable: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      ...requestBase,
      linkedin_tracked_post_sid: z.string().length(18).startsWith('ln_tp_').nullable().optional().describe('Exactly one of linkedin_tracked_post_sid / post.'),
      post: z.string().max(512).nullable().optional().describe('Post URL OR activity URN, auto-detected; a URL is resolved via get_activity_urn_by_url. Exactly one of linkedin_tracked_post_sid / post.'),
      page_size: z.number().int().min(1).max(100).optional().describe('Default 50 thread nodes per page (top-level + replies).'),
      cursor: z.string().nullable().optional().describe('Opaque resume token; null = first page.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), runResult(LinkedinCommentThreadNodePreview, CursorPaging, {
      post: ResolvedPost,
    })),
    annotations: { title: 'Scrape post comment threads (not shipped)', ...SCRAPE },
  },
  {
    ...base,
    name: 'scrape_linkedin_param_id_lookup',
    description:
      `${STUB} Typeahead facet-id resolution: turn a human term ("United States", "SaaS", "Stanford") into the LinkedIn facet id the by-params search filters require (geo_ids, industry_ids, current_company_ids, …). One facet per call. The cheapest method on the surface, at 1 credit.`,
    toolClass: 'trivial',
    route: rt('param-id-lookup'),
    operation: 'action',
    envelope: 'action',
    availability: 'stub_501',
    dangerous: false,
    creditable: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      ...requestBase,
      facet: LookupFacet,
      query: z.string().min(1).max(100).describe('The human term to resolve.'),
      limit: z.number().int().min(1).max(25).optional().describe('Default 10.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), runResult(LinkedinParamIdPreview, z.null())),
    annotations: { title: 'Look up LinkedIn facet id (not shipped)', ...SCRAPE },
  },
  {
    ...base,
    name: 'scrape_linkedin_sales_nav_param_id_lookup',
    description:
      'Sales Navigator facet-id typeahead: resolve one SN facet (type) into the opaque ids the SN search-by-params filters need. type is a node salesApiFacetTypeahead kind passed through verbatim; the seven text facets resolve query, the rest return their fixed / account-scoped list. Type → target filter member: TITLE → current_titles/past_titles; BING_GEO → locations/company_headquarters; INDUSTRY → industries; COMPANY_WITH_LIST → current_companies/past_companies; GROUP → groups; SCHOOL → schools; CONNECTION_OF → connections_of; ACCOUNT_LIST → account_lists (company search). Skip it for the static kinds (COMPANY_SIZE/FUNCTION/SENIORITY_V2/RELATIONSHIP/COMPANY_TYPE/TENURE/PROFILE_LANGUAGE): their full id sets are inlined in the search filter schemas. PERSONA/LEAD_LIST/LEAD_INTERACTIONS/SAVED_LEADS_AND_ACCOUNTS have no by-params member yet. SN executor required. Cost 1 credit.',
    toolClass: 'trivial',
    route: rt('sales-nav-param-id-lookup'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      ...requestBase,
      type: SalesNavTypeaheadType,
      query: z.string().min(1).max(100).nullable().optional().describe('The typed term (text facets); ignored by static-enum / list facets.'),
      limit: z.number().int().min(1).max(25).optional().describe('Default 10.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), runResult(LinkedinSalesNavParamIdPreview, z.null())),
    annotations: { title: 'Look up Sales Navigator facet id', ...SCRAPE },
  },
];
