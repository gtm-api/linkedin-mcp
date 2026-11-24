// Entity: Email Account (gtm.service.email), "mailbox" in the app
// Source of truth: product/research/gtm.service.email/entities/email_accounts.md
// Format: registry v2. 18 definitions (the email-accounts route group), 15 of
// them tools on email.accounts and 3 REST only (surface api).
//
// What is REST only, and why (the research blocks carry the same reasons):
//   - create: three of its four forms carry a secret (a refresh token, IMAP and
//     SMTP passwords) and a secret never passes through a model. The fourth,
//     the grant form, is bulk_create_email_accounts with one address, and a
//     person's own sign-in is request_email_account_connect_link.
//   - bulk-create-imap: up to 100 rows, each with its passwords.
//   - bulk-action: six verbs in one, two of which take mailboxes away, over up
//     to 500 sids. A model runs the single verbs, each behind its own gate.
// reconnect is a tool without its inline IMAP form: the passwords and the
// server block are restOnlyInputs, so the tool answers the hosted link and the
// REST route still takes the credentials.
//
// As built, and narrower than the research where the tools follow the code:
//   - search and get build one include, health;
//   - metrics computes its period numbers over the window alone (the filter
//     reaches aggregated.counts only, group_by is validated and not read);
//   - delete takes no acknowledge step and answers no per-child counts;
//   - the sync verb's pending ref carries no expected_completion_seconds;
//   - none of the per-team call budgets the research names is built.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import { McpActionResponse, McpCascadeDeleteResponse, McpCreateResponse, McpGetResponse, McpMetricsResponse, McpSearchResponse, McpUpdateResponse } from '@gtm/mcp-shared';
import {
  EmailAccount,
  EmailAccountActivityLog,
  EmailAccountConnection,
  EmailAccountConnectionEncryption,
  EmailAccountHealth,
  EmailAccountProvider,
  EmailAccountSendingPausedReason,
  EmailAccountStatus,
  EmailAccountSyncRun,
  EmailFolderRole,
  EmailMessage,
  RowError,
} from '../domains';
import {
  emailCommon,
  emailRoute,
  metricsResponse,
  oneOf,
  period,
  RO,
  RO_OPEN,
  searchInput,
  SendingLimitsInput,
  sid,
  str,
  WarmupConfigInput,
  when,
} from '../shared';

const EmailAccountFilter = z.object({
  q: z.string().max(255).optional().describe('Part of the address, the display name or the label.'),
  sid: str(['eq', 'in']),
  email_box_sid: str(['eq', 'in', 'is_null']).describe('The mailboxes of one email server.'),
  label: str(['eq', 'in', 'is_null']).describe("The customer's own tag, exact."),
  address_domain: str(['eq', 'in']).describe('The part after the @, lowercase.'),
  email_sending_domain_sid: str(['eq', 'in', 'is_null']),
  email_tracking_domain_sid: str(['eq', 'in', 'is_null']),
  email_oauth_app_sid: str(['eq', 'in', 'is_null']).describe('Mailboxes connected through one sign-in application.'),
  provider: oneOf(EmailAccountProvider),
  address: str(['eq', 'in']).describe('Lowercase, exact.'),
  status: oneOf(EmailAccountStatus),
  sending_paused_at: when(['is_null', 'gte', 'lte']).describe('{ is_null: false }: sending is paused now.'),
  sending_paused_reason: oneOf(EmailAccountSendingPausedReason, ['eq', 'in', 'is_null']),
  connected_at: when(),
  reconnect_required_at: when(['gte', 'lte', 'is_null']),
  last_messages_sync_at: when(['gte', 'lte', 'gt', 'lt', 'is_null']).describe('{ is_null: true }: never synced. lte a cutoff: stale.'),
  last_folders_sync_at: when(['gte', 'lte', 'gt', 'lt', 'is_null']),
  created_at: when(),
  updated_at: when(),
  deleted_at: when(['is_null', 'gte', 'lte']).describe('Absent: live rows only.'),
}).partial();

const EmailAccountIncluded = z.object({ health: EmailAccountHealth.nullable() }).partial();

const EmailAccountCounts = z.object({
  total_count: z.number().int(),
  sending_paused_count: z.number().int().optional(),
  groups: z.record(z.unknown()),
}).passthrough();

const EmailAccountMetrics = z.object({
  created_count: z.number().int().describe('Mailboxes created in the period.'),
  avg_initial_sync_seconds: z.number().nullable()
    .describe('From creation to the end of the first sync, over the mailboxes created in the period; null when none finished.'),
});

const INCLUDE = z.enum(['health']);

const SyncConfigInput = z.record(z.object({ interval_minutes: z.number().int().min(5) }))
  .describe('Sync cadence per track: keys messages, folders, health_check, each { interval_minutes }, 5 or more. A key left out uses the service default.');
const WebhookConfigInput = z.record(z.object({ enabled: z.boolean(), since: z.string().nullable().optional() }))
  .describe('Which event families this mailbox emits: keys email-messages, email-threads, email-engagements, email-accounts, email-account-health, each { enabled }. A key left out is off.');

const ConnectionRow = z.object({
  imap_host: z.string().max(255),
  imap_port: z.number().int().min(1).max(65535),
  imap_encryption: EmailAccountConnectionEncryption,
  imap_username: z.string().max(320).nullable().optional().describe('Default: the address.'),
  smtp_host: z.string().max(255),
  smtp_port: z.number().int().min(1).max(65535),
  smtp_encryption: EmailAccountConnectionEncryption,
  smtp_username: z.string().max(320).nullable().optional().describe('Default: the address.'),
});

const ConnectionInput = EmailAccountConnection.extend({
  imap_host: z.string().max(255),
  imap_port: z.number().int().min(1).max(65535),
  imap_username: z.string().max(320),
  smtp_host: z.string().max(255),
  smtp_port: z.number().int().min(1).max(65535),
  smtp_username: z.string().max(320),
});

const ActionLog = z.object({
  activity_log: EmailAccountActivityLog.nullable().describe('The audit row of the change; null when the call changed nothing.'),
});

const BulkCreateResult = z.object({
  applied: z.number().int().describe('Mailboxes connected, or already connected.'),
  failed: z.number().int(),
  items: z.array(z.object({
    address: z.string(),
    ok: z.boolean(),
    already_exists: z.boolean().optional(),
    item: EmailAccount.optional(),
    error: RowError.optional(),
  })),
});

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const base = { service: 'email', entity: 'email_accounts', mount: 'email.accounts' } as const;

export const emailAccountsTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_email_accounts',
    description:
      "List the team's mailboxes on an email server: address, provider, status, whether sending is paused and why, today's sends against today's cap, the warmup day, limits, tracking and the last sync. Filter by status, provider, label, domain, sign-in application or the sync clocks; q matches part of the address, the display name or the label. Use it to find a mailbox to send from (status eq active, sending_paused_at is_null true), mailboxes that need a reconnect (status eq reconnect_required) or held ones (subscription_required). include health adds the latest health snapshot of each. page_size 0 answers counts alone. Requires can_view_email_accounts.",
    toolClass: 'typical',
    route: emailRoute('POST', '/api/email-accounts/search'),
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    inputSchema: searchInput(
      EmailAccountFilter,
      z.enum(['created_at', 'updated_at', 'address', 'connected_at', 'last_messages_sync_at', 'label', 'sent_today']),
      INCLUDE,
    ),
    outputSchema: McpSearchResponse(EmailAccount, EmailAccountIncluded, EmailAccountCounts),
    annotations: { title: 'Search email accounts', ...RO },
  },
  {
    ...base,
    name: 'get_email_account',
    description:
      'Read one mailbox by sid: its status and why it is held or needs a reconnect, the sending limits, window and warmup ramp, tracking, sync and webhook settings, the stored signature (read-only, deprecated), and the IMAP and SMTP servers of an imap_smtp mailbox (never a password). include health adds the latest health snapshot: score, bounce and complaint rates, DNS state and what to fix. Requires can_view_email_accounts.',
    toolClass: 'trivial',
    route: { ...emailRoute('GET', '/api/email-accounts/{sid}'), queryParams: ['include'] },
    operation: 'get',
    envelope: 'get',
    availability: 'ga',
    dangerous: false,
    inputSchema: z.object({
      sid: sid('em_ac_'),
      include: z.array(INCLUDE).optional(),
      ...emailCommon,
    }),
    outputSchema: McpGetResponse(EmailAccount, EmailAccountIncluded),
    annotations: { title: 'Get email account', ...RO },
  },
  {
    ...base,
    name: 'create_email_account',
    description:
      "Connect a mailbox with credentials you hold, or mint a hosted one. Four forms by provider: google or microsoft with oauth_refresh_token and the application that issued it; google or microsoft with an address under a service_account or app_only application (no consent); imap_smtp with the servers and both passwords; gtm_hosted on a verified sending domain. The credential is probed before the row is written. A mailbox already connected by this team is answered with already_exists true; one bound to another team is 409 account_bound_other_team. With no free seat on the server the mailbox lands held (subscription_required). Requires can_manage_email_accounts.",
    toolClass: 'complex',
    route: emailRoute('POST', '/api/email-accounts'),
    operation: 'create',
    envelope: 'create',
    availability: 'ga',
    dangerous: false,
    surface: 'api',
    inputSchema: z.object({
      provider: EmailAccountProvider,
      address: z.string().email().max(320).nullable().optional().describe('Required for imap_smtp, gtm_hosted and the grant form.'),
      display_name: z.string().max(255).nullable().optional(),
      label: z.string().max(64).nullable().optional().describe("The customer's own tag."),
      backfill_days: z.number().int().min(0).max(3650).nullable().optional().describe('Days of history to mirror. Default 90.'),
      email_oauth_app_sid: sid('em_oa_').optional().describe('google and microsoft: the sign-in application. Required for both forms.'),
      oauth_refresh_token: z.string().max(4096).nullable().optional().describe('google and microsoft, the token form: a refresh token that application issued.'),
      connection: ConnectionInput.optional().describe('imap_smtp: the IMAP and SMTP servers.'),
      imap_password: z.string().max(1024).optional(),
      smtp_password: z.string().max(1024).optional(),
      email_sending_domain_sid: sid('em_sd_').optional().describe('gtm_hosted: the verified sending domain the address is on.'),
      ...emailCommon,
    }),
    outputSchema: McpCreateResponse(EmailAccount),
    annotations: { title: 'Create email account', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    ...base,
    name: 'update_email_account',
    description:
      "Change a mailbox's settings: display name, label, sending limits, the warmup ramp, open and click tracking, the tracking domain, sync cadence and which events it emits. Only the fields sent change. sending_limits and warmup_config are replaced whole: send every key of the object, with sending_window null for no window. Turning warmup on starts the ramp at ramp_start_daily. The signature is not kept here: write it into body_html of each send. Credentials are not changed here: reconnect_email_account. To stop sending without touching limits use pause_email_account_sending. Requires can_update_email_accounts.",
    toolClass: 'typical',
    route: emailRoute('PATCH', '/api/email-accounts/{sid}'),
    operation: 'update',
    envelope: 'update',
    availability: 'ga',
    dangerous: false,
    inputSchema: z.object({
      sid: sid('em_ac_'),
      display_name: z.string().max(255).nullable().optional(),
      label: z.string().max(64).nullable().optional().describe('null or an empty string clears it.'),
      sending_limits: SendingLimitsInput.optional(),
      warmup_config: WarmupConfigInput.optional(),
      track_opens: z.boolean().optional(),
      track_clicks: z.boolean().optional(),
      email_tracking_domain_sid: sid('em_td_').nullable().optional().describe('A verified tracking domain; null unbinds it.'),
      sync_config: SyncConfigInput.optional(),
      webhook_config: WebhookConfigInput.optional(),
      ...emailCommon,
    }),
    outputSchema: McpUpdateResponse(EmailAccount),
    annotations: { title: 'Update email account', ...WRITE },
  },
  {
    ...base,
    name: 'delete_email_account',
    description:
      "Delete a mailbox from the platform: sync and sending stop, the provider grant is revoked and the stored credentials are purged, its mirrored mail, queued messages included, leaves the workspace's data, and its seat on the server is freed. The mailbox at its provider is not touched. There is no confirmation step on the route: the first call deletes. To stop a mailbox and keep its data use disconnect_email_account; to stop only outbound, pause_email_account_sending. Repeating answers already_deleted true. Requires can_manage_email_accounts.",
    toolClass: 'typical',
    route: emailRoute('DELETE', '/api/email-accounts/{sid}'),
    operation: 'delete',
    envelope: 'delete_cascade',
    availability: 'ga',
    dangerous: true,
    inputSchema: z.object({ sid: sid('em_ac_'), ...emailCommon }),
    outputSchema: McpCascadeDeleteResponse,
    annotations: { title: 'Delete email account', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  {
    ...base,
    name: 'get_email_accounts_metrics',
    description:
      'Onboarding numbers of a period: created_count (mailboxes created in it) and avg_initial_sync_seconds (from creation to the end of the first sync). aggregated.counts is the fleet now: total_count, sending_paused_count and the split by provider and status in groups. It covers the whole server: it takes no filter and no split. For sends per mailbox per day use get_email_accounts_daily_sends; for deliverability get_email_messages_metrics. period is required. Requires can_view_email_accounts.',
    toolClass: 'typical',
    route: emailRoute('POST', '/api/email-accounts/metrics'),
    operation: 'metrics',
    envelope: 'metrics',
    availability: 'ga',
    dangerous: false,
    inputSchema: z.object({ period, ...emailCommon }),
    outputSchema: metricsResponse(EmailAccountMetrics, EmailAccountCounts),
    annotations: { title: 'Email account metrics', ...RO },
  },
  {
    ...base,
    name: 'request_email_account_connect_link',
    description:
      "Get a link the owner of a mailbox opens to connect it: they sign in with Google or Microsoft, or type their IMAP and SMTP details, on a hosted page, so no password ever passes through you. result.connect_url lives 24 hours; hand it to the person. The mailbox appears (search_email_accounts) once they finish, on the server this call named. Without provider the page lets them choose. With no free seat on the server the mailbox lands held (subscription_required). A mailbox that needs new credentials takes reconnect_email_account instead. Requires can_manage_email_accounts.",
    toolClass: 'typical',
    route: emailRoute('POST', '/api/email-accounts/request-connect-link'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      provider: z.enum(['google', 'microsoft', 'imap_smtp']).nullable().optional().describe('Absent: the page shows a provider picker.'),
      email_oauth_app_sid: sid('em_oa_').nullable().optional()
        .describe("Sign in through this application of the team (search_email_oauth_apps); needs provider. Absent: the server's default, else the platform's."),
      success_redirect_url: z.string().url().max(2048).nullable().optional().describe('Where the page sends the person when done; the host must be allowed.'),
      backfill_days: z.number().int().min(0).max(3650).nullable().optional().describe('Days of history to mirror. Default 90.'),
      display_name: z.string().max(255).nullable().optional(),
      label: z.string().max(64).nullable().optional().describe("The customer's own tag; carried by the IMAP form."),
      ...emailCommon,
    }),
    outputSchema: McpActionResponse(z.null(), z.object({
      connect_url: z.string(),
      expires_at: z.string(),
      email_oauth_app_sid: z.string().nullable().optional().describe('The application the sign-in will run through; null: the platform\'s.'),
    })),
    annotations: { title: 'Request email account connect link', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    ...base,
    name: 'reconnect_email_account',
    description:
      "Give a mailbox new credentials when it reads reconnect_required or disconnected. The answer is a link bound to that mailbox (result.mode hosted_link, connect_url, 24 hours): its owner signs in or types the new password on the hosted page, and the same mailbox turns active and catches up, with its history and settings kept. Signing in as another mailbox is refused there. A mailbox under a service_account or app_only application has no consent to renew: it is reconnected inside the call (mode reconnected). A held mailbox (subscription_required) answers 402; a hosted one cannot be reconnected. Requires can_update_email_accounts.",
    toolClass: 'complex',
    route: emailRoute('POST', '/api/email-accounts/{sid}/reconnect'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    restOnlyInputs: ['connection', 'imap_password', 'smtp_password'],
    inputSchema: z.object({
      sid: sid('em_ac_'),
      email_oauth_app_sid: sid('em_oa_').nullable().optional()
        .describe("google and microsoft: consent through this application of the team; null: the platform's. Absent: the one the mailbox already uses."),
      success_redirect_url: z.string().url().max(2048).optional().describe('Where the hosted page sends the person when done.'),
      connection: ConnectionInput.optional().describe('imap_smtp, inline form: the servers, with both passwords.'),
      imap_password: z.string().max(1024).optional(),
      smtp_password: z.string().max(1024).optional(),
      ...emailCommon,
    }),
    outputSchema: McpActionResponse(EmailAccount, z.object({
      mode: z.string().describe('hosted_link: nothing changed yet, the owner finishes on connect_url. reconnected: done in this call.'),
      connect_url: z.string().optional(),
      expires_at: z.string().optional(),
      activity_log: EmailAccountActivityLog.nullable().optional(),
      catch_up_sync_run: EmailAccountSyncRun.nullable().optional().describe('The sync that catches the mailbox up.'),
    })),
    annotations: { title: 'Reconnect email account', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    ...base,
    name: 'disconnect_email_account',
    description:
      "Detach a mailbox and keep its data: the provider grant is revoked, the stored credentials are purged, sync and sending stop and status turns disconnected. The mirrored mail stays readable and the settings stay, and the mailbox keeps its seat on the server: to free the seat use delete_email_account. Bringing it back takes new credentials from its owner (reconnect_email_account). A mailbox still connecting is refused, a held one answers 402. Repeating on a disconnected mailbox changes nothing. Requires can_manage_email_accounts.",
    toolClass: 'typical',
    route: emailRoute('POST', '/api/email-accounts/{sid}/disconnect'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: sid('em_ac_'), ...emailCommon }),
    outputSchema: McpActionResponse(EmailAccount, ActionLog),
    annotations: { title: 'Disconnect email account', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  {
    ...base,
    name: 'detect_email_account_provider',
    description:
      'Tell how an address is best connected before asking its owner for anything: result.provider_hint is google or microsoft when the mail of its domain is hosted there (read from the public MX records), else imap_smtp with imap_smtp_presets, a guess at the IMAP and SMTP servers (imap.<domain> on 993, smtp.<domain> on 465, both ssl). It reads DNS and stores nothing. Then mint the link with request_email_account_connect_link and that provider. Requires can_manage_email_accounts.',
    toolClass: 'trivial',
    route: emailRoute('POST', '/api/email-accounts/detect-provider'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ email: z.string().email().max(320), ...emailCommon }),
    outputSchema: McpActionResponse(z.null(), z.object({
      provider_hint: z.string().describe('google, microsoft or imap_smtp.'),
      imap_smtp_presets: z.object({
        imap_host: z.string(),
        imap_port: z.number().int(),
        imap_encryption: z.string(),
        smtp_host: z.string(),
        smtp_port: z.number().int(),
        smtp_encryption: z.string(),
      }).passthrough().nullable(),
    })),
    annotations: { title: 'Detect email account provider', ...RO_OPEN },
  },
  {
    ...base,
    name: 'pause_email_account_sending',
    description:
      'Stop outbound mail from a mailbox and leave everything else running: sync goes on, inbound keeps arriving, and scheduled messages stay queued until resume_email_account_sending. The pause is recorded as manual. A mailbox already paused, by a person or by the platform, is left as it is with its own reason. Use it to hold a mailbox during an incident or a domain change; delete_email_message cancels a single queued message. Requires can_update_email_accounts.',
    toolClass: 'trivial',
    route: emailRoute('POST', '/api/email-accounts/{sid}/pause-sending'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: sid('em_ac_'), ...emailCommon }),
    outputSchema: McpActionResponse(EmailAccount, ActionLog),
    annotations: { title: 'Pause email account sending', ...WRITE },
  },
  {
    ...base,
    name: 'resume_email_account_sending',
    description:
      "Lift the pause on a mailbox's outbound mail: queued messages go out again on the next pass of the queue, under the limits and the window. A pause the platform made on its own (sending_paused_reason bounce_rate, complaint_rate, provider_block, warmup_guard or provider_quota) needs reason, your account of why it is safe now, else 422 resume_reason_required; read search_email_account_health first, since resuming into the same bounce rate pauses it again. A manual pause needs none. Resuming a mailbox that is not paused changes nothing. Requires can_update_email_accounts.",
    toolClass: 'typical',
    route: emailRoute('POST', '/api/email-accounts/{sid}/resume-sending'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: sid('em_ac_'),
      reason: z.string().max(512).nullable().optional().describe('Why it is safe to resume; kept on the audit row. Required after an automatic pause.'),
      ...emailCommon,
    }),
    outputSchema: McpActionResponse(EmailAccount, ActionLog),
    annotations: { title: 'Resume email account sending', ...WRITE },
  },
  {
    ...base,
    name: 'sync_email_account',
    description:
      "Start a sync of a mailbox now instead of waiting for its cadence: new mail, read and flag changes and deletions since the last one. The call answers at once with async true; pending[0].sync_run is the run, to follow with search_email_account_sync_runs (filter.sid eq its sid) until its status is completed or cancelled. Only an active mailbox syncs: any other status, and a hosted mailbox, answer 409 account_not_syncable. While a run is open the call answers 409 sync_in_progress with context.open_sync_run_sid: follow that run. Requires can_view_email_accounts.",
    toolClass: 'typical',
    route: emailRoute('POST', '/api/email-accounts/{sid}/sync-email-account'),
    operation: 'action',
    envelope: 'action_async',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: sid('em_ac_'), ...emailCommon }),
    outputSchema: McpActionResponse(EmailAccount, z.object({
      enqueued_at: z.string().nullable(),
      activity_log: EmailAccountActivityLog,
    })).extend({
      async: z.literal(true),
      pending: z.array(z.object({
        sync_run: EmailAccountSyncRun,
        polling_hint: z.string(),
        webhook_events: z.array(z.string()),
      }).passthrough()),
    }),
    annotations: { title: 'Sync email account', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    ...base,
    name: 'search_email_account_provider',
    description:
      "Search one mailbox at its provider (Gmail, Microsoft or the IMAP server) for mail the mirror may not hold: older than the backfill window, or matched by words of the body. The hits are mirrored by the call, so each is a normal message afterwards: read it with get_email_message, answer it with send_email_message. result.items are the messages without bodies, in the provider's order, at most 50; truncated says the provider had more; sources says which were already mirrored. search_email_messages stays the cheap search of what is mirrored: try it first. An inactive or hosted mailbox answers 409 account_not_searchable; 503 provider_unavailable carries retry_after. Requires can_view_email_accounts.",
    toolClass: 'typical',
    route: emailRoute('POST', '/api/email-accounts/{sid}/search-provider'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: sid('em_ac_'),
      q: z.string().min(1).max(128).describe("Words, matched where the provider matches them: subject, body, participants. Plain words, not the provider's query syntax."),
      email_folder_sid: sid('em_fd_').nullable().optional().describe('Search this folder of the mailbox alone. Default: the whole mailbox (the inbox on a plain IMAP server).'),
      since: z.string().nullable().optional().describe('ISO 8601 date, inclusive.'),
      before: z.string().nullable().optional().describe('ISO 8601 date, after since.'),
      limit: z.number().int().min(1).max(50).nullable().optional().describe('1 to 50. Default 20.'),
      ...emailCommon,
    }),
    outputSchema: McpActionResponse(EmailAccount, z.object({
      q: z.string(),
      folder: z.object({
        sid: z.string(),
        name: z.string(),
        role: EmailFolderRole,
        provider_folder_id: z.string(),
      }).nullable(),
      folder_provider_id: z.string().nullable().describe('The folder the provider was asked in.'),
      provider_hits: z.number().int(),
      fetched: z.number().int().describe('Messages this search mirrored for the first time.'),
      truncated: z.boolean(),
      items: z.array(EmailMessage),
      sources: z.record(z.string()).describe('Message sid to local (mirrored before) or provider (fetched by this search).'),
    })),
    annotations: { title: 'Search email account at provider', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    ...base,
    name: 'bulk_create_email_accounts',
    description:
      "Connect up to 100 mailboxes of one organisation in a call, with no consent screen and no password: through a sign-in application of kind service_account (a Google service account with domain-wide delegation) or app_only (a Microsoft app registration), which holds the credential (search_email_oauth_apps; an oauth_client application is refused). You name the addresses. Each is answered on its own in result.items: ok true with the mailbox, or ok false with the reason (mailbox_not_found, delegation_not_authorized, no_mailbox_license, account_bound_other_team and the like); one bad address never fails the others. The same list again answers already_exists true. With no free seat on the server a mailbox lands held. Requires can_manage_email_accounts.",
    toolClass: 'complex',
    route: emailRoute('POST', '/api/email-accounts/bulk-create'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      email_oauth_app_sid: sid('em_oa_').describe('A verified service_account or app_only application of the team.'),
      addresses: z.array(z.string().email().max(320)).min(1).max(100),
      backfill_days: z.number().int().min(0).max(3650).nullable().optional().describe('Days of history to mirror, for every mailbox of the call. Default 90.'),
      ...emailCommon,
    }),
    outputSchema: McpActionResponse(z.null(), BulkCreateResult),
    annotations: { title: 'Bulk create email accounts', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    ...base,
    name: 'bulk_create_email_accounts_imap',
    description:
      "Connect up to 100 IMAP and SMTP mailboxes in one call, each row with its own servers and password. Every row is probed (a real sign-in to its IMAP and SMTP servers) and answered on its own in result.items: a refused password costs that row only. A username left out is the address; an SMTP password left out is the IMAP one. With no free seat on the server a row lands held (subscription_required), it is not refused. The same rows again answer already_exists true. Rows are probed one after another inside the request, so keep a call to about 10 rows. Requires can_manage_email_accounts.",
    toolClass: 'complex',
    route: emailRoute('POST', '/api/email-accounts/bulk-create-imap'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    surface: 'api',
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      rows: z.array(z.object({
        address: z.string().email().max(320),
        display_name: z.string().max(255).nullable().optional(),
        label: z.string().max(64).nullable().optional(),
        connection: ConnectionRow,
        imap_password: z.string().max(1024),
        smtp_password: z.string().max(1024).nullable().optional().describe('Default: the IMAP password.'),
      })).min(1).max(100),
      backfill_days: z.number().int().min(0).max(3650).nullable().optional().describe('Days of history to mirror, for every row. Default 90.'),
      ...emailCommon,
    }),
    outputSchema: McpActionResponse(z.null(), BulkCreateResult),
    annotations: { title: 'Bulk create IMAP email accounts', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    ...base,
    name: 'bulk_action_email_accounts',
    description:
      "Run one action over up to 500 mailboxes named by sid: pause, resume, update (label, sending_limits, warmup_config), disconnect, delete or sync. Each mailbox runs the single verb's own rules and is answered on its own in result.items; a refusal on one never stops the others. resume lifts manual pauses only: a pause the platform made answers resume_reason_required for that mailbox and is lifted on its own, with a reason. disconnect and delete also need can_manage_email_accounts, asked once for the call (403 scope_missing). Nothing is paced or sent. Requires can_update_email_accounts.",
    toolClass: 'complex',
    route: emailRoute('POST', '/api/email-accounts/bulk-action'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    surface: 'api',
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      action: z.enum(['pause', 'resume', 'update', 'disconnect', 'delete', 'sync']),
      email_account_sids: z.array(sid('em_ac_')).min(1).max(500),
      update: z.object({
        label: z.string().max(64).nullable().optional().describe('null or an empty string clears it.'),
        sending_limits: SendingLimitsInput.optional(),
        warmup_config: WarmupConfigInput.optional(),
      }).optional().describe('Required when action is update; each field sent replaces whole.'),
      ...emailCommon,
    }),
    outputSchema: McpActionResponse(z.null(), z.object({
      applied: z.number().int(),
      failed: z.number().int(),
      items: z.array(z.object({
        email_account_sid: z.string(),
        ok: z.boolean(),
        error: RowError.optional(),
      })),
    })),
    annotations: { title: 'Bulk action on email accounts', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    ...base,
    name: 'get_email_accounts_daily_sends',
    description:
      "Outbound mail per mailbox per calendar day, for a chart or a pacing check: items holds one entry per mailbox per day that sent, with sent (what left) and bounced (the part of it that came back); a day with nothing sent has no entry. period is two dates, both included, at most 31 days, read in the server's time zone (metrics.period.time_zone says which), so the days of different mailboxes line up. filter.email_account_sid.in narrows it to named mailboxes. Today's count against today's cap is on the mailbox itself (sent_today, daily_cap_today). Requires can_view_email_accounts.",
    toolClass: 'typical',
    route: emailRoute('POST', '/api/email-accounts/daily-sends'),
    operation: 'metrics',
    envelope: 'metrics',
    availability: 'ga',
    dangerous: false,
    inputSchema: z.object({
      period: z.object({
        from: z.string().describe('The first day, YYYY-MM-DD.'),
        to: z.string().describe('The last day, YYYY-MM-DD, included.'),
      }).describe('At most 31 days.'),
      filter: z.object({
        email_account_sid: z.object({ in: z.array(sid('em_ac_')).min(1).max(500) }).nullable().optional(),
      }).nullable().optional(),
      ...emailCommon,
    }),
    outputSchema: McpMetricsResponse(z.object({}).passthrough()).extend({
      metrics: z.object({
        period: z.object({
          from: z.string(),
          to: z.string(),
          time_zone: z.string().describe('The zone the days were counted in.'),
        }),
      }).passthrough(),
      items: z.array(z.object({
        date: z.string().describe('YYYY-MM-DD in time_zone.'),
        email_account_sid: z.string(),
        sent: z.number().int(),
        bounced: z.number().int(),
      })),
    }),
    annotations: { title: 'Email account daily sends', ...RO },
  },
];
