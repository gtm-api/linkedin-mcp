// The Domain projections of gtm.service.email, in one module because they embed
// each other (a message answers with its thread, a thread with its last
// messages, a mailbox verb with the activity-log row and the sync run it
// made), and fifteen entity files importing each other in a ring would not
// load. Each entity's filters, requests and tools stay in its own
// {entity}/mcp-tools.ts.
//
// Source of truth: product/research/gtm.service.email/entities/*.md, section
// Domain, checked against fixtures/contract-oracle/email.contract.json: every
// key here is a field of the PHP {Entity}Domain (tests/contract-parity.test.ts)
// and every enum is the PHP enum's value set (tests/enum-parity.test.ts).
// .passthrough() on a row keeps a field the backend adds later readable.

import { z } from 'zod';
import { AccessIdentityValue } from '@gtm/mcp-shared';

// ─── enums ──────────────────────────────────────────────────────────────

export const EmailAccountProvider = z.enum(['google', 'microsoft', 'imap_smtp', 'gtm_hosted']);
export const EmailAccountStatus = z.enum(['connecting', 'active', 'reconnect_required', 'disconnected', 'subscription_required']);
export const EmailAccountSendingPausedReason = z.enum(['manual', 'bounce_rate', 'complaint_rate', 'provider_block', 'warmup_guard', 'provider_quota']);
export const EmailAccountSubscriptionHoldReason = z.enum(['server_full', 'server_suspended']);
export const EmailAccountConnectionEncryption = z.enum(['ssl', 'starttls', 'none']);

export const EmailAccountActivityLogActionType = z.enum([
  'connect_probe', 'connect_completed', 'reconnect', 'disconnect', 'account_delete', 'pause_sending', 'resume_sending',
  'sync_triggered', 'oauth_refresh', 'token_revoke', 'watch_renewal', 'subscription_renewal', 'send_attempt',
  'send_enqueue', 'suppression_skip', 'suppression_override', 'dns_check',
]);
export const EmailAccountActivityLogStatus = z.enum(['pending', 'success', 'failed', 'skipped']);

export const EmailAccountSyncRunSyncType = z.enum(['messages', 'folders']);
export const EmailAccountSyncRunSyncMode = z.enum(['initial', 'incremental']);
export const EmailAccountSyncRunTriggeredBy = z.enum(['bootstrap', 'scheduled', 'manual', 'reconnect', 'probe', 'push']);
export const EmailAccountSyncRunStatus = z.enum(['pending', 'in_progress', 'completed', 'cancelled']);
export const EmailAccountSyncRunWaitReason = z.enum(['provider_throttle', 'provider_transient', 'pacing', 'auth_suspect']);

export const EmailAccountHealthWarmupLevel = z.enum(['cold', 'warming', 'warm']);
export const EmailAccountHealthDnsStatus = z.enum(['valid', 'pending', 'invalid', 'na']);

export const EmailFolderRole = z.enum(['inbox', 'sent', 'drafts', 'trash', 'spam', 'archive', 'starred', 'important', 'custom']);

export const EmailMessageDirection = z.enum(['inbound', 'outbound']);
export const EmailMessageStatus = z.enum(['received', 'scheduled', 'sending', 'sent', 'failed', 'bounced']);
export const EmailMessageKind = z.enum(['regular', 'bounce_notification']);
export const EmailMessageBounceType = z.enum(['hard', 'soft', 'policy']);

export const EmailSuppressionOrigin = z.enum(['manual', 'bounce', 'unsubscribe', 'complaint']);
export const EmailBounceLogKind = z.enum(['bounce', 'complaint']);
export const EmailBounceLogSource = z.enum(['dsn', 'smtp_reject', 'verp', 'fbl', 'heuristic']);
export const EmailEngagementKind = z.enum(['open', 'click', 'unsubscribe']);

export const EmailDomainVerificationStatus = z.enum(['pending', 'verified', 'failed']);
export const DnsRecordStatus = z.enum(['pending', 'valid', 'invalid']);
export const EmailDomainDnsStatus = z.enum(['valid', 'invalid', 'missing', 'pending', 'na']);

export const EmailOauthAppProvider = z.enum(['google', 'microsoft']);
export const EmailOauthAppAuthKind = z.enum(['oauth_client', 'service_account', 'app_only']);
export const EmailOauthAppPublishingStatus = z.enum(['unknown', 'testing', 'unverified', 'verified']);
export const EmailOauthAppStatus = z.enum(['verified', 'failed']);

// ─── values ─────────────────────────────────────────────────────────────

export const EmailParticipant = z.object({
  email: z.string().describe('Lowercase address.'),
  display_name: z.string().nullable().optional(),
});

export const EmailHeader = z.object({ name: z.string(), value: z.string() }).passthrough();

export const EmailAttachment = z.object({
  id: z.string().describe('The attachment id within the message: the attachment_id of get_email_message_attachment.'),
  name: z.string(),
  mime: z.string(),
  size: z.number().int().nonnegative().describe("Bytes; the provider's estimate until the first fetch."),
  content_id: z.string().nullable().optional().describe('cid of an inline image.'),
  is_inline: z.boolean().optional(),
}).passthrough();

export const EmailAccountConnection = z.object({
  imap_host: z.string(),
  imap_port: z.number().int(),
  imap_encryption: EmailAccountConnectionEncryption,
  imap_username: z.string(),
  smtp_host: z.string(),
  smtp_port: z.number().int(),
  smtp_encryption: EmailAccountConnectionEncryption,
  smtp_username: z.string(),
}).describe('IMAP and SMTP servers of an imap_smtp mailbox. No secrets: a password is never read back.');

export const EmailAccountSendingWindow = z.object({
  time_zone: z.string().describe('IANA time zone; also the day boundary of the daily limit.'),
  days: z.array(z.number().int()).describe('ISO weekdays, 1 Monday to 7 Sunday.'),
  start: z.string().describe('HH:MM.'),
  end: z.string().describe('HH:MM.'),
});

export const EmailAccountSendingLimits = z.object({
  daily_limit: z.number().int().describe('Sends a day, 1 to 2000.'),
  min_interval_seconds: z.number().int().describe('Seconds between sends of the queue, 0 to 3600.'),
  sending_window: EmailAccountSendingWindow.nullable().describe('Null: send at any time, the day is the UTC day.'),
});

export const EmailAccountWarmupConfig = z.object({
  enabled: z.boolean(),
  ramp_start_daily: z.number().int().describe('The cap of day 1, 1 to 100.'),
  ramp_step_per_day: z.number().int().describe('Added each day, 1 to 50.'),
  target_daily: z.number().int().describe('Where the ramp ends, 5 to 2000.'),
}).describe('The warmup ramp: while on, the day cap is the smaller of daily_limit and the ramp.');

export const DnsRecord = z.object({
  type: z.string().describe('CNAME, MX or TXT.'),
  host: z.string(),
  value: z.string(),
  status: DnsRecordStatus.describe('What the last check saw for this record.'),
}).passthrough();

// ─── rows ───────────────────────────────────────────────────────────────

export const EmailAccountHealth = z.object({
  sid: z.string(),
  team_sid: z.string(),
  email_account_sid: z.string(),
  health_score: z.number().int().describe('0 to 100.'),
  warmup_level: EmailAccountHealthWarmupLevel,
  sent_7d: z.number().int(),
  sent_30d: z.number().int(),
  bounce_rate_30d: z.number().nullable().describe('0 to 1; null when nothing was sent in the window.'),
  hard_bounces_30d: z.number().int(),
  soft_bounces_30d: z.number().int(),
  policy_blocks_30d: z.number().int(),
  complaints_30d: z.number().int(),
  complaint_rate_30d: z.number().nullable(),
  reply_rate_30d: z.number().nullable(),
  tracked_open_rate_30d: z.number().nullable().describe('Opens over the sends that carried open tracking.'),
  reconnect_incidents_30d: z.number().int(),
  warmup_enabled: z.boolean(),
  dns_health: z.object({
    mx: EmailAccountHealthDnsStatus,
    spf: EmailAccountHealthDnsStatus,
    dkim: EmailAccountHealthDnsStatus,
    dmarc: EmailAccountHealthDnsStatus,
    return_path: EmailAccountHealthDnsStatus,
    tracking_domain: EmailAccountHealthDnsStatus,
  }).passthrough().nullable(),
  sending_paused_reason: EmailAccountSendingPausedReason.nullable(),
  tips: z.array(z.object({
    code: z.string(),
    severity: z.string(),
    message: z.string(),
  }).passthrough()).describe('What to fix, worst first; empty when healthy.'),
  created_at: z.string().nullable().describe('When the snapshot was taken.'),
  updated_at: z.string().nullable(),
  deleted_at: z.string().nullable(),
}).passthrough();

export const EmailAccount = z.object({
  sid: z.string(),
  team_sid: z.string(),
  email_sending_domain_sid: z.string().nullable().describe('gtm_hosted only: the sending domain the mailbox is minted on.'),
  provider: EmailAccountProvider,
  address: z.string(),
  display_name: z.string().nullable(),
  aliases: z.array(z.string()).nullable().describe('Send-as addresses (google, microsoft); from_email of a send must be the address or one of these.'),
  status: EmailAccountStatus
    .describe('connecting: first sync running. active. reconnect_required: the provider refused the credential, sync and sending stopped. disconnected: detached, data kept. subscription_required: held, no free seat on its server.'),
  sending_paused_at: z.string().nullable().describe('Set while sending is paused; sync goes on.'),
  sending_paused_reason: EmailAccountSendingPausedReason.nullable()
    .describe('manual: a person or an agent. The rest are the platform\'s own; provider_quota lifts itself at sending_paused_until.'),
  connection: EmailAccountConnection.nullable(),
  sending_limits: EmailAccountSendingLimits,
  warmup_config: EmailAccountWarmupConfig,
  signature_html: z.string().nullable(),
  track_opens: z.boolean(),
  track_clicks: z.boolean(),
  email_tracking_domain_sid: z.string().nullable(),
  email_oauth_app_sid: z.string().nullable().describe("The team's sign-in application the grant came through; null: the platform's, or none."),
  backfill_days: z.number().int().describe('Days of history mirrored at connect.'),
  last_messages_sync_at: z.string().nullable(),
  last_folders_sync_at: z.string().nullable(),
  connected_at: z.string().nullable(),
  reconnect_required_at: z.string().nullable(),
  sync_config: z.record(z.unknown()).nullable().describe('Sync cadence per track: messages, folders, health_check.'),
  webhook_config: z.record(z.unknown()).nullable().describe('Which event families this mailbox emits: email-messages, email-threads, email-engagements, email-accounts, email-account-health.'),
  created_by: AccessIdentityValue.nullable(),
  sending_paused_until: z.string().nullable().describe('When a provider_quota pause lifts itself.'),
  reconnect_reason: z.string().nullable()
    .describe('Why it needs a reconnect: provider_auth_dead, imap_auth_failed, imap_app_password_required, imap_disabled, google_admin_blocked, provider_policy_blocked, scope_insufficient, mailbox_not_enabled, smtp_auth_rejected or smtp_web_login_required.'),
  email_box_sid: z.string().nullable().describe('The email server the mailbox lives on.'),
  label: z.string().nullable().describe("The customer's own tag."),
  address_domain: z.string().describe('The part of address after the @.'),
  sent_today: z.number().int().describe("Sends counted on the mailbox's current day; 0 once that day is over."),
  daily_cap_today: z.number().int().describe("Today's cap: the smaller of daily_limit and the warmup ramp."),
  warmup_day: z.number().int().nullable().describe('Day N of the ramp; null when warmup is off or done.'),
  auth_suspect: z.object({
    since: z.string(),
    failures: z.number().int(),
    next_try_at: z.string().nullable(),
    source: z.string().nullable(),
  }).passthrough().nullable()
    .describe('The provider is refusing the sign-in and the platform is still probing before it calls the mailbox dead. Null when the last sign-in was accepted.'),
  subscription_hold_reason: EmailAccountSubscriptionHoldReason.nullable()
    .describe('Why it is held: server_full (no free seat) or server_suspended (the server is not serving).'),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
  deleted_at: z.string().nullable(),
}).passthrough();

export const EmailAccountSyncRun = z.object({
  sid: z.string(),
  team_sid: z.string(),
  email_account_sid: z.string(),
  sync_type: EmailAccountSyncRunSyncType,
  sync_mode: EmailAccountSyncRunSyncMode,
  triggered_by: EmailAccountSyncRunTriggeredBy,
  next_cursor: z.string().nullable(),
  status: EmailAccountSyncRunStatus
    .describe('No failed state: a run that cannot go on is cancelled, and error_message says why.'),
  messages_upserted: z.number().int(),
  messages_deleted: z.number().int(),
  folders_synced: z.number().int(),
  pages_fetched: z.number().int(),
  last_progress_at: z.string().nullable(),
  next_attempt_at: z.string().nullable().describe('When a waiting run is tried again.'),
  wait_reason: EmailAccountSyncRunWaitReason.nullable(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  error_message: z.string().nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
}).passthrough();

export const EmailAccountActivityLog = z.object({
  sid: z.string(),
  team_sid: z.string(),
  email_account_sid: z.string().nullable(),
  email_message_sid: z.string().nullable().describe('The message a send-family row is about.'),
  email_account_sync_run_sid: z.string().nullable(),
  trace_id: z.string(),
  action_type: EmailAccountActivityLogActionType,
  status: EmailAccountActivityLogStatus.describe('pending only on a send attempt whose provider call is still out.'),
  target_address: z.string().nullable(),
  actor: AccessIdentityValue.nullable(),
  reason: z.string().nullable(),
  error_code: z.string().nullable(),
  error_message: z.string().nullable(),
  duration_ms: z.number().int().nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
  deleted_at: z.string().nullable(),
}).passthrough();

export const EmailFolder = z.object({
  sid: z.string(),
  team_sid: z.string(),
  email_account_sid: z.string(),
  provider_folder_id: z.string().describe('Gmail label id, Graph folder id or IMAP path.'),
  name: z.string(),
  role: EmailFolderRole,
  parent_email_folder_sid: z.string().nullable(),
  total_count: z.number().int().nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
  deleted_at: z.string().nullable(),
}).passthrough();

export const EmailThread = z.object({
  sid: z.string(),
  team_sid: z.string(),
  email_account_sid: z.string(),
  provider_thread_id: z.string().nullable(),
  subject_normalized: z.string().nullable().describe('The subject without Re: and Fwd: prefixes.'),
  participants: z.array(EmailParticipant),
  participants_count: z.number().int(),
  messages_count: z.number().int(),
  unread_count: z.number().int(),
  last_message_at: z.string().nullable(),
  last_inbound_at: z.string().nullable(),
  last_outbound_at: z.string().nullable(),
  has_unanswered_inbound: z.boolean().describe('The newest message of the thread is inbound: the ball is on our side.'),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
  deleted_at: z.string().nullable(),
}).passthrough();

export const EmailMessage = z.object({
  sid: z.string(),
  team_sid: z.string(),
  email_account_sid: z.string(),
  email_thread_sid: z.string(),
  internet_message_id: z.string().describe('RFC 5322 Message-ID.'),
  provider_message_id: z.string().nullable(),
  direction: EmailMessageDirection,
  status: EmailMessageStatus
    .describe('Inbound is always received. Outbound: scheduled, sending, sent or failed, and bounced once a bounce is matched.'),
  kind: EmailMessageKind.describe('bounce_notification is a bounce report stored as a mailbox row; searches leave it out by default.'),
  in_reply_to_email_message_sid: z.string().nullable(),
  bounce_type: EmailMessageBounceType.nullable(),
  bounce_code: z.string().nullable(),
  bounce_diagnostic: z.string().nullable(),
  from: EmailParticipant,
  to: z.array(EmailParticipant),
  cc: z.array(EmailParticipant),
  bcc: z.array(EmailParticipant),
  reply_to: z.array(EmailParticipant),
  subject: z.string().nullable(),
  snippet: z.string().nullable().describe('The first words of the text, for lists.'),
  is_body_synced: z.boolean().describe('false: the body is still at the provider; get_email_message fetches it.'),
  attachments: z.array(EmailAttachment).describe('Metadata only; the bytes come from get_email_message_attachment.'),
  has_attachments: z.boolean(),
  email_folder_sids: z.array(z.string()),
  folder_role: EmailFolderRole.nullable(),
  is_read: z.boolean(),
  client_reference: z.string().nullable().describe("The caller's own key of the message."),
  first_opened_at: z.string().nullable(),
  opens_count: z.number().int(),
  first_clicked_at: z.string().nullable(),
  clicks_count: z.number().int(),
  unsubscribed_at: z.string().nullable(),
  sent_at: z.string().nullable().describe('When it was sent or received; on a scheduled row, when it is due.'),
  scheduled_at: z.string().nullable(),
  created_by: AccessIdentityValue.nullable(),
  body_html: z.string().nullable().describe('As stored, not sanitized. Null in a search row unless include_bodies.'),
  body_text: z.string().nullable(),
  // As built the headers leave the backend as an object keyed by position
  // ({ "0": { name, value }, ... }): EmailMessageDomain lists the field among
  // its JSON maps while it holds a list. Both forms parse, so the day the
  // backend answers the list its docblock describes nothing here changes.
  headers: z.union([z.array(EmailHeader), z.record(EmailHeader)]).nullable()
    .describe('The stored headers, each { name, value }. Today an object keyed by position ("0", "1", ...), not an array.'),
  body_html_sanitized: z.string().nullable().describe('get_email_message with sanitize only: HTML safe to render, the quoted history marked data-quoted.'),
  body_text_unquoted: z.string().nullable().describe('get_email_message with sanitize only: the text above the first quote.'),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
  is_flagged: z.boolean(),
  is_answered: z.boolean(),
  deleted_at: z.string().nullable(),
}).passthrough();

export const EmailSuppression = z.object({
  sid: z.string(),
  team_sid: z.string(),
  address: z.string(),
  origin: EmailSuppressionOrigin.describe('Who put it on the stop-list: a person (manual), a bounce, an unsubscribe or a complaint.'),
  reason: z.string().nullable(),
  source_email_message_sid: z.string().nullable(),
  created_by: AccessIdentityValue.nullable(),
  deleted_by: AccessIdentityValue.nullable().describe('Who lifted it.'),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
  deleted_at: z.string().nullable().describe('When it was lifted; null while the address is stopped.'),
}).passthrough();

export const EmailBounceLog = z.object({
  sid: z.string(),
  team_sid: z.string(),
  email_account_sid: z.string(),
  kind: EmailBounceLogKind,
  recipient: z.string(),
  bounce_type: EmailMessageBounceType.nullable().describe('hard, soft or policy; null on a complaint.'),
  bounce_code: z.string().nullable().describe('RFC 3463 status, e.g. 5.1.1.'),
  diagnostic: z.string().nullable(),
  source: EmailBounceLogSource,
  email_message_sid: z.string().nullable().describe('The outbound message that bounced; null when none matched.'),
  ndr_email_message_sid: z.string().nullable().describe('The bounce report as a mailbox row.'),
  email_suppression_sid: z.string().nullable().describe('The stop-list row this event made, if it made one.'),
  occurred_at: z.string().nullable(),
  created_at: z.string().nullable(),
}).passthrough();

export const EmailEngagement = z.object({
  sid: z.string(),
  team_sid: z.string(),
  email_account_sid: z.string(),
  email_message_sid: z.string(),
  kind: EmailEngagementKind,
  url: z.string().nullable().describe('The link that was clicked; null on an open or an unsubscribe.'),
  ip: z.string().nullable(),
  user_agent: z.string().nullable(),
  is_bot_filtered: z.boolean().describe('true: a scanner or a mail proxy, not a person. Counters and default searches skip it.'),
  occurred_at: z.string().nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
  deleted_at: z.string().nullable(),
}).passthrough();

export const EmailTrackingDomain = z.object({
  sid: z.string(),
  team_sid: z.string(),
  domain: z.string(),
  status: EmailDomainVerificationStatus,
  dns_records: z.array(DnsRecord).describe('The CNAME to install, with what the last check saw.'),
  last_checked_at: z.string().nullable(),
  created_by: AccessIdentityValue.nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
  deleted_at: z.string().nullable(),
}).passthrough();

export const EmailSendingDomain = z.object({
  sid: z.string(),
  team_sid: z.string(),
  domain: z.string(),
  status: EmailDomainVerificationStatus,
  dns_records: z.array(DnsRecord).describe('The records to install (MX, SPF, DKIM, return path, DMARC), with what the last check saw.'),
  verified_at: z.string().nullable(),
  last_checked_at: z.string().nullable(),
  accounts_count: z.number().int().describe('Live mailboxes on the domain.'),
  created_by: AccessIdentityValue.nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
  deleted_at: z.string().nullable(),
}).passthrough();

export const EmailOauthApp = z.object({
  sid: z.string(),
  team_sid: z.string(),
  provider: EmailOauthAppProvider,
  name: z.string(),
  client_id: z.string(),
  microsoft_tenant: z.string().nullable(),
  callback_host: z.string().nullable().describe("The team's custom domain the provider redirects to; null: the platform's connect address."),
  google_pubsub_topic: z.string().nullable(),
  publishing_status: EmailOauthAppPublishingStatus,
  is_default: z.boolean().describe('Used by a connect that names no application.'),
  status: EmailOauthAppStatus.describe("What the last credential check at the provider said."),
  last_verified_at: z.string().nullable(),
  last_error_code: z.string().nullable().describe('invalid_client, unauthorized_client, tenant_not_found, unreachable or unknown.'),
  accounts_count: z.number().int().describe('Mailboxes connected through it.'),
  auth_kind: EmailOauthAppAuthKind
    .describe('oauth_client: each mailbox consents. service_account (google) and app_only (microsoft): one grant covers every mailbox, no consent.'),
  service_account_email: z.string().nullable(),
  created_by: AccessIdentityValue.nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
  deleted_at: z.string().nullable(),
}).passthrough();

export const EmailBoxSettingsDefaults = z.object({
  sending_window: EmailAccountSendingWindow.nullable(),
  daily_limit: z.number().int(),
  min_interval_seconds: z.number().int(),
  warmup_config: EmailAccountWarmupConfig,
  google_email_oauth_app_sid: z.string().nullable().describe('The sign-in application a Google connect on this server uses when the caller names none.'),
  microsoft_email_oauth_app_sid: z.string().nullable(),
});

export const EmailBoxSettings = z.object({
  email_box_sid: z.string(),
  defaults: EmailBoxSettingsDefaults.describe('What a new mailbox of the server starts with.'),
  alert_recipients: z.array(z.string()).describe("Addresses that hear the server's mailbox health mails beside the workspace's owner and admins."),
  updated_at: z.string().nullable().describe('Null while nobody has saved settings for the server: the values are the service defaults.'),
}).passthrough();

export const EmailDomain = z.object({
  domain: z.string(),
  provider: EmailAccountProvider.describe('The provider most mailboxes of the domain use.'),
  accounts_count: z.number().int(),
  dns: z.object({
    mx: EmailDomainDnsStatus,
    spf: EmailDomainDnsStatus,
    dkim: EmailDomainDnsStatus,
    dmarc: EmailDomainDnsStatus,
  }).passthrough().describe('The last public DNS reading per record; pending until the first lookup.'),
  dns_checked_at: z.string().nullable(),
  email_tracking_domain_sid: z.string().nullable(),
  tracking_host: z.string().nullable(),
}).passthrough();

// ─── shared result shapes ───────────────────────────────────────────────

/** One refused row of a per-row verb (bulk-create, bulk-update, bulk-action). */
export const RowError = z.object({
  code: z.string().describe('One of the platform error codes.'),
  reason: z.string().nullable().describe('The machine reason, as error.context.reason of the single verb.'),
  message: z.string(),
}).passthrough();
