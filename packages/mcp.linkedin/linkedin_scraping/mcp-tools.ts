// Entity: LinkedIn Scraping surface (gtm.service.linkedin)
// Source of truth: product/research/gtm.service.linkedin/entities/linkedin_scraping.md
// Format: registry v2, where each tool carries route metadata so the generic
// dispatcher can drive it. 21 run-now discovery verbs (one per matrix row) on
// the stateless /api/linkedin-scraping/* surface. Each pulls a one-shot LIVE
// list of OTHER entities off LinkedIn and returns it sync inline (≤120 s).
//
// 🛑 ONE TOOL PER SEARCH VERTICAL, `url` XOR `filters` (2026-08-08). Every
// search here used to ship as TWO tools, a by-url form and a by-params form,
// which is 16 tools for 8 jobs and exactly what product/KNOWLEDGE.md §4.10
// tells us not to do: one tool per action, the caller picks the scope, because
// fewer tools mean better tool-selection quality. The eight pairs are now eight
// tools that take EITHER a pasted search URL OR a structured filter object, and
// the groups, courses, products and schools verticals landed in that shape rather
// than as a ninth, tenth, eleventh and twelfth pair. The mount went 26 tools to
// 19 and gave back the raise its budget had taken; courses put it at 20, products
// at 21 and schools at 22, still under the platform default 25. Schools was the
// LAST node search vertical we did not mirror, so this list is now complete.
//
// The LEDGER did not merge with the surface. A url-addressed people search
// still writes DataRequestMethodEnum::SearchPeopleByUrl and a filters-addressed
// one still writes ::SearchPeopleByParams; the node still serves two verbs per
// vertical and the activity log still records which one ran. The controller
// picks the case from which field was filled. That asymmetry is deliberate: the
// ledger and auto-scrape taxonomies are finer than the route surface, and rows
// in linkedin_auto_scrapes.source_method depend on both halves surviving.
//
// Availability is code-authoritative: DataRequestMethodEnum::isImplemented()
// (== wireGetter() !== null) gates the §5.9 stub guard in
// DataRequestExecutionService (501 before any ledger insert). ALL 21 of the 21
// methods are GA today; get-post-comments is the last 501 stub, waiting on its
// plugin verb. param-id-lookup left that list on 2026-08-07, when the node
// shipped the flagship facet typeahead (GET /api/linkedin/typehead-linkedin);
// jobs and events joined the surface on 2026-08-08 against node verbs that had
// been live for longer than that, and groups and courses landed the same day,
// each already whole on the node side (both verbs plus the plugin rpc handler
// and the SDK parser).
// Every verb runs on the team's own connected accounts (§9.5, 2026-08-14
// own-accounts-only contract: pinned account runs or refuses 429; no pin means
// the service auto-picks a capable own account).
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
    .describe('Executor account (ln_ac_...). OPTIONAL everywhere on this surface. Given: the call runs on that account ONLY; a saturated or held scraping bucket refuses 429 bucket_saturated (with retry_after). Omitted: the service auto-picks one of your connected accounts with remaining capacity (SN verbs pick only Sales-Navigator seats; 422 no_connected_accounts when none is ready, 429 when all are at capacity).'),
  idempotency_key: z.string().max(128).nullable().optional()
    .describe('Ledger replay guard: a repeat call with the same (team, key) returns the stored outcome; no re-execution. Recommended on every search run. The KEY ALONE decides: the probe does not compare arguments, so reusing one key after changing the arguments hands back the FIRST result. On the twelve search verbs that matters twice over, because switching a call from filters to url (or back) under one key replays instead of running the new search. New search, new key.'),
} as const;

// ═══════════════════════════════════════════════════════════════
// Input value objects: the `filters` vocabularies (LinkedIn-ready wire
// values, passed through untranslated). At least one member non-empty.
//
// Each object below feeds EXACTLY ONE merged search tool, and each is the
// `filters` half of that tool's url XOR filters pair, so every describe opens
// with the same exclusivity sentence: the object schema is where an agent
// filling arguments actually reads, and the rule has to be in front of it
// there and not only in the tool description.
// ═══════════════════════════════════════════════════════════════

// The one sentence, spelled once. Prepended to every filters describe and
// mirrored in the url field below, so the two halves cannot state the rule
// differently.
const XOR = 'EXCLUSIVE with `url`: send filters OR url, never both (422) and never neither (422).';

const PeopleSearchFilters = z.object({
  keywords: z.string().max(256).nullable().optional().describe('Free-text query.'),
  first_name: z.string().max(100).nullable().optional(),
  last_name: z.string().max(100).nullable().optional(),
  title: z.string().max(256).nullable().optional().describe('Current-title keywords.'),
  company: z.string().max(256).nullable().optional().describe('Current-company keywords (free text; prefer current_companies).'),
  school: z.string().max(256).nullable().optional().describe('School free-text: this engine has no school-id facet, so lookup(type: "school") ids fit nowhere here.'),
  network: z.array(z.enum(['1st', '2nd', '3rd_plus'])).max(3).nullable().optional().describe('Relationship-degree facet; the node maps each degree onto the LinkedIn wire code (F/S/O) itself.'),
  locations: z.array(z.string()).max(10).nullable().optional().describe('Numeric geo ids, via lookup(type: "location").'),
  industries: z.array(z.string()).max(10).nullable().optional().describe('Numeric industry ids, via lookup(type: "industry").'),
  current_companies: z.array(z.string()).max(10).nullable().optional().describe('Numeric company ids, via lookup(type: "company").'),
  past_companies: z.array(z.string()).max(10).nullable().optional().describe('Numeric company ids. The typeahead has no past-company axis; lookup(type: "company") answers in what looks like the same org-id space, which is our reading of the wire rather than a verified mapping.'),
  service_categories: z.array(z.string()).max(10).nullable().optional().describe('Numeric service-category ids, via lookup(type: "service_category").'),
  connections_of: z.array(z.string()).max(10).nullable().optional().describe('Profile ids (ACoA…): people in these profiles’ connections. Via lookup(type: "connections").'),
  followers_of: z.array(z.string()).max(10).nullable().optional().describe('Profile ids (ACoA…): people following these profiles. Via lookup(type: "people").'),
  profile_languages: z.array(z.string()).max(10).nullable().optional().describe('ISO 639-1 language codes.'),
  open_to_volunteer: z.boolean().nullable().optional(),
}).describe(`${XOR} Regular people-search filters. At least one member must be non-empty. Members are LinkedIn-ready wire values (passed through untranslated), except network, whose degrees the node maps onto LinkedIn codes. lookup = scrape_linkedin_param_id_lookup, and each id-bearing member names the type it takes.`);

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
}).describe(`${XOR} Sales Navigator people-search filters, the COMPLETE SN facet vocabulary. At least one member must be non-empty. lookup = scrape_linkedin_sales_nav_param_id_lookup.`);

const CompanySearchFilters = z.object({
  keywords: z.string().max(256).nullable().optional(),
  geo_ids: z.array(z.string()).max(10).nullable().optional()
    .describe('Numeric LinkedIn geo ids. scrape_linkedin_param_id_lookup(type: "location") answers in this id family, but the mapping was matched on the people search and this engine sends the ids under its own URL param, so check the first page before a long run.'),
  industry_ids: z.array(z.string()).max(10).nullable().optional()
    .describe('Numeric LinkedIn industry ids, from scrape_linkedin_param_id_lookup(type: "industry"). Same caveat as geo_ids: the mapping is verified on the people search, not on this one.'),
  company_sizes: z.array(z.enum(['1_to_10', '11_to_50', '51_to_200', '201_to_500', '501_to_1000', '1001_to_5000', '5001_to_10000', '10001_plus'])).max(8).nullable().optional().describe('Headcount ranges; the node maps each range onto the LinkedIn size-bucket id itself.'),
}).describe(`${XOR} Regular company-search filters. At least one member must be non-empty.`);

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
}).describe(`${XOR} Sales Navigator account-search filters, the COMPLETE SN vocabulary. At least one member must be non-empty (a false toggle counts as empty). lookup = scrape_linkedin_sales_nav_param_id_lookup.`);

const PostSearchFilters = z.object({
  keywords: z.string().max(256).describe('REQUIRED: content search needs a query.'),
  date_posted: z.enum(['past_24h', 'past_week', 'past_month']).nullable().optional(),
  sort_by: z.enum(['relevance', 'date_posted']).nullable().optional().describe('Default relevance.'),
  content_type: z.array(z.enum(['videos', 'photos', 'jobs', 'liveVideos', 'documents'])).max(5).nullable().optional().describe('Post media/format facet; wire-ready content-type tokens.'),
  posted_by: z.array(z.enum(['following', 'me', 'first'])).max(3).nullable().optional().describe('Author-relationship facet: following / me / first (1st-degree).'),
  author_job_title: z.string().max(256).nullable().optional().describe('Author current-title keywords.'),
  from_member: z.array(z.string()).max(10).nullable().optional().describe('Posts authored by these members (facet ids/urns). This is the real author-by-member facet.'),
  from_organization: z.array(z.string()).max(10).nullable().optional().describe('Posts authored by these organizations (facet ids/urns).'),
  author_company: z.array(z.string()).max(10).nullable().optional().describe('Author-company facet ids.'),
  author_industry: z.array(z.string()).max(10).nullable().optional().describe('Author-industry facet ids.'),
  mentions_member: z.array(z.string()).max(10).nullable().optional().describe('Posts mentioning these members (facet ids/urns).'),
  mentions_organization: z.array(z.string()).max(10).nullable().optional().describe('Posts mentioning these organizations (facet ids/urns).'),
}).describe(`${XOR} Content-search filters; keywords required.`);

// Wire member names, verbatim. The pre-landing sketch called these service_ids
// and geo_ids; the node has always called them service_categories and
// locations. Both old names are `prohibited` backend-side rather than mapped:
// a filter that lands in a param the node ignores comes back as an empty result
// set, which reads like "nobody matches" instead of like a mistake.
//
// network and profile_languages landed with the node merge of 2026-08-07, on the
// SAME vocabulary as the regular people search: connection degrees, which the node
// maps onto the wire codes itself, and free ISO 639-1 codes. NOT the Sales
// Navigator vocabulary next door (F/S/O plus a closed 22-language enum): that is a
// different endpoint. The language regex is the node's own /^[a-z]{2}$/, so it
// refuses nothing the backend would have accepted.
const ServiceProviderSearchFilters = z.object({
  keywords: z.string().max(256).nullable().optional(),
  service_categories: z.array(z.string().regex(/^\d+$/)).max(10).nullable().optional()
    .describe("LinkedIn's own numeric service-category ids, from scrape_linkedin_param_id_lookup(type: \"service_category\"). The same ids the people search takes in its own service_categories member."),
  locations: z.array(z.string().regex(/^\d+$/)).max(10).nullable().optional()
    .describe('Numeric LinkedIn geo ids, from scrape_linkedin_param_id_lookup(type: "location").'),
  network: z.array(z.enum(['1st', '2nd', '3rd_plus'])).max(3).nullable().optional().describe('Relationship-degree facet; the node maps each degree onto the LinkedIn wire code (F/S/O) itself.'),
  profile_languages: z.array(z.string().regex(/^[a-z]{2}$/)).max(10).nullable().optional()
    .describe('ISO 639-1 language codes.'),
}).describe(`${XOR} Service-provider marketplace filters. At least one member must be non-empty. Anything these five cannot express is reachable by pasting the UI URL into this tool's own url field instead.`);

// The first filters vocabulary on this surface with a MANDATORY member: the node
// refuses a jobs filter object that carries no `keywords`, so the usual "at
// least one non-empty member" rule is not enough to keep a call valid here.
//
// experience_level and employment_type are closed vocabularies rather than wire
// values. LinkedIn stopped addressing those two axes by a filter of their own
// and now encodes them as opaque numeric attributes of one segment parameter,
// so the node exposes readable names and does the mapping while it composes the
// URL. A numeric id sent from here is refused by the node validator, and would
// map to nothing even if it got through.
//
// remote is the third attribute of that same segment mechanism, which is why it
// is a boolean and not a workplace enum: only the remote attribute id appears in
// the node's captures, so hybrid and on-site have no id to send. The parser
// still LABELS every row with its workplace_type, so the axis reads in full and
// writes one third.
const JobSearchFilters = z.object({
  keywords: z.string().max(256).describe('REQUIRED: this engine has no wire form without a query, so a filter object carrying only geo_id or only a company is refused rather than run wide.'),
  geo_id: z.string().regex(/^\d+$/).nullable().optional()
    .describe('ONE numeric LinkedIn geo id, from scrape_linkedin_param_id_lookup(type: "job_location"). Resolve it with THAT type: the ids type "location" answers feed the people search\'s locations member and are a different family, so the two must not be crossed. One location per search; a second one, or a radius around it, needs the url half of this tool.'),
  time_posted: z.enum(['past_24h', 'past_week', 'past_month']).nullable().optional()
    .describe('Keep only postings listed inside this window; the node maps it onto LinkedIn\'s own recency value.'),
  company_ids: z.array(z.string().regex(/^\d+$/)).max(10).nullable().optional()
    .describe('LinkedIn\'s own numeric company ids, hiring company. scrape_linkedin_param_id_lookup(type: "company") answers in what looks like the same numeric org-id space, which is our reading of the wire rather than a mapping verified on this engine. A vanity slug is refused here, because the node would accept it and quietly match nothing.'),
  easy_apply: z.boolean().nullable().optional()
    .describe('true keeps only postings with LinkedIn\'s one-click Easy Apply. false and omitted are the same thing: the filter is simply not sent.'),
  remote: z.boolean().nullable().optional()
    .describe('true keeps only REMOTE postings. Hybrid and on-site cannot be asked for: LinkedIn encodes all three as attributes of one workplace facet and only the remote attribute id is known from real traffic, so the other two would be a guess. Rows still come back labelled with workplace_type, so you can read the whole axis; to FILTER on hybrid or on-site, set it in the LinkedIn UI and paste the URL into this tool\'s url field.'),
  experience_level: z.array(z.enum(['entry', 'senior', 'manager', 'director', 'executive'])).max(5).nullable().optional()
    .describe('Seniority the posting asks for, in LinkedIn\'s own dropdown order. Send these readable names: the node maps each onto LinkedIn\'s opaque attribute id itself, and a numeric id is refused.'),
  employment_type: z.array(z.enum(['part_time', 'contract', 'internship', 'full_time', 'volunteer'])).max(5).nullable().optional()
    .describe('Engagement type, in LinkedIn\'s own dropdown order. Readable names only, mapped node-side like experience_level.'),
  early_applicant: z.boolean().nullable().optional()
    .describe('true keeps postings LinkedIn tags "Be an early applicant" (few applications so far). UNPROVEN: the wire parameter behind this one toggle was reasoned out by symmetry with easy_apply and in_your_network, which were both read off captured traffic, and no live run has confirmed it yet. If a page comes back looking unfiltered on this axis, that is the likely cause.'),
  in_your_network: z.boolean().nullable().optional()
    .describe('true keeps only postings at companies where someone in your network works.'),
}).describe(`${XOR} LinkedIn jobs-search filters. keywords is REQUIRED; everything else is optional, and a false boolean is the same as an absent one. Anything this vocabulary cannot express (hybrid or on-site work, more than one location, a radius around one, verified-jobs, and the other facet segments LinkedIn ships) is reachable by pasting the UI URL into the url field instead.`);

// The narrowest filter object on this surface, and deliberately so. The node's
// events handler validates exactly three things (browser_sid, page, keywords)
// and its URL builder writes exactly two query parameters, keywords verbatim
// plus a fixed origin marker, before delegating to the by-url core. There is no
// location facet, no date range, no event type and no organizer axis to mirror.
//
// 🛑 Do not grow this object ahead of the node. A member we accept and the node
// ignores does not fail: it composes a URL LinkedIn does not understand and the
// page comes back with nothing on it, which an agent reads as "no events match"
// rather than as a mistake. That is the one failure mode this whole surface is
// written against.
//
// Nothing here resolves through a typeahead either. The flagship lookup answers
// ids for people-search facets, the products search and the jobs location box;
// this engine takes none of them, so a lookup call before this one is a paid
// detour for an id that fits nowhere.
const EventSearchFilters = z.object({
  keywords: z.string().max(256).describe('REQUIRED, and the WHOLE vocabulary: the events search has no wire form without a query and no second axis to combine with it. Passed to LinkedIn verbatim.'),
// 🛑 .strict(). Zod's default is to STRIP an unknown key, and the facade parses
// before it dispatches, so a caller sending `location` would have it silently
// removed and read the resulting worldwide page as a filtered one. The backend
// refuses unknown members outright (LinkedinScrapingSearchEventsRequest::after(),
// with a message pointing at the url half); stripping here made that guard
// unreachable from MCP. With one legal member the odds of a caller inventing a
// second are high, which is what buys the strictness.
//
// ⚠️ This comment used to say "only this object and the groups one below". That
// stopped being true as the closed-vocabulary verticals landed: courses,
// products and schools are `.strict()` too, so five of the twelve filter objects
// are. The other seven still STRIP, and that list is not just the wide people /
// company / Sales Navigator ones: `JobSearchFilters` closes without `.strict()`
// as well, so an invented jobs facet vanishes silently at the edge and only the
// backend refuses it.
}).strict().describe(`${XOR} LinkedIn events-search filters. keywords is the only member there is, because it is the only one the engine accepts, and any other key is REFUSED rather than ignored. Every facet the LinkedIn events screen itself offers is reachable ONLY by building the search in that UI and pasting the URL into the url field.`);

// The groups vocabulary, and it is the events one again: the node's groups
// handler validates browser_sid, page and keywords, and its URL builder writes
// keywords verbatim plus a fixed origin marker before delegating to the by-url
// core. There is no location, no size band, no industry and no privacy facet to
// mirror, so this object is .strict() for the same reason its neighbour is: one
// legal member makes an invented second one likely, and a silently stripped
// filter reads as "nothing narrower matched" instead of as a mistake.
const GroupSearchFilters = z.object({
  keywords: z.string().max(256).describe('REQUIRED, and the WHOLE vocabulary: the groups search has no wire form without a query and no second axis to combine with it. Passed to LinkedIn verbatim.'),
}).strict().describe(`${XOR} LinkedIn groups-search filters. keywords is the only member there is, and any other key is REFUSED rather than ignored. Anything else the groups screen offers is reachable only by building the search in the LinkedIn UI and pasting the URL into the url field.`);

// The courses vocabulary (LinkedIn LEARNING), and the first one on this surface
// with a required keyword AND two closed enums beside it. The node's handler
// validates browser_sid, page, keywords, difficulty[] and time_to_complete[],
// the last two with .isIn() against the two arrays below, then composes
// /search/results/learning/?keywords=…&origin=FACETED_SEARCH and delegates to
// the by-url core.
//
// 🛑 WE SEND THE SNAKE_CASE NAMES AND TRANSLATE NOTHING. The node owns the two
// lookup tables (beginner -> "Beginner", under_10_mins -> "< 10 mins",
// 3_plus_hours -> "3+ hours") and writes the LinkedIn labels as JSON arrays into
// difficultyLevel / timeToComplete. Mapping here as well would map twice: the
// node's .isIn() refuses a LinkedIn label outright, and a label that slipped
// past would resolve to undefined and poison the parameter, which LinkedIn
// answers with an UNFILTERED page rather than an error. Same trap the jobs
// f_SAL vocabularies carry.
//
// .strict(), like events and groups above, and here the risk is sharper than on
// either: the learning screen DOES ship software and subject facets, this
// vocabulary has no member for them, and a caller who reads that sentence is one
// step away from inventing filters.software. Stripped silently it would run a
// search filtered on neither and read as "these are the courses that match".
const CourseSearchFilters = z.object({
  keywords: z.string().max(256).describe('REQUIRED: this engine has no wire form without a query, so a filter object carrying only a difficulty or only a length band is refused rather than run wide.'),
  difficulty: z.array(z.enum(['beginner', 'intermediate', 'advanced'])).max(3).nullable().optional()
    .describe('Course level, LinkedIn Learning\'s own three. Send these readable names: the node maps each onto LinkedIn\'s own label ("Beginner") while it composes the URL, so a label sent from here is refused by its validator.'),
  time_to_complete: z.array(z.enum(['under_10_mins', '10_to_30_mins', '30_to_60_mins', '1_to_2_hours', '2_to_3_hours', '3_plus_hours'])).max(6).nullable().optional()
    .describe('Course-length bands, in LinkedIn\'s own dropdown order. Readable names only, mapped node-side exactly like difficulty ("< 10 mins", "3+ hours"); the bands are what the UI offers, so an arbitrary minute range cannot be asked for.'),
}).strict().describe(`${XOR} LinkedIn LEARNING course-search filters. keywords is REQUIRED; difficulty and time_to_complete are closed vocabularies whose values the NODE translates into LinkedIn's own labels, so send the names spelled here and never a LinkedIn label. Any other key is REFUSED rather than ignored, which matters because the learning screen also ships software and subject facets this vocabulary does not carry: those are reachable only by building the search in the LinkedIn UI and pasting the URL into the url field.`);

// The products filter object. Two closed-shape id arrays and a one-way toggle,
// and the ids come from TWO DIFFERENT SPACES: product_category from
// param-id-lookup (type=product_category), product_company from the ordinary
// organization id space. Nothing on the path reconciles them, so a swap answers
// with an empty page rather than an error - which is why both describes name
// their source explicitly.
//
// ⚠️ `.min(1)` is load-bearing and unique to this vertical: the node validates
// `isArray({ min: 1 })`, not the bare `isArray()` the courses arrays get, so an
// empty array here is a node-side validation_failed rather than a no-op. The
// backend drops an empty one before dispatch; this refuses it at the edge so the
// caller learns instead of silently having their filter ignored.
//
// .strict(), like events, groups and courses above: a stripped unknown member
// would run a search filtered on the members that survived and read as a
// filtered result.
const ProductSearchFilters = z.object({
  keywords: z.string().max(256).describe('REQUIRED: this engine has no wire form without a query, so a filter object carrying only a category or only the free-version toggle is refused rather than run wide.'),
  free_version: z.boolean().nullable().optional()
    .describe('ONE-WAY toggle. true narrows to products offering a free version; false is identical to omitting it, because the node writes the facet only when the value is truthy. There is no way to ask for products WITHOUT a free version on this wire.'),
  product_category: z.array(z.string().regex(/^\d+$/)).min(1).max(10).nullable().optional()
    .describe('LinkedIn product-category ids, digit strings. Resolve them with param-id-lookup type=product_category, which is this filter\'s only source; this search is that lookup type\'s first consumer. Not interchangeable with product_company.'),
  product_company: z.array(z.string().regex(/^\d+$/)).min(1).max(10).nullable().optional()
    .describe('Vendor organization ids, digit strings. NOT a param-id-lookup type of its own: resolve them with type=company, whose ids this filter accepts (verified live: type=company "Salesforce" gives 3185, and that id narrows a crm search from 1600 results to 3, all published by Salesforce). A category id used here matches nothing and returns an ordinary empty page.'),
}).strict().describe(`${XOR} LinkedIn product-search filters. keywords is REQUIRED; free_version is a one-way toggle; product_category and product_company are arrays of digit-string ids from two DIFFERENT id spaces, and nothing validates one against the other, so a category id in the company slot returns an ordinary empty page. Any other key is REFUSED rather than ignored.`);

// The schools filter object. ONE member, the events shape rather than the
// products one: the node validator is browser_sid + page + keywords and its
// builder writes that keyword plus a fixed origin=SWITCH_SEARCH_VERTICAL. No
// location, no size, no degree type, and the capture carries nothing else.
//
// 🛑 .strict(), and here the risk is the sharpest on the whole surface. Zod
// strips an unknown key by default and the facade parses before it dispatches,
// so `location` would vanish silently and a worldwide page would read as a
// filtered one. On this vertical a caller has TWO obvious inventions rather than
// one: the screen's own chips (location, size), and `school_id`, because
// param-id-lookup has a `school` type that returns real school ids and this is
// the school search. Neither exists here.
const SchoolSearchFilters = z.object({
  keywords: z.string().max(256).describe('REQUIRED, and the WHOLE vocabulary: the schools search has no wire form without a query and no second axis to combine with it. Passed to LinkedIn verbatim.'),
}).strict().describe(`${XOR} LinkedIn school-search filters. keywords is the ONLY member the node reads, so any other key is REFUSED rather than ignored. In particular there is NO school-id member: the ids param_id_lookup returns for type=school fit no filter on this engine and reach LinkedIn only inside a pasted people-search URL. Every facet the schools screen offers beyond the keyword box is reachable only by building the search in the LinkedIn UI and pasting that URL into the url field.`);

const ProfileTarget = z.object({
  ln_id: z.string().max(128).nullable().optional().describe('Regular-profile URN (ACoAA…).'),
  sn_id: z.string().max(64).nullable().optional().describe('Sales Navigator URN (ACwAA…).'),
  nickname: z.string().max(100).nullable().optional().describe('Vanity slug.'),
}).describe('Target profile: exactly one of ln_id / sn_id / nickname (ln_member_id is not dispatchable, KNOWLEDGE §3d).');

const CompanyTarget = z.object({
  company_url: z.string().max(512).nullable().optional().describe('https://www.linkedin.com/company/{slug}/'),
  company_ln_id: z.string().max(64).nullable().optional().describe('Numeric LinkedIn company id.'),
}).describe('Target company: exactly one of company_url / company_ln_id.');

// The nine dropdowns of the flagship (non Sales Navigator) search, node
// `typehead-linkedin` `type` values passed through verbatim. The pre-landing
// sketch guessed a different vocabulary (geo / past_company / title / service);
// the shipped verb decides, so the names are the node's and the two axes with no
// dropdown behind them (past_company, title) are gone rather than faked. A type
// LinkedIn does not know would come back as an empty list, which reads as
// "nobody matches" instead of as a mistake.
//
// Not every type has a filters member to feed: school ids fit no filter here
// (school is free text on this engine), and school is now the ONLY one left in
// that state. It stays in the enum because it is a real dropdown a caller may be
// reading off a URL, and the describe says so. job_location left that list on
// 2026-08-08 with the jobs search, and product_category left it on 2026-08-09
// with scrape_linkedin_search_products, which is the only consumer of its ids -
// this comment claimed the opposite for two days while the lookup was already
// returning real category ids.
const LookupType = z.enum([
  'people', 'connections', 'location', 'company', 'school',
  'industry', 'service_category', 'product_category', 'job_location',
])
  .describe('Which dropdown to type into. Where each id lands in the search_people filters: people → followers_of, connections → connections_of, location → locations, company → current_companies, industry → industries, service_category → service_categories. search_service_providers takes the same location and service_category ids; search_companies takes location as geo_ids and industry as industry_ids (matched on the people search, not yet verified there). job_location is the JOBS search box and its ids feed the search_jobs geo_id member ONLY: a different family from the location ids above, so do not cross the two. product_category feeds the search_products product_category member, and ONLY that one: its sibling product_company takes ordinary organization ids, which this endpoint does not resolve under that name (use type=company). school is the one type with no filter member on this surface.');

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

// Six engines on this surface carry a result count on the wire, jobs, events,
// groups, courses, products and schools, so their paging block can fill `total` where every other
// page-numbered engine leaves it null. The number is whatever "N results" line
// the rendered page printed first, so a capped display ("1,000+ results") comes
// back as null and a second counter widget on the page could hand back the wrong
// one. It is a figure to show a user, never a loop bound.
const CountedPageNumberPaging = PageNumberPaging
  .describe('Page-numbered paging: re-call with page + 1 while has_more. total carries LinkedIn\'s own result count when the page printed one, best effort and null otherwise, so drive the loop from has_more.');

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

// The THIRD row kind on this surface, and the reason the jobs search could not
// reuse either projector above. A posting is not a person and not a company: no
// member id, no vanity slug, no company urn. job_ln_id is its only stable
// identity (the wire calls it job_id; our surface spells every LinkedIn-side id
// *_ln_id, like post_ln_id and company_ln_id above), and job_url is built from
// that id rather than read off the page, so it carries no tracking parameters.
//
// Everything textual is lifted off the rendered card by ENGLISH markers ("Easy
// Apply", "Posted 3 days ago", the "(Remote)" parenthetical). On an executor
// whose LinkedIn UI is in another language the flags read false, the text fields
// read null, and in the worst case no row survives at all while the call still
// reports success. That is a node-side property, not something our edge can
// repair, so account UI language is a real precondition for this vertical.
const LinkedinJobPreview = z.object({
  job_ln_id: z.string().describe('LinkedIn\'s numeric posting id, the only stable identity a job row carries. A card whose id cannot be read is dropped rather than returned half-formed.'),
  job_url: z.string().describe('https://www.linkedin.com/jobs/view/{job_ln_id}/ , composed from the id, so it is stable and free of tracking parameters.'),
  title: z.string().describe('Posting title. A card whose title cannot be read is dropped, so this is never null.'),
  company_name: z.string().nullable(),
  company_logo_url: z.string().nullable().describe('Best effort: a card renders several images and the employer logo is picked as the most frequently repeated one.'),
  location: z.string().nullable().describe('The card\'s location line VERBATIM, workplace parenthetical included ("Yerevan, Armenia (Hybrid)"). null whenever the card shows no parenthetical, even when a city is plainly on screen.'),
  workplace_type: z.enum(['On-site', 'Remote', 'Hybrid']).nullable().describe('Read out of the same parenthetical as location, so the two are null together and consistent together.'),
  listed_date_text: z.string().nullable().describe('Posting age the way LinkedIn writes it ("Posted 3 hours ago", "Posted 1 month ago"). Free text, not a timestamp.'),
  salary_text: z.string().nullable().describe('Compensation as printed on the card ("$18K/yr - $25K/yr"): currency, range and period all live inside the one string, nothing is broken out. Best effort.'),
  easy_apply: z.boolean().describe('The posting takes LinkedIn\'s one-click Easy Apply.'),
  is_early_applicant: z.boolean().describe('The card carries LinkedIn\'s "Be an early applicant" hint.'),
  is_verified: z.boolean().describe('LinkedIn marks this as a verified job.'),
  social_proof_text: z.string().nullable().describe('The card\'s connection or alumni line ("1 connection works here", "93 school alumni work here"). Both kinds land here undifferentiated. Best effort.'),
  position: z.number().int().nullable().describe('The card\'s slot on THIS page, 0 based and page local. It is not a rank across pages, so do not use it as a cross-page ordinal. The parser always fills it, so null here means the key was missing from the wire row, not that the card had no slot.'),
}).passthrough();

// The FOURTH row kind on this surface. An event is not a person, not a company
// and not a job posting: it carries its own numeric id, its own /events/ URL and
// a card whose every visible line is free text. event_ln_id is its only stable
// identity (the wire calls it event_id; our surface spells every LinkedIn-side
// id *_ln_id, like job_ln_id and company_ln_id above), and event_url is composed
// from that id rather than read off the page, so it carries no tracking params.
//
// Nullability here is established from the node parser
// (linkedinApiSdk/src/events/eventsSearchParser.ts), not from its result type
// declaration. The parser DROPS a card whose id or whose title it cannot read,
// so those two plus the composed URL are the only fields that are never null;
// every other field is a best-effort read of a rendered card and comes back null
// when the marker it looks for is not on screen. Same discipline as the jobs
// search, where the fix for a missing required field was to drop the row rather
// than emit a null into a non-nullable output field.
//
// The parser is ENGLISH-ONLY and never throws: it splits the card by font role
// and by English markers ("Online", "In person", "By <organizer>", "N attendees").
// On another interface language, on a LinkedIn shape drift, or when the
// rehydration global does not appear inside the plugin's 10 s wait, it answers
// zero rows with status success, the same shape as a genuine end of feed.
const LinkedinEventPreview = z.object({
  event_ln_id: z.string().describe('LinkedIn\'s numeric event id (the wire\'s event_id), the only stable identity an event row carries. A card whose id cannot be read is dropped rather than returned half-formed, and a repeat of an id already seen on this page is dropped too.'),
  event_url: z.string().describe('https://www.linkedin.com/events/{event_ln_id}/ , composed from the id, so it is stable and free of tracking parameters.'),
  title: z.string().describe('Event title. A card whose title cannot be read is dropped, so this is never null.'),
  date_text: z.string().nullable().describe('The date line as LinkedIn printed it ("Wed, Sep 16 - Fri, Sep 18", "Wed, Jul 29, 11:00 AM", "Jul 29, 2026"). Free text in the viewing account\'s own timezone, not a timestamp, and start and end are not split out.'),
  location_text: z.string().nullable().describe('Where it happens, as printed: "Online", "In person", "Hybrid" or a venue. When the card packs location and organizer into one bulleted line, this holds the left half only.'),
  organizer: z.string().nullable().describe('The "By <name>" half of that same line, prefix stripped. null whenever the card printed no bullet, which is the common case, so null here means the card did not name an organizer rather than that the event has none.'),
  description: z.string().nullable().describe('The card\'s blurb: the longest small-print line that is not the attendee counter. LinkedIn truncates it on the card, so it is a snippet, not the event description.'),
  attendee_count: z.number().int().nullable().describe('Attendees, parsed out of attendees_text. 0 is a REAL value and means the card said "Be the first attendee"; null means no counter was read at all. Do not conflate the two. A compact counter is rounded on the way in ("2.3K attendees" becomes 2300), so a large number is an approximation.'),
  attendees_text: z.string().nullable().describe('The counter exactly as printed ("4 attendees", "2.3K attendees", "Be the first attendee"). Read this whenever the rounding in attendee_count would matter.'),
  thumbnail_url: z.string().nullable().describe('Event cover image, widest rendition available. Best effort: a card renders several images and the most repeated asset is taken as the cover.'),
  position: z.number().int().nullable().describe('The card\'s slot on THIS page, 0 based and page local, so it is not a rank across pages. Numbering happens before duplicate ids are dropped, which can leave gaps. The parser always fills it, so null means the key was missing from the wire row.'),
}).passthrough();

// The FIFTH row kind, and the reason groups could not reuse any projector above.
// A group is not a person, not a company, not a job posting and not an event: no
// member id, no vanity slug, no company urn. group_ln_id is its only stable
// identity (the wire calls it group_id, lifted out of urn:li:group:{id} or a
// /groups/{id} link; our surface spells every LinkedIn-side id *_ln_id), and
// group_url is composed from that id rather than read off the page.
//
// 🛑 THE ENGLISH DEPENDENCY IS TOTAL HERE, worse than the jobs search and much
// worse than events. The node parser reads the group NAME out of the card's own
// English error toast ("Unable to join {NAME}. Please try again.") and falls back
// to the join button label ("Join {NAME}"). A card whose name it cannot read is
// DROPPED, so on a non-English executor every card is dropped, the page answers
// zero rows with status success, and that is indistinguishable from the end of
// the feed. Jobs and events degrade field by field there; groups returns nothing.
// privacy and the member counter are read off English copy too.
//
// There is NO commercial_use_limit_hit on this vertical: the wire carries no
// wasStrike (the groups screen has no people-search paywall upsell), so the
// field would be structurally always false and would advertise a detector that
// does not exist. Same call as jobs and events.
const LinkedinGroupPreview = z.object({
  group_ln_id: z.string().describe('LinkedIn\'s numeric group id, the only stable identity a group row carries. A card whose id cannot be read is dropped rather than returned half-formed, and a repeat of an id already seen on this page is dropped too.'),
  group_url: z.string().describe('https://www.linkedin.com/groups/{group_ln_id}/ , composed from the id, so it is stable and free of tracking parameters.'),
  name: z.string().describe('Group name. A card whose name cannot be read is dropped, so this is never null, which is exactly why a non-English executor returns an empty page instead of nameless rows.'),
  // Deliberately a string and not a z.enum: the backend mapper passes the wire
  // label straight through (no PHP enum backs it), so a closed Zod enum here
  // would promise a guarantee nothing enforces.
  privacy: z.string().nullable().describe('"Public" or "Private", LinkedIn\'s own casing, read from the card\'s "Public Group" / "Private Group" label. English-only, so it goes null on any other interface language rather than guessing.'),
  member_count: z.number().int().nullable().describe('Members, parsed out of members_text. 0 is a REAL value; null means no counter was read at all. Do not conflate the two, and do not test for falsiness.'),
  members_text: z.string().nullable().describe('The counter exactly as LinkedIn printed it ("1,204 members").'),
  description: z.string().nullable().describe('Best-effort blurb, ASSEMBLED rather than read: LinkedIn splits the text into several chunks, so the parser collects the human-looking strings in the card and joins them. It can pick up unrelated card copy, so do not hang hard product logic on it.'),
  logo_url: z.string().nullable().describe('Group logo, widest rendition available. Best effort: the card renders several images and the most repeated asset is taken as the logo, so cross-card bleed is possible.'),
  position: z.number().int().nullable().describe('The card\'s slot on THIS page, 0 based and page local, so it is not a rank across pages. Numbering happens before duplicate ids are dropped, which can leave gaps. The parser always fills it, so null means the key was missing from the wire row.'),
}).passthrough();

// The SIXTH row kind. A LinkedIn Learning course is not a person, not a company,
// not a job posting, not an event and not a group: it has no numeric id at all,
// only a SLUG, which is why the identity field here is course_slug and not a
// *_ln_id like every neighbour above. course_url is composed from that slug.
//
// Nullability is established from the node parser
// (linkedinApiSdk/src/courses/coursesSearchParser.ts), not from its result type.
// The parser DROPS a card whose slug or whose title it cannot read, so those two
// plus the composed URL are the only fields that are never null.
//
// 🛑 THE ENGLISH DEPENDENCY IS TOTAL, the groups failure mode again: the title
// is lifted out of the English button template "Save the course <TITLE>" (or
// "Unsave the course <TITLE>"), so on a non-English executor every card is
// dropped, the page answers zero rows with status success, and that is
// indistinguishable from the end of the feed. Author, duration, release line and
// the viewer counter are read off English copy too.
const LinkedinCoursePreview = z.object({
  course_slug: z.string().describe('The /learning/{slug} path segment, and the ONLY identity a course row carries: this vertical has no numeric id anywhere on the wire. A card whose slug cannot be read is dropped rather than returned half-formed, and a repeat of a slug already seen on this page is dropped too.'),
  course_url: z.string().describe('https://www.linkedin.com/learning/{course_slug}/ , composed from the slug, so it is stable and free of tracking parameters.'),
  title: z.string().describe('Course title, read out of the English "Save the course <TITLE>" button label. A card whose title cannot be read is dropped, so this is never null, which is exactly why a non-English executor returns an empty page instead of untitled rows.'),
  author: z.string().nullable().describe('The instructor, from the card\'s "By: <name>" line with the prefix stripped. A bare NAME: no member id, no vanity slug, so joining an instructor back to a LinkedIn profile needs a second search.'),
  duration_text: z.string().nullable().describe('Course length, NORMALISED rather than quoted: the parser reads LinkedIn\'s accessible form ("6 hours and 14 minutes", "1 day and 10 hours"), folds days into hours and re-prints it compactly ("34h 10m", "45m"). It is not the string on the card and not a number of minutes, so parse it if you need arithmetic.'),
  released_text: z.string().nullable().describe('The release line VERBATIM, prefix included ("Released Jan 2026"). Free text, not a date, and unlike author the "Released " prefix is deliberately not stripped.'),
  viewers_text: z.string().nullable().describe('The viewer counter exactly as printed ("12,345 viewers", "1.2M viewers"). Kept as text on purpose: LinkedIn rounds the compact form, so there is no honest integer to parse it into.'),
  thumbnail_url: z.string().nullable().describe('Course artwork, widest rendition available. Best effort: a card renders several images and the most repeated asset is taken as the thumbnail.'),
  position: z.number().int().nullable().describe('The card\'s slot on THIS page, 0 based and page local, so it is not a rank across pages. Numbering happens before duplicate slugs are dropped, which can leave gaps. The parser always fills it, so null means the key was missing from the wire row.'),
}).passthrough();

// The SEVENTH row kind. ⚠️ product_slug is the wire's `product_id` renamed: the
// value is a /products/{slug}/ path segment, never a number, and this is the one
// vertical where real numeric ids sit beside it in the request - a field called
// product_id next to product_company invites feeding a slug into an id filter,
// which fails nowhere and returns an empty page.
const LinkedinProductPreview = z.object({
  product_slug: z.string().describe('The /products/{slug} path segment, and the ONLY identity a product row carries: this wire has no numeric id anywhere. ⚠️ The node calls this field product_id; it is NOT an id and must never be sent as one into product_category or product_company. A card whose slug cannot be read is dropped, and a repeat of a slug already seen on this page is dropped too.'),
  product_url: z.string().describe('https://www.linkedin.com/products/{product_slug}/ , composed from the slug, so it is stable and free of tracking parameters. Pasting it back into this tool\'s url field is refused: it is one product\'s page, not a search.'),
  name: z.string().describe('Product name, read off the card\'s single bold text run rather than out of English copy, so it survives a non-English interface. A card without one is dropped, so this is never null.'),
  category_text: z.string().nullable().describe('The category line as printed ("CRM Software"). ⚠️ Derived by elimination: it is the first small text run that is NOT the "By:" line, so on a non-English interface, where the By: test stops matching, this field can carry the COMPANY name instead. Unreliable rather than absent off English.'),
  company: z.string().nullable().describe('The vendor, from the card\'s "By: <name>" line with the prefix stripped. A bare NAME: no organization id and no link, so it cannot be fed into product_company without a separate lookup. Null on a non-English interface.'),
  tagline: z.string().nullable().describe('The product\'s one-line pitch. ⚠️ Picked as the longest remaining small-print run after the Top-Features and connections lines are excluded by their English prefixes. On a non-English interface both exclusions stop working, so this most often holds the TOP-FEATURES list (usually the longest run) and sometimes the connections line.'),
  top_features: z.string().nullable().describe('The "Top Features:" line with the prefix stripped, a single comma-joined string rather than a list. Null when the card does not print one, and null on a non-English interface.'),
  connections_count: z.number().int().nullable().describe('How many of your connections can be asked about this product, parsed from the text below, so "1.2K" becomes 1200. ROUNDED, because the string it came from was: LinkedIn never printed an exact number.'),
  connections_text: z.string().nullable().describe('That same counter exactly as printed ("1.2K connections to ask about this product"). Kept alongside the number because the number is a rounding of it.'),
  logo_url: z.string().nullable().describe('Product artwork, widest rendition available. Best effort: a card renders several images and the most repeated asset is taken as the logo.'),
  position: z.number().int().nullable().describe('The card\'s slot on THIS page, 0 based and page local, so it is not a rank across pages. Numbering happens before dropped and duplicate cards are removed, which can leave gaps.'),
}).passthrough();

// The EIGHTH row kind. Closest to a company and still not one: no company urn on
// the wire, and the counter is students and alumni rather than employees.
// ⚠️ school_slug is the wire's `school_id` renamed, and here the reason is not
// the products one (numeric ids in the filters) but a nastier neighbour:
// param-id-lookup's `school` type returns REAL numeric school ids, so a row
// field called school_id would read as one of those.
const LinkedinSchoolPreview = z.object({
  school_slug: z.string().describe('The /school/{slug} path segment, and the ONLY identity a school row carries. ⚠️ The node calls this field school_id; it is a vanity slug, NOT the numeric id param_id_lookup returns for type=school, and the two are unrelated. ⚠️ It can be URL-ENCODED (an apostrophe arrives as %27) because the parser never decodes it; pass it through as-is or school_url stops matching.'),
  school_url: z.string().describe('https://www.linkedin.com/school/{school_slug}/ , composed from the slug, so it is stable and free of tracking parameters. Pasting it back into this tool\'s url field is refused: it is one school\'s page, not a search.'),
  name: z.string().describe('School name, read off the card\'s single bold text run rather than out of English copy, so it survives a non-English interface. A card without one is dropped, so this is never null.'),
  location_text: z.string().nullable().describe('The location line as printed ("Stanford, California"). Free text, never parsed into city / country. Positional rather than prefix-matched, so unlike the products category line it stays correct on a non-English interface; simply absent on schools that print none.'),
  students_alumni_count: z.number().int().nullable().describe('How many students and alumni LinkedIn reports, parsed from the text below, so "448K" becomes 448000. ROUNDED, because the string it came from was: LinkedIn never printed an exact number. Not an employee count and not comparable to a company headcount.'),
  students_alumni_text: z.string().nullable().describe('That same counter exactly as printed ("448K students and alumni on LinkedIn"). ⚠️ Read through the one English pattern on this card, so it goes null on a non-English interface, and see the description warning below.'),
  description: z.string().nullable().describe('The school blurb. ⚠️ Picked as the longest small-print run once the students-and-alumni line is excluded by its English wording. On a non-English interface that exclusion stops working, so this field can silently hold the STUDENTS line instead of a description.'),
  logo_url: z.string().nullable().describe('School logo, widest rendition available. Best effort: a card renders several images and the most repeated asset is taken as the logo.'),
  position: z.number().int().nullable().describe('The card\'s slot on THIS page, 0 based and page local, so it is not a rank across pages. Numbering happens before dropped cards are removed, which can leave gaps.'),
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
  reactions_count: z.number().int().describe('SUM of every reaction bucket on the comment, not a like count.'),
  comment_permalink: z.string().nullable().describe('Public deep link to this comment.'),
  replies_count: z.number().int().describe('How many replies the comment has. A COUNT ONLY: this verb queries the post\'s comment list and fetches no replies, so there is no way to read them and no replies array to ask for.'),
  is_pinned: z.boolean(),
  is_edited: z.boolean(),
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


// One typeahead option. The node hands back exactly {id, display_value,
// subtitle?} and nothing else: no entity_urn, no image_url, no headline (those
// three are Sales-Navigator-only fields of the twin below). `subtitle` is the
// option's second visible line and is ABSENT on the wire, not null, for the six
// types that render a single line, so the backend fills it in as null here.
const LinkedinParamIdPreview = z.object({
  type: LookupType.describe('Echo of the requested type, so a caller batching several lookups can tell the rows apart.'),
  id: z.string().describe('The raw filter value the picked option feeds, e.g. location "104001442", company "167560", people "ACoAAADnFr8Brc7l...". Not a urn. Goes into the filter member verbatim.'),
  display_name: z.string().describe('The option label, LinkedIn\'s first visible line (wire display_value).'),
  subtitle: z.string().nullable().describe('The option\'s second line: member headline for people/connections, industry for company. null for the other six types, which render one line.'),
}).passthrough();

const LinkedinSalesNavParamIdPreview = z.object({
  type: z.string(),
  id: z.string().describe('Opaque SN facet id. Feed it VERBATIM into the SN search filters (company "urn:li:organization:1441", geo "100506914", …).'),
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

// All 20 verbs share these annotations (research §Shared per-call semantics):
// not read-only (spends rate budget, writes the ledger),
// not idempotent (a repeat call without idempotency_key re-executes).
const SCRAPE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

const STUB = '⛔ NOT SHIPPED YET. The contract is locked and validated now but the plugin verb is not built. Every valid, allowed call returns 501 not_implemented (context.reason=blocked_on_plugin) with no ledger row; do not retry.';

const base = {
  service: 'linkedin',
  entity: 'linkedin_scraping',
  mount: 'linkedin.scraping',
} as const;

const rt = (path: string) => ({ service: 'linkedin' as const, method: 'POST' as const, pathTemplate: `/api/linkedin-scraping/${path}` });

// ═══════════════════════════════════════════════════════════════
// The url half of the twelve merged search verbs.
// ═══════════════════════════════════════════════════════════════
//
// One prefix per vertical, copied VERBATIM from the backend's own
// LinkedinScrapingSearchRequest::urlPrefix() implementations (which feed a
// Laravel `starts_with:` rule) and cross-checked against the node's URL regexes.
// The two Sales Navigator prefixes carry NO trailing slash and the other seven
// do; that asymmetry is LinkedIn's, not a typo, and copying it wrong here would
// refuse a URL the backend accepts.
//
// 🛑 KEEP THIS TABLE IN SYNC WITH THE BACKEND. `.startsWith()` renders as a
// JSON-schema `pattern`, so a wrong-vertical URL is refused at the edge with a
// readable message instead of costing a round trip for a 422 invalid_search_url.
// That is the whole reason the check is duplicated here: with twelve
// near-identical search tools, pasting an events URL into the jobs tool is the
// likely mistake, and the local refusal names the prefix it wanted. On products
// and schools the likely mistake is different and worse: `/products/{slug}/` and
// `/school/{slug}/` are ONE row's own page and are exactly what those tools' rows
// link to, so a caller round-trips a row back into the search and gets zero rows
// at success.
const PREFIX = {
  people: 'https://www.linkedin.com/search/results/people/',
  salesNavPeople: 'https://www.linkedin.com/sales/search/people',
  companies: 'https://www.linkedin.com/search/results/companies/',
  salesNavCompanies: 'https://www.linkedin.com/sales/search/company',
  serviceProviders: 'https://www.linkedin.com/search/results/services/',
  posts: 'https://www.linkedin.com/search/results/content/',
  jobs: 'https://www.linkedin.com/jobs/search-results/',
  events: 'https://www.linkedin.com/search/results/events/',
  groups: 'https://www.linkedin.com/search/results/groups/',
  // ⚠️ LEARNING, not /courses/. The screen behind the courses vertical is
  // LinkedIn Learning and the node's regexp is
  // ^https://www\.linkedin\.com/search/results/learning/ , so a prefix written
  // from the vertical's NAME would refuse every URL a caller can actually paste.
  courses: 'https://www.linkedin.com/search/results/learning/',
  // Route name and screen path agree here, unlike courses above. The near miss
  // is `/products/{slug}/`, a single product's page rather than a search.
  products: 'https://www.linkedin.com/search/results/products/',
  // The near miss is `/school/{slug}/` (SINGULAR), one school's page, which is
  // what this vertical's own rows link to.
  schools: 'https://www.linkedin.com/search/results/schools/',
} as const;

/**
 * The `url` field: the pasted-URL half of the XOR. Nullable on purpose, because
 * an agent that builds arguments programmatically writes `url: null` on the
 * filters half and the backend accepts exactly that (`nullable`, and an empty
 * value trips neither `prohibits` nor the other side's `required_without`).
 * Refusing it here would be stricter than the route for no gain.
 */
const searchUrl = (prefix: string, note = '') => z.string().max(2048).startsWith(prefix).nullable().optional()
  .describe(`EXCLUSIVE with \`filters\`: send url OR filters, never both (422) and never neither (422). A search URL built in the LinkedIn UI, and the escape hatch for everything the filter vocabulary cannot express. MUST start with ${prefix} : a URL from another LinkedIn search screen is refused here and again by the backend (422 invalid_search_url), because running it would silently scrape the wrong thing.${note}`);

/** The `page` field, shared by the eleven page-numbered search verbs. */
const pageField = (note = '') => z.number().int().min(1).max(100).optional()
  .describe(`LinkedIn page number, default 1; ONE page per call, so re-call with page + 1 while paging.has_more.${note}`);

/** What a pasted URL's own offset does when our page number disagrees with it. */
const OUR_PAGE_WINS = ' On the url half OUR number wins: the offset or page parameter baked into the pasted URL is overwritten, while every other parameter rides through untouched.';

export const linkedinScrapingTools: ToolDefinition[] = [
  {
    ...base,
    name: 'scrape_linkedin_search_people',
    description:
      'One page of a regular LinkedIn people search, addressed EITHER by `filters` OR by a pasted search `url`: exactly one of the two, never both, never neither. Use filters when the agent composes the search itself, url for a search already built in the LinkedIn UI or for anything the filter vocabulary cannot express. Same engine and the same person rows either way; page on with paging.has_more. commercial_use_limit_hit true means LinkedIn\'s monthly search paywall fired and rows may be truncated: switch to the Sales Navigator people tool or wait for the reset.',
    toolClass: 'typical',
    route: rt('search-people'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      ...requestBase,
      url: searchUrl(PREFIX.people),
      filters: PeopleSearchFilters.nullable().optional(),
      page: pageField(),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), runResult(LinkedinPersonPreview, PageNumberPaging, {
      commercial_use_limit_hit: z.boolean().describe('LinkedIn’s people-search commercial-use-limit upsell fired (wire wasStrike), so rows may be truncated; switch to the SN engine or wait for the monthly reset.'),
    })),
    annotations: { title: 'Scrape LinkedIn people search', ...SCRAPE },
  },
  {
    ...base,
    name: 'scrape_linkedin_search_sales_nav_people',
    description:
      'One page of a Sales Navigator people search: richer facets than the regular engine (seniority, function, tenure, headcount, company type), no commercial-use limit, SN URNs (sn_id) on the rows. Addressed EITHER by `filters`, which carry the COMPLETE SN facet vocabulary, OR by a pasted /sales/search/people `url`: exactly one of the two. Typeahead members take [{id, text, exclude}] values from scrape_linkedin_sales_nav_param_id_lookup; the static-enum members list their ids inline and need no lookup. Needs an SN-capable executor (a non-SN own account gets 422 sales_nav_required; the auto-pick filters to SN seats).',
    toolClass: 'typical',
    route: rt('search-sales-nav-people'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      ...requestBase,
      url: searchUrl(PREFIX.salesNavPeople),
      filters: SalesNavPeopleSearchFilters.nullable().optional(),
      page: pageField(),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), runResult(LinkedinPersonPreview, PageNumberPaging)),
    annotations: { title: 'Scrape Sales Navigator people search', ...SCRAPE },
  },
  {
    ...base,
    name: 'scrape_linkedin_search_service_providers',
    description:
      "One page of LinkedIn's service-provider marketplace (freelancers and agencies), addressed EITHER by `filters` (keywords, LinkedIn's own numeric service-category and geo ids, connection degree, profile language) OR by a pasted /search/results/services/ `url`, which is how to reach anything those five cannot express: exactly one of the two. Rows are the same person previews the people search returns, because the services screen carries no ratings and no service labels in its results, only provider profiles.",
    toolClass: 'typical',
    route: rt('search-service-providers'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      ...requestBase,
      url: searchUrl(PREFIX.serviceProviders),
      filters: ServiceProviderSearchFilters.nullable().optional(),
      page: pageField(),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), runResult(LinkedinServiceProviderPreview, PageNumberPaging)),
    annotations: { title: 'Scrape service-provider search', ...SCRAPE },
  },
  {
    ...base,
    name: 'scrape_linkedin_search_jobs',
    description:
      "One page of a LinkedIn JOB-POSTING search, addressed EITHER by `filters` (keywords is REQUIRED here, which no other engine on this surface demands) OR by a pasted /jobs/search-results/ `url`, which is the only way to hybrid or on-site work, several locations, a radius around one, verified jobs and the other facet segments LinkedIn ships: exactly one of the two. Rows are postings keyed by job_ln_id, with a tracking-free /jobs/view/ URL, title, hiring company, location plus workplace_type, listing age, the salary line as printed, and the Easy Apply / early-applicant / verified flags. Card text is read off an ENGLISH LinkedIn UI: an executor whose interface is another language returns zero rows and still reports success. Page on with has_more, never on paging.total.",
    toolClass: 'typical',
    route: rt('search-jobs'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      ...requestBase,
      url: searchUrl(PREFIX.jobs, OUR_PAGE_WINS),
      filters: JobSearchFilters.nullable().optional(),
      page: pageField(OUR_PAGE_WINS),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), runResult(LinkedinJobPreview, CountedPageNumberPaging)),
    annotations: { title: 'Scrape job-posting search', ...SCRAPE },
  },
  {
    ...base,
    name: 'scrape_linkedin_search_events',
    description:
      "One page of a LinkedIn EVENT search. `filters` carries keywords and NOTHING else (this engine has no location, date, type or organizer facet, and any other key is refused by name), so a pasted /search/results/events/ `url` is the only way to any facet the events screen itself offers: send exactly one of the two. Rows are events keyed by event_ln_id, with a tracking-free /events/ URL, title, the date and location lines as printed, the organizer when the card names one, the blurb, the attendee counter (0 is real, null is unread) and a cover image. The English dependency is PARTIAL: rows still come back on another interface language, but date_text and location_text can swap and organizer and attendee_count go null, silently. Page on with has_more, never on paging.total.",
    toolClass: 'typical',
    route: rt('search-events'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      ...requestBase,
      url: searchUrl(PREFIX.events, OUR_PAGE_WINS),
      filters: EventSearchFilters.nullable().optional(),
      page: pageField(OUR_PAGE_WINS),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), runResult(LinkedinEventPreview, CountedPageNumberPaging)),
    annotations: { title: 'Scrape event search', ...SCRAPE },
  },
  {
    ...base,
    name: 'scrape_linkedin_search_groups',
    description:
      "One page of a LinkedIn GROUP search, the fifth row kind on this surface. `filters` carries keywords and nothing else, exactly like the events search, so a pasted /search/results/groups/ `url` is the only way to anything the groups screen offers beyond a keyword: send exactly one of the two. Rows are groups keyed by group_ln_id, with a /groups/ URL, the name, Public or Private, the member counter both as printed and parsed (0 is real, null is unread), a best-effort blurb and a logo. WARNING, the English dependency is TOTAL, worse than the jobs search: the name is read out of English UI copy and a card whose name cannot be read is dropped, so a non-English executor returns ZERO rows and still reports success. Page on with has_more, never on paging.total.",
    toolClass: 'typical',
    route: rt('search-groups'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      ...requestBase,
      url: searchUrl(PREFIX.groups, OUR_PAGE_WINS),
      filters: GroupSearchFilters.nullable().optional(),
      page: pageField(OUR_PAGE_WINS),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), runResult(LinkedinGroupPreview, CountedPageNumberPaging)),
    annotations: { title: 'Scrape group search', ...SCRAPE },
  },
  {
    ...base,
    name: 'scrape_linkedin_search_courses',
    description:
      'One page of a LinkedIn LEARNING course search, the sixth row kind here: `filters` OR a pasted /search/results/learning/ `url` (that screen, NOT /courses/), exactly one of the two. filters is a REQUIRED keywords plus two closed vocabularies, difficulty and time_to_complete, whose snake_case values the NODE maps onto LinkedIn\'s own labels, so never send a label yourself; the screen\'s software and subject facets need the url form. Rows are courses keyed by course_slug (this wire has no numeric id), with a tracking-free /learning/ URL, title, instructor, a normalised duration, the release and viewer lines as printed, and artwork. WARNING, the English dependency is TOTAL, as on groups: the title is read out of the "Save the course X" button label and a card without a readable title is DROPPED, so a non-English executor returns ZERO rows at success. Page on has_more, never on paging.total.',
    toolClass: 'typical',
    route: rt('search-courses'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      ...requestBase,
      url: searchUrl(PREFIX.courses, OUR_PAGE_WINS),
      filters: CourseSearchFilters.nullable().optional(),
      page: pageField(OUR_PAGE_WINS),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), runResult(LinkedinCoursePreview, CountedPageNumberPaging)),
    annotations: { title: 'Scrape LinkedIn Learning course search', ...SCRAPE },
  },
  {
    ...base,
    name: 'scrape_linkedin_search_products',
    description:
      'One page of a LinkedIn PRODUCT search, the seventh row kind here: `filters` OR a pasted /search/results/products/ `url`, exactly one of the two. filters is a REQUIRED keywords plus a one-way free_version toggle and two arrays of digit-string ids that come from DIFFERENT places: product_category from param-id-lookup type=product_category, product_company from the ordinary organization id space. Nothing reconciles them, so a swapped id returns an empty page, not an error. Rows are product pages keyed by product_slug (the wire calls it product_id, but it is a slug and must never be sent back as an id), with a tracking-free /products/ URL, name, vendor, tagline, top features and a connections counter. Unlike courses, a non-English executor still returns named rows here, but category_text and tagline can silently carry the WRONG text. Page on has_more, never on paging.total.',
    toolClass: 'typical',
    route: rt('search-products'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      ...requestBase,
      url: searchUrl(PREFIX.products, OUR_PAGE_WINS),
      filters: ProductSearchFilters.nullable().optional(),
      page: pageField(OUR_PAGE_WINS),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), runResult(LinkedinProductPreview, CountedPageNumberPaging)),
    annotations: { title: 'Scrape LinkedIn product search', ...SCRAPE },
  },
  {
    ...base,
    name: 'scrape_linkedin_search_schools',
    description:
      'One page of a LinkedIn SCHOOL search, the eighth row kind here: `filters` OR a pasted /search/results/schools/ `url`, exactly one of the two. filters is a REQUIRED keywords and NOTHING else, the same one-member shape the events search has, so every facet the schools screen offers lives only in the url form. There is NO school-id filter: the ids param_id_lookup returns for type=school fit nothing here. Rows are school pages keyed by school_slug (the wire calls it school_id, it is a slug, it can be URL-encoded, and it is not that lookup id), with a tracking-free /school/ URL, name, location line, a students-and-alumni counter and a blurb. Names and slugs survive a non-English executor, but description can silently carry the students line. Page on has_more, never on paging.total.',
    toolClass: 'typical',
    route: rt('search-schools'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      ...requestBase,
      url: searchUrl(PREFIX.schools, OUR_PAGE_WINS),
      filters: SchoolSearchFilters.nullable().optional(),
      page: pageField(OUR_PAGE_WINS),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), runResult(LinkedinSchoolPreview, CountedPageNumberPaging)),
    annotations: { title: 'Scrape LinkedIn school search', ...SCRAPE },
  },
  {
    ...base,
    name: 'scrape_linkedin_similar_profiles',
    description:
      'LinkedIn’s "people also viewed" browsemap for ONE seed profile: lookalike expansion from a known-good persona. IMPORTANT: address by profile.nickname (the vanity slug) ONLY, because the wire navigates by vanityName, so a ln_id/sn_id URN is refused not_dispatchable (resolve it via enrich_linkedin_person_lite_profile first, then pass the nickname). Returns ~20 cards; rows carry ln_member_id + nickname + full_name + headline (no ACoAA id, no avatar, no degree). One-shot list (no pagination); limit caps the cards.',
    toolClass: 'typical',
    route: rt('similar-profiles'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
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
    name: 'scrape_linkedin_search_companies',
    description:
      'One page of a regular LinkedIn company search, addressed EITHER by `filters` (keywords, geo ids, industry ids, headcount buckets) OR by a pasted /search/results/companies/ `url`: exactly one of the two, never both, never neither. Rows are company previews, not people. Same engine and the same company rows either way; page on with paging.has_more. For revenue, growth, follower, Fortune and buying-signal facets use scrape_linkedin_search_sales_nav_companies instead: this engine has none of them.',
    toolClass: 'typical',
    route: rt('search-companies'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      ...requestBase,
      url: searchUrl(PREFIX.companies),
      filters: CompanySearchFilters.nullable().optional(),
      page: pageField(),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), runResult(LinkedinCompanyPreview, PageNumberPaging)),
    annotations: { title: 'Scrape LinkedIn company search', ...SCRAPE },
  },
  {
    ...base,
    name: 'scrape_linkedin_search_sales_nav_companies',
    description:
      'One page of a Sales Navigator ACCOUNT search, the one engine here that filters on annual revenue, company and per-department headcount growth, department headcount, follower buckets, Fortune tier and buying signals (leadership changes, funding events). Addressed EITHER by `filters`, whose typeahead members take ids from scrape_linkedin_sales_nav_param_id_lookup while the static enums are inline, OR by a pasted /sales/search/company `url`: exactly one of the two. SN-capable executor required.',
    toolClass: 'typical',
    route: rt('search-sales-nav-companies'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      ...requestBase,
      url: searchUrl(PREFIX.salesNavCompanies),
      filters: SalesNavCompanySearchFilters.nullable().optional(),
      page: pageField(),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), runResult(LinkedinCompanyPreview, PageNumberPaging)),
    annotations: { title: 'Scrape Sales Navigator company search', ...SCRAPE },
  },
  {
    ...base,
    name: 'scrape_linkedin_similar_companies',
    description:
      `LinkedIn’s "similar companies / pages people also viewed" list for ONE target company: lookalike account expansion. One-shot list.`,
    toolClass: 'typical',
    route: rt('similar-companies'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
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
      `List the people currently working at ONE company (the company page’s "employees" people-search, page-numbered). Heavy, page-numbered list.`,
    toolClass: 'typical',
    route: rt('company-employees'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
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
      `Sales Navigator’s decision-makers panel for ONE company: the bounded, seniority-weighted leadership/buying-committee list SN computes. SN-capable executor required.`,
    toolClass: 'typical',
    route: rt('company-decision-makers'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
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
      'LinkedIn content search: find POSTS by keywords, recency or author. The discovery front door for post-engagement plays (feed the returned post_ln_id into the commenters / reactors / resharers tools). Addressed EITHER by `filters` (keywords REQUIRED) OR by a pasted /search/results/content/ `url`, which the node parses back into the same filter object: exactly one of the two, never both, never neither. CURSOR paginated, unlike every other search here: feed paging.next_cursor back verbatim and size the page with page_size.',
    toolClass: 'typical',
    route: rt('search-posts'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      ...requestBase,
      url: searchUrl(PREFIX.posts),
      filters: PostSearchFilters.nullable().optional(),
      // The one engine on this surface with cursor paging instead of a page
      // number, which is why these two fields are written out here rather than
      // taken from pageField(). Both halves of the XOR page the same way.
      page_size: z.number().int().min(1).max(100).nullable().optional().describe('Rows per page (1..100); default 10.'),
      cursor: z.string().max(2048).nullable().optional().describe('Opaque resume token from paging.next_cursor; null/omitted = first page.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), runResult(LinkedinPostPreview, CursorPaging)),
    annotations: { title: 'Scrape post search', ...SCRAPE },
  },
  {
    ...base,
    name: 'scrape_linkedin_get_post_commenters',
    description:
      'Direct LinkedIn read (bypasses our DB): live pull of who is commenting on ONE post right now. Returns transient commenter objects (member id, nickname, name, headline, comment text, posted_at, reactions_count) annotated with is_own and is_stored / linkedin_comment_sid. Target any post by URL or activity URN in post; tracking is not a thing here any more (the tracked-post entity was retired 2026-08-09). One wire page per call; page on with cursor.',
    toolClass: 'complex',
    route: rt('get-post-commenters'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      ...requestBase,
      post: z.string().max(512).describe('A post URL or an activity URN. Accepted verbatim: `urn:li:activity:<id>`, the feed permalink (`/feed/update/urn:li:activity:<id>/`) and the share link the copy-link button produces (`/posts/<slug>-activity-<id>-<hash>`): all three are parsed locally, at no extra cost. A link with no id in it (a shortlink, a bare slug URL) is resolved by opening the page through get_activity_urn_by_url, which adds one extra page load to this call and is cached 7 days. The post does NOT need to be tracked or owned by you.'),
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
      'Direct LinkedIn read (bypasses our DB): live pull of who is reacting to ONE post right now, as transient reactor objects with normalized reaction_type (MAYBE → like + WARN), annotated with is_own and is_stored / linkedin_engagement_sid. Target any post by URL or activity URN in post. One wire page per call; page on with cursor.',
    toolClass: 'complex',
    route: rt('get-post-reactors'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      ...requestBase,
      post: z.string().max(512).describe('A post URL or an activity URN. Accepted verbatim: `urn:li:activity:<id>`, the feed permalink (`/feed/update/urn:li:activity:<id>/`) and the share link the copy-link button produces (`/posts/<slug>-activity-<id>-<hash>`): all three are parsed locally, at no extra cost. A link with no id in it (a shortlink, a bare slug URL) is resolved by opening the page through get_activity_urn_by_url, which adds one extra page load to this call and is cached 7 days. The post does NOT need to be tracked or owned by you.'),
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
      'Direct LinkedIn read (bypasses our DB): live pull of the profiles that RESHARED one post, the third and typically highest-intent leg of the engagement trio. Same targeting (post URL or activity URN); is_own annotated, no is_stored (reshares have no persisted entity). When exposed, resharer_commentary carries the added text and reshare_urn is the reshare’s own activity URN (feed it back into get-post-commenters / -reactors). One wire page per call; page on with cursor.',
    toolClass: 'complex',
    route: rt('get-post-resharers'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      ...requestBase,
      post: z.string().max(512).describe('A post URL or an activity URN. Accepted verbatim: `urn:li:activity:<id>`, the feed permalink (`/feed/update/urn:li:activity:<id>/`) and the share link the copy-link button produces (`/posts/<slug>-activity-<id>-<hash>`): all three are parsed locally, at no extra cost. A link with no id in it (a shortlink, a bare slug URL) is resolved by opening the page through get_activity_urn_by_url, which adds one extra page load to this call and is cached 7 days. The post does NOT need to be tracked or owned by you.'),
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
    name: 'scrape_linkedin_param_id_lookup',
    description:
      'Facet-id typeahead for the REGULAR (non Sales Navigator) search: turn a human term ("United States", "SaaS", "Acme") into the id a filter member needs. One type per call, and the type picks the member: people → followers_of, connections → connections_of, location → locations, company → current_companies, industry → industries, service_category → service_categories. Rows are the dropdown itself, best match first, about ten of them, with no paging and no size knob. An empty rows list means the dropdown offered nothing for that term, which is an answer, not an error. It types into the account\'s already-open tab, so no page is loaded, no search is spent and the people-search commercial-use limit is untouched. Cheapest method here. Sales Navigator ids are a different space: use scrape_linkedin_sales_nav_param_id_lookup.',
    toolClass: 'trivial',
    route: rt('param-id-lookup'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      ...requestBase,
      type: LookupType,
      query: z.string().min(1).max(100).describe('The human term to resolve. Always required: a typeahead has nothing to offer without typed text, and every one of the nine types is a text box.'),
      // No `limit`. The wire declares three query params (browser_sid, type,
      // query) and LinkedIn answers a fixed short dropdown with no total and no
      // cursor, so there is nothing to size. A limit here would be a knob that
      // reads as if it worked and changed nothing.
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), runResult(LinkedinParamIdPreview, z.null())),
    annotations: { title: 'Look up LinkedIn facet id', ...SCRAPE },
  },
  {
    ...base,
    name: 'scrape_linkedin_sales_nav_param_id_lookup',
    description:
      'Sales Navigator facet-id typeahead: resolve one SN facet (type) into the opaque ids the SN search filters need. type is a node salesApiFacetTypeahead kind passed through verbatim; the seven text facets resolve query, the rest return their fixed / account-scoped list. Type → target filter member: TITLE → current_titles/past_titles; BING_GEO → locations/company_headquarters; INDUSTRY → industries; COMPANY_WITH_LIST → current_companies/past_companies; GROUP → groups; SCHOOL → schools; CONNECTION_OF → connections_of; ACCOUNT_LIST → account_lists (company search). Skip it for the static kinds (COMPANY_SIZE/FUNCTION/SENIORITY_V2/RELATIONSHIP/COMPANY_TYPE/TENURE/PROFILE_LANGUAGE): their full id sets are inlined in the search filter schemas. PERSONA/LEAD_LIST/LEAD_INTERACTIONS/SAVED_LEADS_AND_ACCOUNTS have no filters member yet. SN executor required.',
    toolClass: 'trivial',
    route: rt('sales-nav-param-id-lookup'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
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
