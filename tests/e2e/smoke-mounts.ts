import { DOMAIN_MOUNT_PATHS, stubOnMount, toolOnMount } from './registry';

// What the live smoke suites drive, in ONE table.
//
// It used to be four tables, one per suite file, and the cost of that showed up
// twice. `/mcp/linkedin/auto-scrapes` shipped with no row at all and the gap sat
// in PACKAGES.md as a written-down follow-up instead of failing anything; and
// `/mcp/support/knowledge` was never smoked either, silently, because no file
// owned the question "is every mount covered". With the rows here, the coverage
// assertion at the bottom of this file is a single expression, it runs at
// COLLECTION time (so on the plain offline `pnpm test`, not only under
// RUN_E2E=1), and a new mount in mounts.config.ts fails the build until it has a
// smoke row.
//
// Every name and every argument object in this table is resolved against the
// live registry as the module loads (toolOnMount / stubOnMount), so a renamed
// tool, a tool that moved mounts, a "stub" that is not a stub any more, or
// arguments that no longer satisfy the tool's own inputSchema all fail
// collection with the reason rather than turning a live test into a weaker one.

export type SmokeMount = {
  /** Mount path, as served. */
  path: string;
  /** `serverInfo.name` the mount answers `initialize` with. */
  name: string;
  /** A read tool to dispatch, when the mount has one. */
  search?: string;
  /** Arguments for `search`. Defaults to a small page. */
  searchArgs?: Record<string, unknown>;
  /** A `stub_501` tool, to prove the in-worker short-circuit. */
  stub?: string;
  /** Arguments for `stub`. Must satisfy the tool's schema (see stubOnMount). */
  stubArgs?: Record<string, unknown>;
};

const DEFAULT_SEARCH_ARGS = { page_size: 3 };

/** Arguments a smoke row actually sends for its search. */
export const searchArgsOf = (m: SmokeMount): Record<string, unknown> =>
  m.searchArgs ?? DEFAULT_SEARCH_ARGS;

/** Arguments a smoke row actually sends for its stub. */
export const stubArgsOf = (m: SmokeMount): Record<string, unknown> => m.stubArgs ?? {};

// The accounts mount has its own suite (accounts.e2e.test.ts) with bespoke
// assertions rather than the generic per-mount ones, so it is listed on its own.
export const ACCOUNTS_MOUNT: SmokeMount = {
  path: '/mcp/linkedin/accounts',
  name: 'gtm-linkedin-accounts',
  search: 'search_linkedin_accounts',
  searchArgs: { page_size: 5 },
  stub: 'get_linkedin_account_my_ssi',
  stubArgs: { sid: 'ln_ac_000000000000' },
};

// The dangerous tool both the accounts suite and the facade suite drive to the
// PREVIEW step (never the commit step). Named once so the two cannot diverge.
export const PREVIEW_SMOKE_TOOL = 'reset_linkedin_account_sync';

export const WAVE1_MOUNTS: SmokeMount[] = [
  { path: '/mcp/linkedin/messaging', name: 'gtm-linkedin-messaging', search: 'search_linkedin_conversations' },
  { path: '/mcp/linkedin/network', name: 'gtm-linkedin-network', search: 'search_linkedin_connections' },
  // The stub, not a GA scrape: the row used to name
  // scrape_linkedin_similar_profiles, which is GA and creditable.
  { path: '/mcp/linkedin/scraping', name: 'gtm-linkedin-scraping', stub: 'scrape_linkedin_get_post_comments' },
  // Same correction: enrich_linkedin_person_contact_info is GA and creditable,
  // and that row was reaching the live backend on every run.
  { path: '/mcp/linkedin/enrichment', name: 'gtm-linkedin-enrichment', stub: 'enrich_linkedin_person_languages' },
];

export const WAVE2_MOUNTS: SmokeMount[] = [
  { path: '/mcp/linkedin/account-monitor', name: 'gtm-linkedin-account-monitor', search: 'search_linkedin_account_snapshots' },
  // content carries no read tool: it is the stateless authoring surface (post /
  // comment / react), so the stub is the whole smoke. create_linkedin_post is
  // also `dangerous`, which makes it the best stub in the table: the gate has to
  // beat the preview gate, so a pass here proves no commit token was minted and
  // no KV write happened either.
  {
    path: '/mcp/linkedin/content',
    name: 'gtm-linkedin-content',
    stub: 'create_linkedin_post',
    stubArgs: { linkedin_account_sid: 'ln_ac_000000000000', text: 'e2e stub probe, never sent' },
  },
  { path: '/mcp/linkedin/auto-scrapes', name: 'gtm-linkedin-auto-scrapes', search: 'search_linkedin_auto_scrapes' },
  { path: '/mcp/linkedin/browsers', name: 'gtm-linkedin-browsers', search: 'search_antidetect_browsers' },
  { path: '/mcp/linkedin/data', name: 'gtm-linkedin-data', search: 'search_data_requests' },
  // platform is down to the single custom-request escape hatch (dangerous, so
  // no read smoke here); the webhook surface moved to gtm.service.orchestration
  // and is smoke-checked on its own mount below.
  { path: '/mcp/linkedin/platform', name: 'gtm-linkedin-platform' },
  { path: '/mcp/orchestration/webhooks', name: 'gtm-orchestration-webhooks', search: 'search_webhooks' },
  // The mass-action plane: the parent tools and the item tools on one mount. The
  // read smoke goes through the parent search, since that is the entry point an
  // agent uses before it drills into items.
  { path: '/mcp/orchestration/mass-actions', name: 'gtm-orchestration-mass-actions', search: 'search_mass_actions' },
  // The KB runs on a bundled index behind a localHandler, so this row proves
  // something none of the others do: that the mount serves without any backend
  // hop. Its search takes a query, not a page.
  {
    path: '/mcp/support/knowledge',
    name: 'gtm-support-knowledge',
    search: 'search_knowledge',
    searchArgs: { query: 'connect linkedin account' },
  },
];

export const ID_MOUNTS: SmokeMount[] = [
  { path: '/mcp/id/identity', name: 'gtm-id-identity', search: 'search_teams' },
  { path: '/mcp/id/access', name: 'gtm-id-access', search: 'search_api_keys' },
  { path: '/mcp/id/billing', name: 'gtm-id-billing', search: 'search_billing_products' },
  { path: '/mcp/id/credits', name: 'gtm-id-credits', search: 'search_credit_transactions' },
  { path: '/mcp/id/platform', name: 'gtm-id-platform', search: 'search_notifications' },
];

export const ALL_SMOKE_MOUNTS: SmokeMount[] = [
  ACCOUNTS_MOUNT,
  ...WAVE1_MOUNTS,
  ...WAVE2_MOUNTS,
  ...ID_MOUNTS,
];

/** Every tool name the smoke suites call, for the coverage report. */
export const SMOKE_CALLED_TOOLS: string[] = [
  ...new Set([
    ...ALL_SMOKE_MOUNTS.flatMap((m) => [m.search, m.stub].filter((n): n is string => !!n)),
    PREVIEW_SMOKE_TOOL,
  ]),
].sort();

// ---- collection-time guards -------------------------------------------------

for (const m of ALL_SMOKE_MOUNTS) {
  if (m.search) toolOnMount(m.path, m.search);
  if (m.stub) stubOnMount(m.path, m.stub, stubArgsOf(m));
}

const smoked = new Set(ALL_SMOKE_MOUNTS.map((m) => m.path));
const unsmoked = DOMAIN_MOUNT_PATHS.filter((p) => !smoked.has(p));
if (unsmoked.length) {
  throw new Error(
    `e2e: ${unsmoked.length} domain mount(s) have no live smoke row: ${unsmoked.join(', ')}. ` +
      'Every mount in apps/worker/src/mounts.config.ts needs one here, otherwise it ships without a single live call ever having been made against it. ' +
      'Add a row (a read tool if the mount has one, a stub_501 tool if it does not, and the path alone if it has neither).',
  );
}

const unknown = [...smoked].filter((p) => !DOMAIN_MOUNT_PATHS.includes(p));
if (unknown.length) {
  throw new Error(
    `e2e: smoke row(s) for ${unknown.join(', ')}, which the worker does not serve as a domain mount. ` +
      `Live domain mounts: ${DOMAIN_MOUNT_PATHS.join(', ')}.`,
  );
}
