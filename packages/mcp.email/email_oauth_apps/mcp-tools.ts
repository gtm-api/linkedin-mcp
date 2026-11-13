// Entity: Email OAuth App (gtm.service.email), "sign-in application" in the app
// Source of truth: product/research/gtm.service.email/entities/email_oauth_apps.md
// Format: registry v2. 5 definitions (the email-oauth-apps route group), 4
// served on email.infrastructure, 1 REST only.
//
// Per route, what an agent gets and why:
//   search  served. Which applications exist, which one a connect names.
//   create  REST only. Registering an application means handing over its client
//           secret or a service account's key file, and a secret never passes
//           through a model (MCP_SURFACE_V2.md section 2, rules 1 and 6, of the
//           getsales umbrella). The Email Accounts screen and a REST caller do it.
//   update  served without client_secret (restOnlyInputs): a rename, the default,
//           the callback host, the Pub/Sub topic. Rotating the secret is REST.
//   delete  served, dangerous.
//   verify  served. No secret travels: the stored credential is probed.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  filterOp,
  McpActionResponse,
  McpCreateResponse,
  McpSearchResponse,
  McpSimpleDeleteResponse,
  McpUpdateResponse,
} from '@gtm/mcp-shared';
import {
  EmailOauthApp,
  EmailOauthAppAuthKind,
  EmailOauthAppProvider,
  EmailOauthAppPublishingStatus,
  EmailOauthAppStatus,
} from '../domains';
import { emailCommon, emailRoute, oneOf, RO, searchInput, sid, str, when } from '../shared';

const EmailOauthAppFilter = z.object({
  sid: str(['eq', 'in']),
  provider: oneOf(EmailOauthAppProvider, ['eq', 'in']),
  auth_kind: oneOf(EmailOauthAppAuthKind, ['eq', 'in'])
    .describe('service_account and app_only are the grant applications bulk_create_email_accounts takes.'),
  status: oneOf(EmailOauthAppStatus, ['eq', 'ne', 'in']).describe('{ eq: failed } is what needs attention.'),
  is_default: filterOp(z.boolean(), ['eq']).optional(),
  callback_host: str(['eq', 'is_null']),
  client_id: str(['eq']),
  q: z.string().max(255).optional().describe('Part of a name or a client id.'),
  created_at: when(['gte', 'lte']),
  deleted_at: when(['is_null']),
}).partial();

const EmailOauthAppCounts = z.object({
  total_count: z.number().int(),
  groups: z.object({ provider: z.record(z.number()), status: z.record(z.number()) }).partial().passthrough(),
}).passthrough();

const microsoftTenant = z.string().max(255).describe('microsoft only: common, organizations, a tenant id or a verified domain.');
const callbackHost = z.string().max(255)
  .describe("A custom domain of the team issued through the platform, which the provider redirects to; null: the platform's connect address.");
const pubsubTopic = z.string().max(255).describe("google only: projects/{project}/topics/{topic} in the application's own project.");

const base = { service: 'email', entity: 'email_oauth_apps', mount: 'email.infrastructure' } as const;

export const emailOauthAppsTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_email_oauth_apps',
    description:
      "List the team's own sign-in applications for mailboxes: a Google OAuth client or service account, a Microsoft app registration. Each has auth_kind (oauth_client: every mailbox consents; service_account and app_only: one grant covers a whole Workspace or tenant, no consent), status from its last credential check, is_default and accounts_count. Use it to find the sid a connect names (request_email_account_connect_link, bulk_create_email_accounts) or a server's default (update_email_box_settings), and which applications failed. Secrets are never read back. With no application of its own a team connects through the platform's. Requires can_view_email_accounts.",
    toolClass: 'typical',
    route: emailRoute('POST', '/api/email-oauth-apps/search'),
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    inputSchema: searchInput(EmailOauthAppFilter, z.enum(['created_at', 'name', 'last_verified_at'])),
    outputSchema: McpSearchResponse(EmailOauthApp, undefined, EmailOauthAppCounts),
    annotations: { title: 'Search email sign-in applications', ...RO },
  },
  {
    ...base,
    name: 'create_email_oauth_app',
    description:
      "Register the team's own sign-in application and check its credentials at the provider in the call: a Google or Microsoft OAuth client (client_id and client_secret), a Google service account with domain-wide delegation (service_account_json, the key file as Google hands it out) or a Microsoft app-only registration (auth_kind app_only). item.status is the verdict; a failed application is still saved, so the provider side can be fixed and verified again without sending the secret twice. is_default true makes it the provider's default and demotes the previous one. The same client id again answers the existing row (already_exists). 30 calls an hour. Requires can_manage_email_accounts.",
    toolClass: 'complex',
    route: emailRoute('POST', '/api/email-oauth-apps'),
    operation: 'create',
    envelope: 'create',
    availability: 'ga',
    dangerous: false,
    surface: 'api',
    inputSchema: z.object({
      provider: EmailOauthAppProvider,
      name: z.string().min(1).max(255),
      auth_kind: EmailOauthAppAuthKind.nullable().optional().describe('Default oauth_client.'),
      client_id: z.string().max(512).optional().describe('Required unless service_account_json is given.'),
      client_secret: z.string().max(8192).optional()
        .describe("The client secret; a service account's PEM private key. Required unless service_account_json is given. Stored encrypted, never read back."),
      service_account_email: z.string().email().max(320).nullable().optional(),
      service_account_json: z.string().max(16384).nullable().optional()
        .describe("google service account: the key file; fills auth_kind, client_id, client_secret and service_account_email."),
      microsoft_tenant: microsoftTenant.nullable().optional(),
      callback_host: callbackHost.nullable().optional(),
      google_pubsub_topic: pubsubTopic.nullable().optional(),
      is_default: z.boolean().nullable().optional(),
      publishing_status: EmailOauthAppPublishingStatus.nullable().optional(),
      ...emailCommon,
    }),
    outputSchema: McpCreateResponse(EmailOauthApp),
    annotations: { title: 'Register email sign-in application', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    ...base,
    name: 'update_email_oauth_app',
    description:
      "Change a sign-in application: its name, whether it is the provider's default (true demotes the previous one, false leaves the provider with none, so connects fall back to the platform's application), the callback host, the Microsoft tenant, the Google Pub/Sub topic or the declared publishing status. The client id and the provider cannot change: another client id is another application. Over REST the route also takes client_secret and checks it at the provider; a tool does not, because a secret never passes through a model. Requires can_manage_email_accounts.",
    toolClass: 'typical',
    route: emailRoute('PATCH', '/api/email-oauth-apps/{sid}'),
    operation: 'update',
    envelope: 'update',
    availability: 'ga',
    dangerous: false,
    restOnlyInputs: ['client_secret'],
    inputSchema: z.object({
      sid: sid('em_oa_'),
      name: z.string().min(1).max(255).optional(),
      microsoft_tenant: microsoftTenant.nullable().optional(),
      callback_host: callbackHost.nullable().optional(),
      google_pubsub_topic: pubsubTopic.nullable().optional(),
      is_default: z.boolean().optional(),
      publishing_status: EmailOauthAppPublishingStatus.optional(),
      client_secret: z.string().min(1).max(1024).optional()
        .describe('A new client secret; the credentials are checked at the provider in the call. Never read back.'),
      ...emailCommon,
    }),
    outputSchema: McpUpdateResponse(EmailOauthApp),
    annotations: { title: 'Update email sign-in application', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    ...base,
    name: 'delete_email_oauth_app',
    description:
      "Remove a sign-in application. Refused with 409 delete_blocked while a mailbox is connected through it (error.blockers names them): reconnect those through another application or delete them first. A deleted default leaves its provider without one, so connects fall back to the platform's application. Repeating it is safe. Through MCP the first call only previews. Requires can_manage_email_accounts.",
    toolClass: 'typical',
    route: emailRoute('DELETE', '/api/email-oauth-apps/{sid}'),
    operation: 'delete',
    envelope: 'delete_simple',
    availability: 'ga',
    dangerous: true,
    inputSchema: z.object({ sid: sid('em_oa_'), ...emailCommon }),
    outputSchema: McpSimpleDeleteResponse,
    annotations: { title: 'Delete email sign-in application', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    ...base,
    name: 'verify_email_oauth_app',
    description:
      "Check a sign-in application's stored credentials at the provider now and answer the refreshed row: item.status (verified or failed), item.last_error_code, result.previous_status. result.expected_redirect_uri is the exact address to register on the client, and result.redirect_uri_registered says whether Google saw it (false: register it; null: not observable). It proves the provider knows the client and takes the secret, not the consent screen or the scopes: those show at the first sign-in. Use it after the provider side was fixed. 30 calls an hour. Requires can_manage_email_accounts.",
    toolClass: 'typical',
    route: emailRoute('POST', '/api/email-oauth-apps/{sid}/verify'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: sid('em_oa_'), ...emailCommon }),
    outputSchema: McpActionResponse(EmailOauthApp, z.object({
      previous_status: EmailOauthAppStatus,
      redirect_uri_registered: z.boolean().nullable(),
      expected_redirect_uri: z.string().nullable(),
    })),
    annotations: { title: 'Verify email sign-in application', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
];
