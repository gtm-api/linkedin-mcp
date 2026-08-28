// Entity: Antidetect Browser (gtm.service.linkedin)
// Source of truth: product/research/gtm.service.linkedin/entities/antidetect_browsers.md
// Format: registry v2, where each tool carries route metadata so the generic
// dispatcher can drive it. 12 tools (the antidetect-browsers route group),
// mounted on linkedin.browsers alongside proxies / logs / cloud-browsers /
// cloud-browser-sessions.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  HandoverRoleEnum,
  filterOp,
  usageMetaField,
  AccessIdentityValue,
  McpActionResponse,
  McpCreateResponse,
  McpCascadeDeleteResponse,
  McpCascadeDeleteRequestSchema,
  McpGetRequestSchema,
  McpGetResponse,
  McpSearchRequestSchema,
  McpSearchResponse,
} from '@gtm/mcp-shared';

const SID = z.string().length(18).startsWith('ab_br_')
  .describe('Antidetect browser sid (ab_br_…).');
const PROXY_SID = z.string().length(18).startsWith('ab_px_')
  .describe('Antidetect browser proxy sid (ab_px_…).');
const ACCESS_KEY = z.string().length(18).startsWith('cb_ak_')
  .describe('Cloud-browser access key (cb_ak_…).');

// One entry in the browser's `cloud_browser_access` array: a minted smart-link key
// plus the envelope validated at connect. Declared once because `search` returns the
// whole array and `generate_cloud_browser_access_key` returns a single fresh entry.
// There is no connect counter on it: `max_connects` is checked against LIVE
// cloud-browser sessions, and a stored counter that no writer maintained was deleted
// on 2026-08-27 after every reader of it had seen 0 forever.
const CloudBrowserAccessEntry = z.object({
  key: ACCESS_KEY
    .describe('The bearer token itself. Readable in full here, and only here: on cloud-browser-sessions it is masked to the last 4.'),
  expires_at: z.string().nullable()
    .describe('ISO 8601 expiry; null means it never expires. Checked at connect and never again, so a session can outlive its own key.'),
  max_connects: z.number().nullable()
    .describe('Cap on CONCURRENT sessions on this key; null means unlimited.'),
  allowed_ips: z.array(z.string()).nullable(),
  allowed_countries: z.array(z.string()).nullable(),
  purpose: z.enum(['relogin', 'share']).optional()
    .describe('What the public page behind the link does. Stamped at mint and never re-negotiated at connect, because the visitor is unauthenticated. Absent on keys minted before the field existed, which the backend reads as relogin.'),
});

// Owner + vendor enums mirror the create FormRequest (only `gologin` is wired).
const BrowserOwner = z.enum(['platform', 'customer', 'mirror_profiles']);
const VendorProvider = z.enum(['gologin', 'multilogin', 'adspower', 'dolphin']);

// AntidetectBrowserStatusEnum, in its PHP order. Named once and reused by the
// item projection and the status filter so the two cannot drift apart.
const AntidetectBrowserStatus = z.enum([
  'stopped', 'queued_to_start', 'initializing', 'running', 'idle',
  'queued_to_stop', 'start_issue', 'running_issue', 'login_issue',
  'error_investigation', 'maintenance', 'shared_out', 'subscription_required',
]);

// Customer bring-your-own proxy tuple. Allowed on any browser whose vendor
// profile WE minted (browser_owner=platform included: our profile, their proxy);
// forbidden on a profile bound by id, whose proxy lives in the customer's own
// vendor account. Both write paths PROBE the tuple first and refuse an
// unreachable one (422 custom_proxy_unreachable_*), and the probe's exit country
// is what lands in proxy_country_code: the blob itself states no geo.
const CustomProxyConfig = z.object({
  ip: z.string().describe('Proxy host.'),
  port: z.number().int().min(1).max(65535),
  username: z.string().optional(),
  password: z.string().optional(),
  mode: z.enum(['http', 'socks4', 'socks5']).optional().describe('Default http.'),
}).describe('Custom proxy connection tuple (customer BYO path). Probed before it is written; 5G Proxy cannot ride it.');

// envelope.result of update-proxy / replace-proxy. `restarted` is the field that matters to
// an agent: the swap powers a live browser off and back on, so a sender that was running is
// briefly down, and `restart_error` means it did not come back and needs an explicit run.
const ProxySwapResult = z.object({
  previous_antidetect_browser_proxy_sid: z.string().nullable()
    .describe('The pooled proxy the browser was on before the swap, or null if it had none.'),
  restarted: z.boolean().describe('True when the browser was running and was started again on the new proxy.'),
  restart_error: z.string().nullable().describe('Set when the swap committed but the browser could not be restarted.'),
}).passthrough();

// Tight item projection: every AntidetectBrowserDomain field (research §Domain),
// correct type + nullability. passthrough tolerates future additions.
// custom_proxy_config is deliberately ABSENT: it is a persistence-only column
// (backend SERVICE_CONVENTIONS §M2) because it carries a plaintext password, so
// it rides no Domain and no read path serializes it: not search, not get, not
// an Include, not even the create envelope that just accepted it on input.
// Credentials on the bound-profile path are all NULL.
const AntidetectBrowser = z.object({
  sid: z.string(),
  team_sid: z.string(),
  // Lifecycle linkage
  linkedin_account_sid: z.string().nullable(),
  automation_server_sid: z.string().nullable(),
  // Sharing linkage (AntidetectBrowserDomain, sharing rework). Non-null only
  // while the browser is inside a share; share_role says which side of it this
  // row is, which is what tells a `shared_out` browser apart from a borrowed one.
  account_share_sid: z.string().nullable(),
  share_role: HandoverRoleEnum.nullable(),
  // Identity / ownership
  vendor_provider: VendorProvider,
  vendor_name: z.string().nullable(),
  vendor_profile_id: z.string().nullable(),
  browser_owner: BrowserOwner,
  // Operational state: AntidetectBrowserStatusEnum, all 13 cases. The last two
  // came with the sharing rework and are not operational states at all: a
  // browser parked for a share reads shared_out, and one whose team lost its
  // plan reads subscription_required. Both are terminal for automation, so an
  // agent that cannot parse them mis-reads a parked browser as a live one.
  status: AntidetectBrowserStatus,
  error_reason: z.string().nullable(),
  fail_count: z.number(),
  last_fail_at: z.string().nullable(),
  logout_count: z.number(),
  last_logout_at: z.string().nullable(),
  last_start_at: z.string().nullable(),
  last_health_check_at: z.string().nullable(),
  last_activity_at: z.string().nullable(),
  // Proxy assignment (XOR: exactly one populated on managed browsers)
  antidetect_browser_proxy_sid: z.string().nullable(),
  proxy_country_code: z.string().nullable(),
  // The password-free half of a BYO upstream, derived from the persistence-only
  // column. Non-null is how a reader tells "routed through the proxy the customer
  // supplied" from "on our managed pool" (antidetect_browser_proxy_sid set) and
  // from "external profile, proxy set in the vendor" (browser_owner=customer).
  // exit_ip / latency_ms are what the probe measured when the proxy was attached,
  // not a live reading: nothing re-probes an upstream that is not ours.
  custom_proxy: z.object({
    ip: z.string(),
    port: z.number().int(),
    mode: z.string(),
    username: z.string().nullable(),
    exit_ip: z.string().nullable(),
    latency_ms: z.number().int().nullable(),
  }).nullable(),
  proxy_5g: z.boolean()
    .describe('5G Proxy add-on: the browser runs on the dedicated 5G mobile route (faster command execution, fewer retries). Each flagged browser occupies one add-on slot.'),
  // Cloud-browser access
  cloud_browser_access: z.array(CloudBrowserAccessEntry)
    .describe('The smart links minted on this browser, keys included in full. Each console open used to leave a throwaway entry here; minting now sweeps entries that expired over 24h ago, so this is the live link list rather than a log.'),
  // Audit
  created_by: AccessIdentityValue,
  deleted_by: AccessIdentityValue.nullable(),
  // Timestamps
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
}).passthrough();

// Counts block: concrete shape from research (search per-tool block).
const AntidetectBrowserCounts = z.object({
  total_count: z.number(),
  groups: z.record(z.unknown()), // dynamic breakdown, object even when empty
}).passthrough();

const AntidetectBrowserFilter = z.object({
  sid: filterOp(z.string(), ['eq', 'in']).optional(),
  status: filterOp(z.string(), ['eq', 'ne', 'in', 'nin']).optional(),
  browser_owner: filterOp(z.string(), ['eq', 'ne', 'in', 'nin']).optional(),
  vendor_provider: filterOp(z.string(), ['eq', 'ne', 'in', 'nin']).optional(),
  vendor_name: filterOp(z.string(), ['eq', 'in']).optional()
    .describe('Vendor profile display name (the supported name lookup path).'),
  vendor_profile_id: filterOp(z.string(), ['eq', 'in', 'is_null']).optional(),
  linkedin_account_sid: filterOp(z.string(), ['eq', 'in', 'is_null']).optional(),
  automation_server_sid: filterOp(z.string(), ['eq', 'in', 'is_null']).optional()
    .describe('is_null:true = ops scan for browsers not assigned to a server.'),
  antidetect_browser_proxy_sid: filterOp(z.string(), ['eq', 'in', 'is_null']).optional(),
  proxy_country_code: filterOp(z.string(), ['eq', 'in']).optional(),
  proxy_5g: filterOp(z.boolean(), ['eq']).optional()
    .describe('eq:true = the browsers occupying a 5G Proxy add-on slot (that is how slot usage is counted).'),
  fail_count: filterOp(z.number().int(), ['eq', 'gte', 'lte', 'gt', 'lt']).optional(),
  logout_count: filterOp(z.number().int(), ['eq', 'gte', 'lte', 'gt', 'lt']).optional(),
  last_start_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(),
  last_fail_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(),
  last_logout_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(),
  created_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  updated_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  deleted_at: filterOp(z.string(), ['is_null', 'gte', 'lte']).optional()
    .describe('Default scope is { is_null: true } (live browsers).'),
}).partial();

const AntidetectBrowserInclude = z.enum([
  'linkedin_account',
  'antidetect_browser_proxy',
  'antidetect_browser_logs',
]);

const AntidetectBrowserSortable = z.enum([
  'created_at', 'updated_at', 'last_start_at', 'last_fail_at',
  'last_logout_at', 'fail_count', 'logout_count', 'vendor_name',
]);

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const ACT = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DANGER = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

const base = {
  service: 'linkedin',
  entity: 'antidetect_browsers',
  mount: 'linkedin.browsers',
} as const;

export const antidetectBrowsersTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_antidetect_browsers',
    description:
      'List antidetect browsers on the team with filters (name lookup via the vendor_name filter, eq/in), sorting and cursor pagination. Live browsers by default (deleted_at.is_null:true). Returns a counts block of predicate tallies; include[] can eager-load linkedin_account, antidetect_browser_proxy and antidetect_browser_logs. Use this to find a browser sid before run / stop / delete.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/antidetect-browsers/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    inputSchema: McpSearchRequestSchema(AntidetectBrowserFilter, AntidetectBrowserInclude, AntidetectBrowserSortable),
    outputSchema: McpSearchResponse(AntidetectBrowser, undefined, AntidetectBrowserCounts),
    annotations: { title: 'Search antidetect browsers', ...RO },
  },
  {
    ...base,
    name: 'get_antidetect_browser',
    description: 'Fetch a single antidetect browser by sid, with optional eager-loaded relations.',
    toolClass: 'trivial',
    route: { service: 'linkedin', method: 'GET', pathTemplate: '/api/antidetect-browsers/{sid}', sidParam: 'sid' },
    operation: 'get',
    envelope: 'get',
    availability: 'ga',
    dangerous: false,
    inputSchema: McpGetRequestSchema('ab_br_', AntidetectBrowserInclude),
    outputSchema: McpGetResponse(AntidetectBrowser),
    annotations: { title: 'Get antidetect browser', ...RO },
  },
  {
    ...base,
    name: 'list_antidetect_browser_proxy_countries',
    description:
      'Proxy countries a new browser can be given right now, with how many active proxies back each. Empty list = the pool is dry; create refuses a country with no stock (422 proxy_pool_empty).',
    toolClass: 'trivial',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/antidetect-browsers/proxy-countries' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    // No body: the answer is the state of the MANAGED pool, not of any one row.
    inputSchema: z.object({ ...usageMetaField }),
    outputSchema: McpActionResponse(z.null(), z.object({
      countries: z.array(z.object({
        country_code: z.string().describe('ISO-3166-1 alpha-2, lowercase.'),
        available: z.number().int().nonnegative().describe('Active proxies stocked in that country.'),
      })).describe('Sorted by country_code; pass one of these as create\'s proxy_country_code.'),
    })),
    annotations: { title: 'List proxy countries', ...RO },
  },
  {
    ...base,
    name: 'check_antidetect_browser_proxy',
    description:
      'Probe a customer-supplied proxy tuple and report the exit it reaches: country, IP and round-trip latency. Nothing is written, and no browser is named: call it for a proxy you are about to pass as custom_proxy_config, on create or on update-proxy. A proxy that refuses is a SUCCESSFUL call with ok:false plus error_kind (timeout | tls | network | http_error); only a malformed tuple is a 422. The write paths run the same probe themselves, so this verb is for showing the operator what a tuple resolves to BEFORE committing to it.',
    toolClass: 'trivial',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/antidetect-browsers/check-proxy' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      ip: z.string().describe('Proxy host.'),
      port: z.number().int().min(1).max(65535),
      mode: z.enum(['http', 'socks4', 'socks5']).optional().describe('Default http.'),
      username: z.string().nullable().optional(),
      password: z.string().nullable().optional(),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), z.object({
      ok: z.boolean().describe('True when the request was routed through the proxy.'),
      error_kind: z.string().nullable().describe('Why it failed: timeout | tls | network | http_error. Null on success.'),
      exit_ip: z.string().nullable().describe('The address the probe target saw. Null when the target answered nothing parseable.'),
      country_code: z.string().nullable().describe('ISO-3166-1 alpha-2 exit country; this is what create / update-proxy store on the browser.'),
      latency_ms: z.number().int().nullable().describe('Round-trip time of the probe.'),
    })),
    annotations: { title: 'Check custom proxy', ...RO },
  },
  {
    ...base,
    name: 'get_antidetect_browser_seat_usage',
    description:
      'Seats and 5G proxy slots the workspace occupies: every live browser row, whatever its status and whether a LinkedIn account is bound. Team-wide; compare against limits.accounts and limits.proxy_5g.',
    toolClass: 'trivial',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/antidetect-browsers/seat-usage' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    // No body: the question is about the workspace, not about any one row. Unlike
    // search, the answer is NOT narrowed by the caller's allowed_account_sids slice
    // - a capacity number may only be scoped by the team, which is why counting a
    // search instead showed a sliced teammate a full workspace as empty.
    inputSchema: z.object({ ...usageMetaField }),
    outputSchema: McpActionResponse(z.null(), z.object({
      accounts_used: z.number().int().nonnegative()
        .describe('Live browser rows the team holds. This is the count the create gate refuses on (402 insufficient_slots).'),
      proxy_5g_used: z.number().int().nonnegative()
        .describe('Of those, the ones carrying the 5G Proxy add-on.'),
    })),
    annotations: { title: 'Get seat usage', ...RO },
  },
  {
    ...base,
    name: 'create_antidetect_browser',
    description:
      'Provision ONE antidetect browser for the team. The main flow mints a fresh vendor (GoLogin) profile and pushes the resolved proxy into it, so supply exactly one proxy source: proxy_country_code is the default, custom_proxy_config routes that minted profile through a proxy the caller supplies (probed first, 422 custom_proxy_unreachable_* when dead, never with proxy_5g). Pick the branch yourself, never ask an end user for a sid. Bind an existing vendor_profile_id for the BYO-PROFILE path instead, with no proxy source: that profile carries its own. DANGEROUS: creates real vendor + proxy infrastructure. For SEVERAL browsers under ONE approval, do not call this per browser: author a mass action on /mcp/orchestration/mass-actions with scope {kind:"generate", count:N} and a plan of antidetect-browsers.create (+ antidetect-browsers.generate-cloud-browser-access-key), then read the connect links off each row when it finishes.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/antidetect-browsers' },
    operation: 'create',
    envelope: 'create',
    availability: 'ga',
    dangerous: true,
    inputSchema: z.object({
      browser_owner: BrowserOwner.optional()
        .describe('Omit to infer: vendor_profile_id present ⇒ customer, absent ⇒ platform.'),
      vendor_provider: VendorProvider.optional().describe('Default gologin (the only wired vendor).'),
      vendor_profile_id: z.string().max(128).nullable().optional()
        .describe('Bind an EXISTING vendor profile (BYO). Omit to mint a fresh one.'),
      os: z.enum(['win', 'mac', 'lin', 'android']).optional().describe('OS for a freshly-minted profile (default win).'),
      antidetect_browser_proxy_sid: PROXY_SID.optional()
        .describe('Assign an already-chosen pooled proxy. Resolve the sid yourself with search_antidetect_browser_proxies; never ask an end user for one.'),
      proxy_country_code: z.string().length(2).optional().describe('ISO country. Picks the least-loaded active proxy. The default way to pick a proxy.'),
      custom_proxy_config: CustomProxyConfig.optional(),
      proxy_5g: z.boolean().optional()
        .describe('Provision the browser on the 5G Proxy add-on: the dedicated 5G mobile route, sold for speed (faster command execution, fewer retries). Each flagged browser takes one add-on slot; with no headroom left the create is refused 402 insufficient_proxy_5g_slots.'),
      ...usageMetaField,
    }),
    outputSchema: McpCreateResponse(AntidetectBrowser),
    annotations: { title: 'Create antidetect browser', ...DANGER },
  },
  {
    ...base,
    name: 'run_antidetect_browser',
    description:
      'Start an antidetect browser session by sid. Two-phase: transitions to queued_to_start, dispatches to an automation server, then settles into initializing / running / start_issue. Identify the browser by its ab_br_ sid in the body.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/antidetect-browsers/run' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: SID, ...usageMetaField }),
    outputSchema: McpActionResponse(AntidetectBrowser),
    annotations: { title: 'Run antidetect browser', ...DANGER },
  },
  {
    ...base,
    name: 'stop_antidetect_browser',
    description:
      'Stop an antidetect browser session by sid. Default is graceful (queued_to_stop → stopped on the node teardown confirmation); now:true commits stopped immediately and dispatches a best-effort teardown. Identify the browser by its ab_br_ sid in the body.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/antidetect-browsers/stop' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID,
      now: z.boolean().optional().describe('Emergency stop: commit stopped immediately.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(AntidetectBrowser),
    annotations: { title: 'Stop antidetect browser', ...DANGER },
  },
  {
    ...base,
    name: 'generate_cloud_browser_access_key',
    description:
      'Mint a cloud-browser access key (smart-link) on a browser. Returns the whole minted entry in result.access_key, whose `key` field is the raw cb_ak_ token (shown once), AND result.public_connect_url, the ready-to-share link to hand to whoever opens it (no platform account needed on their side). Pass result.access_key.key, never result.access_key, to revoke_cloud_browser_access_key. `purpose` decides what the page behind the link does: `relogin` walks them through signing the LinkedIn session back in and re-binds the browser once they confirm, `share` just hands them the browser to drive. Optional ttl_hours / max_connects / allowed_ips / allowed_countries scope the key. DANGEROUS: both the key and the link are bearer secrets granting remote browser access.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/antidetect-browsers/generate-cloud-browser-access-key' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID,
      ttl_hours: z.number().int().min(1).max(720).optional().describe('Key lifetime in hours (default 8; the link is a bearer secret, keep it short). Sets expires_at on the entry.'),
      max_connects: z.number().int().min(1).max(1000).optional().describe('Cap on CONCURRENT sessions held on this key, counted live at connect. Not a lifetime quota: a key does not spend itself and never becomes exhausted. Omit for unlimited.'),
      allowed_ips: z.array(z.string().max(45)).optional().describe('IP allow-list checked at connect time.'),
      allowed_countries: z.array(z.string().length(2)).optional().describe('ISO country allow-list checked at connect time.'),
      purpose: z
        .enum(['relogin', 'share'])
        .optional()
        .describe('What the page behind the link does: relogin = sign the LinkedIn session back in and re-bind the browser on confirm (default); share = drive the browser, no sign-in step.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(
      AntidetectBrowser,
      z
        .object({
          access_key: CloudBrowserAccessEntry
            .describe('The minted entry, key included. Shown once: the key is a bearer secret and is never read back in full from any other surface.'),
          public_connect_url: z.string().describe('Shareable smart link carrying the key. Give this to the person who will open it.'),
        })
        .passthrough(),
    ),
    annotations: { title: 'Generate cloud-browser access key', ...DANGER },
  },
  {
    ...base,
    name: 'revoke_cloud_browser_access_key',
    description:
      'Revoke a cloud-browser access key on a browser. Pass the cb_ak_ key to revoke one; omit key to revoke EVERY key on the row. Only removes the key; live cloud-browser sessions are not force-disconnected. DANGEROUS: cuts off remote access.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/antidetect-browsers/revoke-cloud-browser-access-key' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID,
      key: ACCESS_KEY.nullable().optional().describe('Single key to revoke; omit to revoke all keys on the browser.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(AntidetectBrowser),
    annotations: { title: 'Revoke cloud-browser access key', ...DANGER },
  },
  // envelope.result of both proxy swaps. A running browser is powered off and back on
  // around the swap (the proxy is baked into the Chromium spawn and the node has no verb to
  // re-point it), so an agent must read `restarted` before assuming the sender is still up.
  {
    ...base,
    name: 'update_antidetect_browser_proxy',
    description:
      'Change the proxy of an existing antidetect browser, country included. Supply EXACTLY ONE source: antidetect_browser_proxy_sid, proxy_country_code or custom_proxy_config. EVERY arm needs browser_owner=platform: a profile bound by id keeps its proxy in the vendor (422 managed_proxy_forbidden_for_owner / 422 custom_proxy_forbidden_for_owner). custom_proxy_config is probed first (422 custom_proxy_unreachable_* changes nothing), takes the exit country measured there, and RELEASES any armed 5G slot. Zero sources 422 proxy_assignment_missing, more than one 422 proxy_assignment_conflict, empty pool 422 proxy_pool_empty, 5G on a BYO proxy 422 proxy_5g_requires_managed_proxy. proxy_5g alone is a valid body: it moves the add-on binding only. DANGEROUS twice over: a location flip mid-campaign can trip a LinkedIn risk check, and a running browser is restarted, since a live session keeps the old proxy until it respawns. Read result.restarted. To rotate the IP in place, use replace_antidetect_browser_proxy.',
    toolClass: 'complex',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/antidetect-browsers/update-proxy' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID,
      antidetect_browser_proxy_sid: PROXY_SID.optional()
        .describe('Pin a specific pooled proxy. Resolve the sid yourself with search_antidetect_browser_proxies; never ask an end user for one.'),
      proxy_country_code: z.string().length(2).optional().describe('ISO country. Picks the least-loaded active proxy. The default way to pick a proxy.'),
      custom_proxy_config: CustomProxyConfig.optional(),
      proxy_5g: z.boolean().optional()
        .describe('Arm (true) or release (false) the 5G Proxy add-on binding on this browser. Omit to leave the binding untouched. A body carrying proxy_5g alone is a valid source-less call: it moves only the add-on binding and leaves the IP where it is.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(AntidetectBrowser, ProxySwapResult),
    annotations: { title: 'Change antidetect browser proxy', ...DANGER },
  },
  {
    ...base,
    name: 'replace_antidetect_browser_proxy',
    description:
      'Rotate an antidetect browser onto another MANAGED proxy of the SAME country. Geo-binding is preserved, so this is the safe way to drop a flagged IP. Omit antidetect_browser_proxy_sid to take the least-loaded active proxy of that country, or pin one (a pin from another country is refused, 422 proxy_country_mismatch). Platform-owned browsers only, 422 managed_proxy_forbidden_for_owner; a platform row that never got a proxy is 422 proxy_not_managed; a country with no other active proxy is 422 proxy_replacement_unavailable. A running browser is stopped and started again so the new IP takes effect; result.restarted reports whether it came back.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/antidetect-browsers/replace-proxy' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID,
      antidetect_browser_proxy_sid: PROXY_SID.nullable().optional()
        .describe('Pin a specific same-country replacement; omit for the least-loaded one.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(AntidetectBrowser, ProxySwapResult),
    annotations: { title: 'Rotate antidetect browser proxy', ...DANGER },
  },
  {
    ...base,
    name: 'delete_antidetect_browser',
    description:
      'Decommission (soft-delete) a single antidetect browser by sid: outward, destructive, one-way through MCP. Variant B cascade: the bound linkedin-account is soft-deleted and pending plugin tasks transition to failed; the cascade block reports the counts. A platform-minted GoLogin profile is reclaimed (deleted) at the vendor unless another live browser row still holds it; customer BYO vendor profiles are left intact.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'DELETE', pathTemplate: '/api/antidetect-browsers/{sid}', sidParam: 'sid' },
    operation: 'delete',
    envelope: 'delete_cascade',
    availability: 'ga',
    dangerous: true,
    inputSchema: McpCascadeDeleteRequestSchema('ab_br_'),
    outputSchema: McpCascadeDeleteResponse,
    annotations: { title: 'Delete antidetect browser', ...DANGER },
  },
];
