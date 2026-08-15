import type { MountConfig } from '@gtm/mcp-runtime';

// The pluggable tool-surface seam. Each entry is a mounted MCP endpoint built
// from the shared registry. The default budget is 25 tools; a mount may declare
// its own `maxTools` when the product decides that surface is worth more (see
// /mcp/linkedin/messaging below). Full LinkedIn coverage; see PACKAGES.md.
const p = (entity: string) => ({ kind: 'package' as const, id: `mcp.linkedin/${entity}` });
const pid = (entity: string) => ({ kind: 'package' as const, id: `mcp.id/${entity}` });
const por = (entity: string) => ({ kind: 'package' as const, id: `mcp.orchestration/${entity}` });

export const MOUNTS: MountConfig[] = [
  {
    path: '/mcp/linkedin/accounts',
    name: 'gtm-linkedin-accounts',
    instructions:
      'GTM LinkedIn account management & pacing. Find an account sid with search_linkedin_accounts, then call account-scoped tools by sid (checks, self-profile reads, endorse/visit, reset-sync, smart-limits). "NOT SHIPPED YET" tools return not_implemented, so do not retry.',
    selectors: [p('linkedin_accounts'), p('linkedin_account_smart_limits')],
    // 27, not the default 25. The three self-account feeds added on 2026-08-07
    // (profile views, catch-up cards, Sales Navigator alerts) took this mount
    // from 24 to 27, and resolveMounts throws at module scope, so the worker
    // would not boot at 25.
    //
    // NO maxTools: the platform default of 25 applies, and the mount sits exactly
    // on it.
    //
    // This mount carried an UNSIGNED `maxTools: 27` from 2026-08-07, taken when the
    // three self-account feeds (profile views, catch-up cards, Sales Navigator
    // alerts) pushed it from 24 to 27 and resolveMounts, which throws at module
    // scope, would have kept the worker from booting at 25.
    //
    // RESOLVED on 2026-08-09 by REMOVING TOOLS, not by signing the number. The three
    // self-capability probes were one action addressed three ways - same input, same
    // operation, same outputSchema, differing only in which
    // backend path they POSTed to - so they collapsed into a `checks` member on
    // `check_linkedin_account_premium_subscription` (product/KNOWLEDGE.md §4.10), and
    // the `/check-recruiter` and `/check-sales-nav` ROUTES were deleted with them.
    // 27 -> 25, raise gone.
    //
    // 🛑 It beat the two alternatives the earlier note had rejected because it moves
    // nothing between URLs. Splitting the mount, or pushing follow / unfollow to
    // /mcp/linkedin/network, relocates live tools and breaks every mounted client.
    //
    // ⚠️ The first attempt at the merge kept three backend routes and gave the tool a
    // templated `/check-{capability}` path, which `route.pathParams` can fill from an
    // input field at dispatch. Six gates (coverage, contract-parity x2,
    // oracle-freshness, enum-parity, research-parity) key a tool by its LITERAL
    // pathTemplate against the oracle's route list, each with its own copy of
    // `toolKey`, so all six went red. Widening six safety gates to fit one tool was
    // the wrong trade; moving the selection into the BODY of one real route was the
    // right one. Do not re-attempt the templated-path version.
    //
    // The mount is on the default with no headroom bought, so the next tool trips the
    // gate and somebody has to think rather than inherit slack nobody argued for.
    facade: 'none',
  },
  {
    path: '/mcp/linkedin/account-monitor',
    name: 'gtm-linkedin-account-monitor',
    instructions:
      'GTM LinkedIn read-only account health & audit: snapshots, benchmarks, quota hits, block log, activity log, sync runs.',
    selectors: [
      p('linkedin_account_snapshots'),
      p('linkedin_benchmarks'),
      p('linkedin_account_quota_hits'),
      p('linkedin_account_block_log'),
      p('linkedin_account_activity_log'),
      p('linkedin_account_sync_runs'),
    ],
    maxTools: 25,
    facade: 'none',
  },
  {
    path: '/mcp/linkedin/messaging',
    name: 'gtm-linkedin-messaging',
    instructions:
      'GTM LinkedIn conversations & messages: sync the inbox, search history, send messages / voice / InMail / Sales Navigator. Sends are protected (preview → confirm).',
    selectors: [p('linkedin_conversations'), p('linkedin_messages')],
    // 28, not the default 25: the inbox is one job to an LLM (find the thread,
    // read it, answer it), so splitting conversations from messages would make
    // the client mount two URLs to do one thing. Eugene raised the budget for
    // this mount alone on 2026-07-27; every other mount stays at 25.
    maxTools: 28,
    facade: 'none',
  },
  {
    path: '/mcp/linkedin/network',
    name: 'gtm-linkedin-network',
    instructions:
      'GTM LinkedIn network graph: connections, connection requests, invitations, followers. Outward actions (send request, withdraw, accept, ignore, remove) are protected (preview → confirm).',
    selectors: [
      p('linkedin_connections'),
      p('linkedin_connection_requests'),
      p('linkedin_connection_invitations'),
      p('linkedin_followers'),
    ],
    maxTools: 25,
    facade: 'none',
  },
  {
    path: '/mcp/linkedin/content',
    name: 'gtm-linkedin-content',
    instructions:
      'GTM LinkedIn content authoring: publish a post, comment on a post, react to a post, from one of the team accounts. Posts are addressed by activity URN and need no prior tracking. Every verb is protected (preview then confirm). Reading a post and who engaged with it lives on the scraping and enrichment mounts.',
    selectors: [
      p('linkedin_posting'),
    ],
    maxTools: 25,
    facade: 'none',
  },
  {
    path: '/mcp/linkedin/scraping',
    name: 'gtm-linkedin-scraping',
    instructions:
      'GTM LinkedIn scraping of people, companies, posts, job postings, events, groups, LinkedIn Learning courses, products and schools, plus lookalikes, company employees, decision-makers, post engagers and the two facet-id typeaheads. Every search verb is ONE tool per vertical taking either a structured filter object or a pasted LinkedIn search URL, never both; runs land on your own connected accounts. These are run-now, one-page pulls that return the rows inline. For a saved job over the same sources that repeats on a schedule, dedupes across runs and feeds new leads to a mass action, use /mcp/linkedin/auto-scrapes instead (people and companies only: posts, job postings, events, groups, courses, products and schools are not saveable sources).',
    selectors: [p('linkedin_scraping')],
    // NO maxTools, so the platform default of 25 applies again.
    //
    // This mount carried an UNSIGNED `maxTools: 26` from 2026-08-08, taken when
    // the events pair pushed it from 24 to 26 and resolveMounts (which throws at
    // module scope) would have killed the worker at 25. That raise is RESOLVED,
    // and deliberately not by a second raise: on the same day the eight
    // by-url / by-params tool PAIRS collapsed into eight single tools that take
    // `url` XOR `filters`, which is product/KNOWLEDGE.md §4.10 applied to this
    // surface. 26 became 18, groups landed as the ninth vertical, courses as the
    // tenth, products as the eleventh and schools as the twelfth, and the mount
    // now sat at 22 against the default 25, and at 21 since 2026-08-09, when
    // get-post-comments retired into get-post-commenters: the two had ALWAYS
    // dispatched the same node verb (`get-comments`, one page, one paid call), so
    // the comment-side fields moved into the commenters projection instead.
    //
    // 🛑 Schools was the LAST node search vertical we did not mirror, so the queue
    // that justified the free slots is empty. The 3 remaining are headroom for a
    // vertical LinkedIn has not shipped yet, not budget to spend: a new search
    // arrives as ONE tool, the same way the last four did.
    facade: 'none',
  },
  {
    // The saved-scraping surface, deliberately its OWN mount rather than a
    // tenant of /mcp/linkedin/scraping (which is 21/25 and could not hold 13
    // anyway) or of /mcp/linkedin/account-monitor (which has the room and is
    // declared read-only account health, so 8 write verbs do not belong there).
    // All three packages ride together because they are read as one chain, the
    // same reason mass_actions + mass_action_items share a mount. See
    // PACKAGES.md for the full argument.
    path: '/mcp/linkedin/auto-scrapes',
    name: 'gtm-linkedin-auto-scrapes',
    instructions:
      'GTM LinkedIn auto-scrapes: saved, optionally recurring scraping jobs. One auto-scrape pulls a paginated LinkedIn or Sales Navigator list of people or companies on a schedule, dedupes the rows across runs, and hands every NEW lead to a linked mass action. Use this mount when the ask is standing ("every week, everyone who reacted to our launch post"); for a one-page run-now pull with the rows inline in the response, use /mcp/linkedin/scraping instead. Read it as a chain: search_linkedin_auto_scrapes finds the job, search_linkedin_auto_scrape_runs shows what each execution did, search_linkedin_auto_scrape_results lists the deduped leads (filter by first_seen_run_sid for one run\'s fresh delta). The outreach half lives on /mcp/orchestration/mass-actions: author the mass action there first, then attach it here with set_linkedin_auto_scrape_mass_action. Create, update, delete and run-now are protected (preview then confirm).',
    selectors: [
      p('linkedin_auto_scrapes'),
      p('linkedin_auto_scrape_runs'),
      p('linkedin_auto_scrape_results'),
    ],
    maxTools: 25,
    facade: 'none',
  },
  {
    path: '/mcp/linkedin/enrichment',
    name: 'gtm-linkedin-enrichment',
    instructions:
      'GTM LinkedIn profile / company / post enrichment (lite & full profile, experience, skills, education, posts, featured, and more), run on your own connected accounts.',
    selectors: [p('linkedin_enrichment')],
    maxTools: 25,
    facade: 'none',
  },
  {
    path: '/mcp/linkedin/data',
    name: 'gtm-linkedin-data',
    instructions:
      'GTM LinkedIn stored data plane: the data-request ledger. Every scrape or enrichment call lands here as one row, so this is where you audit what ran and re-read a completed result.',
    selectors: [p('data_requests')],
    maxTools: 25,
    facade: 'none',
  },
  {
    path: '/mcp/linkedin/browsers',
    name: 'gtm-linkedin-browsers',
    instructions:
      'GTM LinkedIn antidetect & cloud browser infrastructure: browsers (create / run / stop / delete / access keys), proxies (connectivity & location checks), logs, cloud-browser occupancy & sessions. Create/run/stop/delete are protected (preview → confirm). These verbs are SINGLE-browser. To act on MANY browsers under ONE approval - provision N, or run/stop/delete a set - do not loop the single verbs: author a mass action on /mcp/orchestration/mass-actions (scope generate for "create N", scope objects for run/stop/delete over existing browsers) and monitor the ma_ sid.',
    selectors: [
      p('antidetect_browsers'),
      p('antidetect_browser_proxies'),
      p('antidetect_browser_logs'),
      p('cloud_browsers'),
      p('cloud_browser_sessions'),
    ],
    maxTools: 25,
    facade: 'none',
  },
  {
    path: '/mcp/linkedin/platform',
    name: 'gtm-linkedin-platform',
    instructions:
      'GTM LinkedIn - platform integration: the admin-gated custom-request escape hatch (execute_linkedin_custom_request, one arbitrary own-account HTTP call for endpoints the typed methods do not cover; feature-flagged + host-allowlisted). Protected (preview then confirm). Webhooks moved to /mcp/orchestration/webhooks.',
    selectors: [p('linkedin_custom_requests')],
    maxTools: 25,
    facade: 'none',
  },
  {
    // gtm.service.orchestration owns the platform-wide webhook registry: one
    // subscription set and one delivery log for every producer service, not
    // just LinkedIn. Mass actions are the same service's other half and have
    // their own mount below (see PACKAGES.md).
    path: '/mcp/orchestration/webhooks',
    name: 'gtm-orchestration-webhooks',
    instructions:
      'GTM webhooks - the platform-wide event subscriptions and their delivery log. Register / update / delete / test a webhook, then audit deliveries (search / metrics / retry / cancel). One registry covers every producer service, so filter delivery rows by source_service and account_sid, not by channel. Mutations and test-sends are protected (preview then confirm).',
    selectors: [por('webhooks'), por('webhook_logs')],
    maxTools: 25,
    facade: 'none',
  },
  {
    // The mass-action execution plane: the parent run and its per-target items.
    // Both packages belong on ONE mount because the two are read together - you
    // find the run, then drill into the items that failed inside it.
    path: '/mcp/orchestration/mass-actions',
    name: 'gtm-orchestration-mass-actions',
    instructions:
      'GTM mass actions - bulk execution across every channel. A run holds a plan of up to 3 steps and one item per target. This is the ONE approval path for doing anything to many rows at once: LinkedIn connects and reactions, bulk email, AND the antidetect-browser / account fleet verbs (antidetect-browsers.create [generate scope: "provision N browsers"] / run / stop / delete / generate-cloud-browser-access-key / revoke-cloud-browser-access-key, linkedin-accounts.update-sync-config, linkedin-account-smart-limits.update / reset-hold). Display-field edits and full resync are single-account only (their own tools update_linkedin_account / reset_linkedin_account_sync), not mass steps. Scope is objects (existing rows), targets (payload identities), generate (mint N new rows; step 1 must be a .create verb), or none (a standing run). To START one, always preview_mass_action first: it validates the whole plan, prices it, flags destructive steps, and returns a commit_token that create_mass_action consumes; that one approval covers every item and every step, so pass the token through unchanged. To WATCH one, get_mass_actions_metrics answers "where is it" in a single call (in_flight 0 means it is caught up) and the run status is only active or paused, never an outcome. To STEER one, pause / resume / release_mass_action_canary; delete_mass_action is the stop path. The items are where per-target truth lives, so drill into them with search_mass_action_items (current_step, the object cursor incl. what a generate step minted, and step_log[] per step: what ran, what it minted, what it cost, what it said when it broke). Fix failures with retry_mass_action_items, which resumes each item at its own current_step and never re-runs a completed step. Retry and delete are protected (preview then confirm).',
    selectors: [por('mass_actions'), por('mass_action_items')],
    maxTools: 25,
    facade: 'none',
  },
  {
    path: '/mcp/id/identity',
    name: 'gtm-id-identity',
    instructions:
      'GTM identity: the current user, teams, team members & invitations, and active sessions. Deletes and ownership transfer are protected (preview → confirm).',
    selectors: [pid('users'), pid('teams'), pid('team_members'), pid('sessions')],
    maxTools: 25,
    facade: 'none',
  },
  {
    // The delegated-access surface: who or what may act on this team's behalf,
    // and how the team takes it back. An API key is a machine acting as the
    // team, an OAuth authorization is a third-party app acting for the user, and
    // an account share is another TEAM acting through this team's connected
    // account. All three are granted and revocable, which is why account_shares
    // mounts here rather than on identity (the org roster) or on its own URL.
    path: '/mcp/id/access',
    name: 'gtm-id-access',
    instructions:
      'GTM identity: API keys, OAuth clients & authorizations, and connected-account shares. Secret-minting (create / rotate) and deletes/revokes are protected (preview → confirm); created secrets are shown once. A share lends ONE connected account to another team, revocably: create_account_share issues it, search_account_shares lists what this team lent out, list_received_account_shares lists what it borrowed, and the share ends with recall_account_share (by the owner) or return_account_share (by the holder). Permanent account transfers are deliberately not exposed here.',
    selectors: [pid('api_keys'), pid('oauth_clients'), pid('oauth_authorizations'), pid('account_shares')],
    maxTools: 25,
    facade: 'none',
  },
  {
    path: '/mcp/id/billing',
    name: 'gtm-id-billing',
    instructions:
      'GTM billing: products, subscriptions (checkout / change / add-ons / pause / cancel), transactions & invoices, payment methods. Money-moving actions are protected (preview → confirm).',
    selectors: [
      pid('billing_products'),
      pid('billing_subscriptions'),
      pid('billing_transactions'),
      pid('billing_payment_methods'),
    ],
    maxTools: 25,
    facade: 'none',
  },
  {
    path: '/mcp/id/platform',
    name: 'gtm-id-platform',
    instructions:
      'GTM platform: notifications, SSL certificates (issue / renew / delete), observability request & session lookups, and support escalation (escalate_to_human hands the current issue to the human support team; the team replies to the user\'s account email). Certificate mutations are protected (preview → confirm).',
    selectors: [pid('notifications'), pid('ssl_certificates'), pid('observability_requests'), pid('support_requests')],
    maxTools: 25,
    facade: 'none',
  },
  {
    path: '/mcp/support/knowledge',
    name: 'gtm-support-knowledge',
    instructions:
      'GTM support knowledge base: product help articles and Q&A, served from a bundled index. search_knowledge first (English query, help-article wording; read ALL returned chunks), get_kb_article for a full article. Knowledge only, so pair with platform tools for the user\'s own account state.',
    selectors: [{ kind: 'package', id: 'mcp.support/kb_articles' }],
    maxTools: 25,
    facade: 'none',
  },
  {
    // Unified facade: everything behind 3 meta-tools, for clients that want one
    // URL. list_toolsets → get_toolset_tools → call_tool (same gates/limits).
    path: '/mcp',
    name: 'gtm-mcp',
    instructions:
      'GTM unified MCP endpoint: the whole platform behind 3 meta-tools. Call list_toolsets to see the domains, get_toolset_tools to inspect one, then call_tool to run any tool by name. Dangerous tools still require the preview → confirm step.',
    // All FOUR services, support included. The facade does not route through
    // these selectors: discovery comes from the catalog of domain mounts that
    // index.ts passes in (every non-facade mount, support.knowledge among them)
    // and call_tool resolves against the whole registry, so the KB tools were
    // already callable here while this list said otherwise. What the list does
    // drive is the declared surface: the /health tool count for this path and
    // the number quoted in PACKAGES.md. Listing three services made both
    // under-report by 2. `support` is a ServiceId like any other; that the KB
    // runs on a bundled index instead of a backend service is a dispatch
    // detail (localHandler), not a reason to leave it out of the one endpoint
    // that is supposed to be the whole platform.
    selectors: [
      { kind: 'service', service: 'linkedin' },
      { kind: 'service', service: 'id' },
      { kind: 'service', service: 'orchestration' },
      { kind: 'service', service: 'support' },
    ],
    facade: 'toolsets',
  },
];
