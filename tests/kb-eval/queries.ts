// The KB retrieval golden set: real support questions phrased the way the
// search_knowledge tool description asks for them (English, help-article
// wording), with the docs pages a correct retrieval must surface.
//
// Where queries come from, in order of preference:
//   1. Live agent queries mined from Loki (marked below with their trace):
//        {service="gtm.mcp"} | json | tool="search_knowledge"
//      carries the query on every wide event, copilot and external alike.
//   2. Diagnosed support cases: every "the answer was wrong" investigation
//      that ends in a docs or ranking fix adds its query here, so the fix
//      stays guarded.
//   3. Coverage seeds (the initial set): one or more questions per docs page,
//      written from the page's own headings.
//
// Keep queries verbatim once added - they are regression probes, not prose.
// If retrieval legitimately cannot serve one yet, set `known_gap` with the
// reason instead of deleting it: the suite stays green, the gap stays visible
// in every snapshot until the docs close it.

export interface GoldenQuery {
  /** Stable kebab-case id; snapshots and reports key on it. */
  id: string;
  /** The search_knowledge query: English, help-article wording. */
  query: string;
  /**
   * Retrieval routing: at least ONE of these docs paths must appear among the
   * hits. An entry ending with '/' matches as a prefix (the generated API
   * reference has no stable page list to pin).
   */
  expect_paths: string[];
  /**
   * Facts the returned chunks must mention (case-insensitive substring over
   * all chunks joined). Use sparingly, for load-bearing vocabulary only:
   * chunk boundaries move on every docs deploy.
   */
  must_contain?: string[];
  /** Paths that must NOT appear among the hits (same prefix rule). */
  forbid_paths?: string[];
  /**
   * Documented retrieval gap: the query still runs and lands in the snapshot,
   * but its failures do not fail the suite. The value says why.
   */
  known_gap?: string;
}

export const GOLDEN: GoldenQuery[] = [
  // ---- connect + first sync ----------------------------------------------
  {
    id: 'connect-linkedin-account',
    query: 'connect LinkedIn account antidetect browser',
    expect_paths: ['kb/connect-a-linkedin-account'],
  },
  {
    id: 'connect-fails-checkpoint',
    query: 'LinkedIn connection fails verification checkpoint login',
    expect_paths: ['kb/connect-a-linkedin-account', 'kb/browser-troubleshooting'],
  },
  {
    // Live copilot query, 2026-08-21, trace 92c0e61f-2dd5-4a03-ba7e-7c951efec5c5.
    id: 'verification-smart-limits',
    query: 'LinkedIn account verification status what it means smart limits enabled',
    expect_paths: [
      'kb/connect-a-linkedin-account',
      'kb/smart-limits-and-warmup',
      'kb/account-health',
    ],
  },

  // ---- limits + health ---------------------------------------------------
  {
    // Live copilot query, 2026-08-21, same turn as above.
    id: 'warmup-score-penalties',
    query: 'warmup score account health meaning penalties',
    expect_paths: ['kb/smart-limits-and-warmup', 'kb/account-health'],
  },
  {
    id: 'limit-statuses',
    query: 'smart limit status held what does it mean',
    expect_paths: ['kb/smart-limits-and-warmup'],
  },
  {
    id: 'raise-limit-release-hold',
    query: 'raise a smart limit release a hold',
    expect_paths: ['kb/smart-limits-and-warmup'],
  },
  {
    id: 'account-signed-out',
    query: 'sender signed out of LinkedIn how to log in again',
    expect_paths: ['kb/browser-troubleshooting', 'kb/account-health'],
  },

  // ---- browsers + proxies ------------------------------------------------
  {
    id: 'browser-wont-start',
    query: 'antidetect browser will not start',
    expect_paths: ['kb/browser-troubleshooting'],
  },
  {
    id: 'browser-lifecycle-statuses',
    query: 'cloud browser statuses running stopped suspended',
    expect_paths: [
      'kb/antidetect-browsers-and-proxies',
      'kb/browser-troubleshooting',
      'kb/sync-windows-and-auto-suspend',
    ],
  },
  {
    id: 'proxy-check-failed',
    query: 'proxy connectivity check failed what to do',
    expect_paths: ['kb/proxy-troubleshooting'],
  },
  {
    id: 'byo-proxy',
    query: 'use my own proxy for the browser',
    expect_paths: ['kb/antidetect-browsers-and-proxies', 'kb/proxy-troubleshooting'],
  },

  // ---- inbox + sync cadence ----------------------------------------------
  {
    id: 'messages-not-appearing',
    query: 'message not appearing in inbox sync delay',
    expect_paths: ['kb/inbox-and-message-sync'],
  },
  {
    id: 'force-refresh-conversations',
    query: 'force refresh conversations sync now',
    expect_paths: ['kb/inbox-and-message-sync'],
  },
  {
    id: 'sync-window',
    query: 'sync window schedule when does the account sync',
    expect_paths: ['kb/sync-windows-and-auto-suspend'],
  },
  {
    id: 'auto-suspend-wake',
    query: 'browser auto-suspend and wake',
    expect_paths: ['kb/sync-windows-and-auto-suspend'],
  },

  // ---- billing + workspace -----------------------------------------------
  {
    id: 'free-plan-sandbox',
    query: 'free plan what is included limits',
    expect_paths: ['kb/billing-and-plans'],
    must_contain: ['sandbox'],
  },
  {
    id: 'change-plan',
    query: 'upgrade or change subscription plan',
    expect_paths: ['kb/billing-and-plans'],
  },
  {
    id: 'payment-failed',
    query: 'payment failed subscription status past due',
    expect_paths: ['kb/billing-and-plans'],
  },
  {
    id: 'invite-teammate',
    query: 'invite a teammate to the workspace',
    expect_paths: ['kb/workspaces-and-team-members'],
  },
  {
    id: 'share-account-team',
    query: 'share a connected LinkedIn account with another workspace',
    expect_paths: ['kb/account-sharing-and-handover'],
  },

  // ---- finding + enriching -----------------------------------------------
  {
    id: 'find-email-profile',
    query: 'find email address or phone for a LinkedIn profile',
    expect_paths: ['kb/enrichment'],
  },
  {
    id: 'auto-scrape-recurring',
    query: 'schedule a recurring scrape to collect leads automatically',
    expect_paths: ['kb/auto-scrapes'],
  },
  {
    id: 'search-people-filters',
    query: 'search people with filters Sales Navigator',
    expect_paths: ['kb/people-and-company-search'],
  },

  // ---- guides ------------------------------------------------------------
  {
    id: 'webhooks-receive',
    query: 'receive webhooks subscribe to events verify signature',
    expect_paths: ['guides/receive-webhooks'],
  },
  {
    id: 'mass-action-run',
    query: 'run a mass action preview and commit',
    expect_paths: ['guides/run-a-mass-action'],
  },

  // ---- API concepts + reference ------------------------------------------
  {
    id: 'pagination-cursor',
    query: 'cursor pagination page_size filter operators',
    expect_paths: ['concepts/pagination-and-filtering'],
  },
  {
    id: 'error-envelope-codes',
    query: 'error envelope error codes meaning',
    expect_paths: ['concepts/envelopes-and-errors'],
  },
  {
    id: 'mcp-connect-claude',
    query: 'connect Claude MCP client to the platform',
    expect_paths: ['mcp/connect'],
  },
  {
    id: 'api-authentication',
    query: 'API key authentication bearer token Team-SID header',
    expect_paths: ['authentication'],
  },
  {
    id: 'api-search-accounts-endpoint',
    query: 'search linkedin accounts API endpoint request parameters',
    expect_paths: ['api-reference/', 'kb/antidetect-browsers-and-proxies'],
  },
];
