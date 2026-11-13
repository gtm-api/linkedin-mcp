// Entity: Email Box Settings (gtm.service.email), "server settings" in the app
// Source of truth: product/research/gtm.service.email/entities/email_box_settings.md
// Format: registry v2. 4 tools: the settings of one email server (get, update,
// apply-defaults) and the machine facts of the server (GET /api/email-box, the
// research's custom row `machine`). Mounted on email.infrastructure.
//
// None of the four routes has a sid in its path: the row is the request's
// server, named by email_box_sid like on every email tool. The server's name,
// plan, seats and price are gtm.service.id's (search_email_boxes).
//
// apply-defaults overwrites the limits, the window and the ramp of every
// mailbox the server holds, in one call and with no way back to what each had,
// so it is behind the preview gate.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import { McpActionResponse, McpGetResponse, McpUpdateResponse } from '@gtm/mcp-shared';
import { EmailBoxSettings } from '../domains';
import { emailCommon, emailRoute, RO, SendingWindowInput, sid, WarmupConfigInput } from '../shared';

const EmailBoxInfo = z.object({
  email_box_sid: z.string().describe('The server that answered.'),
  release: z.string().nullable().describe('The release of the email service the server runs.'),
  disk: z.object({
    total_gb: z.number().nullable(),
    used_gb: z.number().nullable(),
  }).passthrough(),
  messages_count: z.number().int().nonnegative(),
  mailboxes_count: z.number().int().nonnegative(),
  last_update_at: z.string().nullable().describe('When the server was last updated.'),
}).passthrough();

const base = { service: 'email', entity: 'email_box_settings', mount: 'email.infrastructure' } as const;

export const emailBoxSettingsTools: ToolDefinition[] = [
  {
    ...base,
    name: 'get_email_box_settings',
    description:
      "Read the settings of an email server: defaults, what a mailbox connected on it starts with (daily limit, seconds between sends, the sending window, the warmup ramp, the sign-in application per provider), and alert_recipients, the extra addresses that hear its mailbox health mails. A server nobody has set up answers the service defaults with updated_at null. The server's name, plan, seats and price are search_email_boxes. Requires can_view_email_accounts.",
    toolClass: 'typical',
    route: emailRoute('GET', '/api/email-box-settings'),
    operation: 'get',
    envelope: 'get',
    availability: 'ga',
    dangerous: false,
    inputSchema: z.object({ ...emailCommon }),
    outputSchema: McpGetResponse(EmailBoxSettings),
    annotations: { title: 'Get email server settings', ...RO },
  },
  {
    ...base,
    name: 'update_email_box_settings',
    description:
      "Save the settings of an email server. defaults is partial: a key sent replaces, a key left out stays, and sending_window and warmup_config are replaced whole (sending_window null clears the window). alert_recipients replaces the whole list, so send the current addresses back with a new one. The defaults reach mailboxes connected from now on; the mailboxes the server already holds keep theirs until apply_email_box_settings_defaults. A sign-in application named here must be the team's, verified and of that provider. Requires can_update_email_accounts.",
    toolClass: 'typical',
    route: emailRoute('PATCH', '/api/email-box-settings'),
    operation: 'update',
    envelope: 'update',
    availability: 'ga',
    dangerous: false,
    inputSchema: z.object({
      defaults: z.object({
        sending_window: SendingWindowInput.nullable(),
        daily_limit: z.number().int().min(1).max(2000),
        min_interval_seconds: z.number().int().min(0).max(3600),
        warmup_config: WarmupConfigInput,
        google_email_oauth_app_sid: sid('em_oa_').nullable()
          .describe('The sign-in application a Google connect on this server uses when the caller names none.'),
        microsoft_email_oauth_app_sid: sid('em_oa_').nullable(),
      }).partial().optional().describe('What a new mailbox of the server starts with.'),
      alert_recipients: z.array(z.string().email().max(320)).max(20).optional()
        .describe('0 to 20 addresses; replaces the list.'),
      ...emailCommon,
    }),
    outputSchema: McpUpdateResponse(EmailBoxSettings),
    annotations: { title: 'Update email server settings', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    ...base,
    name: 'apply_email_box_settings_defaults',
    description:
      "Write an email server's defaults onto every mailbox it already holds: the daily limit, the interval and the sending window on each, and the warmup ramp on each except a hosted mailbox, which keeps its own. Whatever a mailbox had set by hand in those fields is replaced and cannot be brought back. result.applied is how many mailboxes were written. The pass is not one transaction: a mailbox that refuses the write stops it and the ones before it stay written. To change one mailbox use update_email_account. Through MCP the first call only previews. Requires can_update_email_accounts.",
    toolClass: 'typical',
    route: emailRoute('POST', '/api/email-box-settings/apply-defaults'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ ...emailCommon }),
    outputSchema: McpActionResponse(EmailBoxSettings, z.object({ applied: z.number().int().nonnegative() })),
    annotations: { title: 'Apply email server defaults to its mailboxes', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    ...base,
    name: 'get_email_box_machine',
    description:
      'Read what an email server says about itself: the release it runs, its disk (used of total), how many mailboxes and messages it holds, when it was last updated, and email_box_sid, the server that answered. Called without email_box_sid it tells which server is the primary one. Not the registry facts: name, plan, seats, status and price are search_email_boxes. Requires can_view_email_accounts.',
    toolClass: 'typical',
    route: emailRoute('GET', '/api/email-box'),
    operation: 'get',
    envelope: 'get',
    availability: 'ga',
    dangerous: false,
    inputSchema: z.object({ ...emailCommon }),
    outputSchema: McpGetResponse(EmailBoxInfo),
    annotations: { title: 'Get email server machine facts', ...RO },
  },
];
