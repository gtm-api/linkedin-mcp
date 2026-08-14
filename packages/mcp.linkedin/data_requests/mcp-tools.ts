// Entity: Data Request (gtm.service.linkedin)
// Source of truth: product/research/gtm.service.linkedin/entities/data_requests.md
// Format: registry v2, where each tool carries route metadata so the generic
// dispatcher can drive it. 2 tools (the data-requests route group): the
// READ-ONLY surface over the credit-metered scraping/enrichment ledger. There
// is NO public create: rows are born implicitly inside the two §9.6 surface
// controllers (linkedin-scraping / linkedin-enrichment). Mounted on
// linkedin.data alongside linkedin-searches / linkedin-search-results.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  AccessIdentityValueActorTypeEnum,
  filterOp,
  McpGetRequestSchema,
  McpGetResponse,
  McpSearchRequestSchema,
  McpSearchResponse,
} from '@gtm/mcp-shared';

// Ledger row sid prefix: the legacy `er_rq_` is kept deliberately (billing
// references it as CreditTransaction.referenceSid); see research Decisions.
// Backend GET restricts include.* to exactly these two relations.
const DataRequestInclude = z.enum(['linkedin_account', 'cached_from']);

// Bound to {sid} via the get tool's McpGetRequestSchema('er_rq_').

const DataRequestKind = z.enum(['enrich', 'scrape']);
const DataRequestStatus = z.enum(['pending', 'running', 'completed', 'rejected', 'failed']);
const DataRequestExecutedOn = z.enum(['own_account', 'infra_pool']);

// One value per owned scraping/enrichment method, the whole matrix.
const DataRequestMethod = z.enum([
  // enrich (22)
  'person_lite_profile', 'person_basic_profile', 'person_full_profile', 'person_experience',
  'person_skills', 'person_education', 'person_posts', 'person_featured',
  'person_contact_info', 'person_languages', 'person_certifications',
  'person_recommendations', 'person_comment_activity', 'person_reaction_activity',
  'person_interests', 'person_services',
  'company_profile', 'company_lite_profile', 'company_public_identifier', 'company_posts',
  'post_details',
  // ⚠️ Sits with the enrich values because that is its `kind()`, not because it
  // reads a person: it resolves one post URL into an activity urn, which is a
  // cached single-object lookup rather than a live list. It was grouped under
  // the scrape comment until 2026-08-09, which is why the two block counts
  // disagreed with the PHP enum by one in each direction while set equality -
  // the only thing enum-parity checks - stayed green.
  'get_activity_urn_by_url',
  // scrape (33)
  //
  // 🛑 STILL TWO CASES PER SEARCH VERTICAL, on purpose. The public surface
  // merged each by-url / by-params PAIR into one route and one tool on
  // 2026-08-08 (`url` XOR `filters`), and the ledger deliberately did NOT
  // follow: the controller picks the …ByUrl or the …ByParams case from which
  // field the caller filled, so a row still records which wire verb ran, the
  // activity log still distinguishes them, and every stored
  // linkedin_auto_scrapes.source_method value still resolves. This list mirrors
  // the PHP DataRequestMethodEnum case for case (enum-parity asserts set
  // equality in BOTH directions), so it tracks the ledger taxonomy and never
  // the route list, which is now strictly coarser.
  'search_people_by_url', 'search_people_by_params',
  'search_sales_nav_people_by_url', 'search_sales_nav_people_by_params',
  'search_service_providers', 'search_service_providers_by_url', 'similar_profiles',
  // The jobs, events and groups verticals, whose rows are job postings, events
  // and groups rather than people or companies: the ledger records the call the
  // same way regardless of what came back.
  'search_jobs', 'search_jobs_by_url',
  'search_events', 'search_events_by_url',
  'search_groups', 'search_groups_by_url',
  // LinkedIn LEARNING, landed 2026-08-08, and the taxonomy says `courses` while
  // the screen it opens is `/search/results/learning/`. Rows are catalogue
  // courses keyed by a slug, a sixth kind after person, company, job posting,
  // event and group, and the ledger still records only which verb ran.
  'search_courses', 'search_courses_by_url',
  // The products catalogue, landed 2026-08-09. A seventh row kind, keyed by a
  // slug like courses - the wire calls that field `product_id`, the projected
  // row calls it `product_slug`, and the difference matters because this is the
  // one search whose FILTERS carry real numeric ids.
  'search_products', 'search_products_by_url',
  // Schools, landed 2026-08-09 and the last node vertical to be mirrored. An
  // eighth row kind, keyed by a slug like courses and products - the wire calls
  // that field `school_id`, the projected row calls it `school_slug`, because
  // param-id-lookup has a `school` type returning REAL school ids that this
  // engine cannot take.
  'search_schools', 'search_schools_by_url',
  'search_companies_by_url', 'search_companies_by_params',
  'search_sales_nav_companies_by_url', 'search_sales_nav_companies_by_params',
  'similar_companies', 'company_employees', 'company_decision_makers',
  'search_posts', 'search_posts_by_url', 'get_post_commenters', 'get_post_reactors',
  'get_post_resharers', 'search_param_id_lookup',
  'search_sales_nav_param_id_lookup',
]);

// Item projection: every field of DataRequestDomain (research §Domain). Base
// scalar columns are always serialized (present keys; only nullable when the
// Domain type is `| null`); any forward-compat keys are kept valid by the
// trailing .passthrough().
const DataRequest = z.object({
  sid: z.string(),
  team_sid: z.string(),
  linkedin_account_sid: z.string().nullable(),

  // Classification
  kind: DataRequestKind,
  method: DataRequestMethod,
  status: DataRequestStatus,

  // Input (as supplied by the surface call)
  input_kind: z.enum(['ln_id', 'sn_id', 'nickname', 'ln_member_id', 'url', 'activity_urn', 'params', 'domain']),
  input_value: z.string(),

  // Resolved person identity (NULL on scrape / company- / post-addressed methods)
  ln_member_id: z.string().nullable(),
  ln_id: z.string().nullable(),
  sn_id: z.string().nullable(),
  nickname: z.string().nullable(),

  // Execution & billing
  executed_on: DataRequestExecutedOn.nullable(),
  charged: z.number(),
  charge_reason: z.enum(['infra_pool', 'limit_fallback']).nullable(),
  served_from_cache: z.boolean(),
  cached_from_sid: z.string().nullable(),
  idempotency_key: z.string().nullable(),
  // Polymorphic result reference: a string pointer OR the inline result payload
  // (object/array) depending on the request kind.
  result_ref: z.union([z.string(), z.record(z.unknown()), z.array(z.unknown())]).nullable(),
  error_code: z.string().nullable(),

  // Audit: AccessIdentityValue (general/KNOWLEDGE.md "Authorization model").
  // Backend Domain permits created_by=null (default null, not re-validated NOT
  // NULL) so the whole object is nullable.
  created_by: z.object({
    actor_type: AccessIdentityValueActorTypeEnum,
    actor_sid: z.string(),
    team_sid: z.string(),
    permissions: z.record(z.unknown()),
    // AccessIdentityValue optional sub-field: W3C trace id of the minting request.
    trace_id: z.string().nullable().optional(),
    reason: z.string().nullable(),
  }).passthrough().nullable(),

  // Timestamps
  created_at: z.string(),
  updated_at: z.string(),
  completed_at: z.string().nullable(),
}).passthrough();

const DataRequestFilter = z.object({
  sid: filterOp(z.string(), ['eq', 'in']).optional(),
  kind: filterOp(DataRequestKind, ['eq', 'in']).optional(),
  method: filterOp(DataRequestMethod, ['eq', 'in', 'nin']).optional(),
  status: filterOp(DataRequestStatus, ['eq', 'ne', 'in', 'nin']).optional(),
  executed_on: filterOp(DataRequestExecutedOn, ['eq', 'in', 'is_null']).optional()
    .describe('is_null:true ⇒ never dispatched (rejected / cache-served).'),
  served_from_cache: filterOp(z.boolean(), ['eq']).optional(),
  charged: filterOp(z.number().int(), ['eq', 'gt', 'gte', 'lt', 'lte']).optional()
    .describe('gt:0 ⇒ rows we actually paid for.'),
  ln_member_id: filterOp(z.string(), ['eq', 'in', 'is_null']).optional()
    .describe('Canonical person axis; ln_id/sn_id inputs normalize to this.'),
  created_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  idempotency_key: filterOp(z.string(), ['eq']).optional()
    .describe('Exact-match retry-replay lookup.'),
}).partial();

const DataRequestSortable = z.enum(['created_at', 'completed_at', 'charged']);

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const base = {
  service: 'linkedin',
  entity: 'data_requests',
  mount: 'linkedin.data',
} as const;

export const dataRequestsTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_data_requests',
    description:
      'List/filter the credit-metered request history: what was asked, where it ran, what it cost, what came from cache. The go-to tool for spend audits (charged:{gt:0}), retry forensics (idempotency_key:{eq}), per-person request history (ln_member_id:{eq}) and mid-flight visibility (status:{in:["pending","running"]}). This is a read-only ledger. To RUN scraping/enrichment call the linkedin-scraping / linkedin-enrichment surfaces instead.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/data-requests/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: McpSearchRequestSchema(DataRequestFilter, undefined, DataRequestSortable, 200)
      // The SearchRequest declares no include rule and the controller builds no
      // included block, so advertising the param would be a silent no-op.
      .omit({ include: true }),
    outputSchema: McpSearchResponse(DataRequest),
    annotations: { title: 'Search data requests', ...RO },
  },
  {
    ...base,
    name: 'get_data_request',
    description:
      'Fetch a single ledger row by sid to inspect one request referenced from a surface response\'s credits block, a data-requests.* webhook, or another row\'s cached_from_sid pointer.',
    toolClass: 'trivial',
    route: { service: 'linkedin', method: 'GET', pathTemplate: '/api/data-requests/{sid}', sidParam: 'sid' },
    operation: 'get',
    envelope: 'get',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: McpGetRequestSchema('er_rq_', DataRequestInclude),
    outputSchema: McpGetResponse(DataRequest),
    annotations: { title: 'Get data request', ...RO },
  },
];
