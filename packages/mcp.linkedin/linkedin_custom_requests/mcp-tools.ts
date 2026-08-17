// Entity: LinkedIn Custom Requests (gtm.service.linkedin)
// Source of truth: product/research/gtm.service.linkedin/entities/linkedin_custom_requests.md
// The escape-hatch surface, one route: POST /api/linkedin-custom/execute
// (matrix row 84). Stateless: no table, no Domain. A custom call is recorded as
// ONE linkedin-account-activity-log row (action_type=custom_request), NOT a
// DataRequest (a custom call may be an action, not a read). Own-account only
// (linkedin_account_sid REQUIRED, runs as that account). The plugin verb
// custom-request NEVER throws on a non-2xx response: the HTTP outcome rides
// result {status_code, ok, headers, body}. dangerous:true because this is an
// admin-gated + feature-flagged + host-allowlisted escape hatch.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import { usageMetaField, McpActionResponse } from '@gtm/mcp-shared';

// item is null (stateless surface owns no row); the HTTP outcome + audit ride result.
const CustomExecuteResult = z.object({
  status_code: z.number().int().describe('The HTTP status the plugin observed: ANY value; the verb never throws on non-2xx.'),
  ok: z.boolean().describe('true iff status_code ∈ [200,299].'),
  headers: z.record(z.string()).describe('Response headers the plugin observed.'),
  body: z.unknown().describe('Parsed response body (JSON when parseable, else raw string). Returned inline, NOT persisted at rest.'),
  activity_log: z.object({}).passthrough().describe('Full dispatch row (linkedin-account-activity-log, action_type=custom_request) per §4.12a.'),
}).passthrough();

// Not read-only, not idempotent, reaches an external system we do not control.
// destructiveHint is true: the research note that "the surface mutates no row"
// is about OUR storage, but the caller owns the semantics of the call, which may
// be an irreversible write on LinkedIn (apply to a job, attend an event). It is
// also the registry invariant for dangerous: true (see runtime/src/registry.ts).
const HINTS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

export const linkedinCustomRequestsTools: ToolDefinition[] = [
  {
    service: 'linkedin',
    entity: 'linkedin_custom_requests',
    mount: 'linkedin.platform',
    name: 'execute_linkedin_custom_request',
    description:
      'ESCAPE HATCH: issue one arbitrary LinkedIn HTTP call (url + GET/POST + headers/body) under a chosen OWN account, for endpoints the typed methods do not cover. May be a read or an action (apply to a job, attend an event), so you own the semantics. High-risk: admin-gated + feature-flagged; the url must match the server host allowlist (else 403 forbidden_endpoint). OWN-ACCOUNT ONLY: linkedin_account_sid is REQUIRED. It spends the account\'s custom_request bucket, which returns 429 when saturated. A non-2xx response is still a successful dispatch (ok=false, status_code carries it; never throws). The response comes back inline, NOT stored; the audit is the linkedin-account-activity-log row (action_type=custom_request). PREFER TYPED METHODS FIRST: searches/lists → linkedin-scraping; one profile/company/post\'s own data → linkedin-enrichment; sends/invites/reactions/comments → messaging & networking. Never use it to route around a rate limit or a missing permission.',
    toolClass: 'complex',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-custom/execute' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      linkedin_account_sid: z.string().length(18).startsWith('ln_ac_')
        .describe('REQUIRED executor: the OWN account (ln_ac_…) the call runs as. Every custom request runs on the account named here, carrying that account\'s session, permissions and limits, so name the account whose identity the request should carry. There is no default and no substitute: omit it and the call is rejected.'),
      url: z.string().min(1).max(2048)
        .describe('Absolute LinkedIn URL (e.g. "https://www.linkedin.com/voyager/api/…") or a bare path (resolved against https://www.linkedin.com). MUST match the server host + path allowlist (provisional: *.linkedin.com + path prefixes /voyager/api/, /sales-api/). Otherwise 403 forbidden_endpoint.'),
      method: z.enum(['GET', 'POST']).optional()
        .describe('HTTP verb, default GET. Write-shaped verbs (PUT/DELETE/PATCH) are out of scope at launch (SAFETY).'),
      headers: z.record(z.string()).optional()
        .describe('Extra request headers merged onto the default voyager headers.'),
      body: z.union([z.record(z.unknown()), z.string()]).nullable().optional()
        .describe('POST JSON body (object → JSON-encoded) or raw string (passed through); ≤ 50 KB serialized; null/omitted for GET.'),
      form: z.boolean().optional()
        .describe('Modifier: when true, send `body` as application/x-www-form-urlencoded (NOT a separate body). POST only.'),
      include_default_headers: z.boolean().optional()
        .describe('Inject the plugin\'s default voyager headers (default true); false to send only `headers`.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(z.null(), CustomExecuteResult),
    annotations: { title: 'Execute custom LinkedIn request (escape hatch)', ...HINTS },
  },
];
