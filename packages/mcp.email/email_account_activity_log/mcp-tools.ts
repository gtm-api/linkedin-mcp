// Entity: Email Account Activity Log (gtm.service.email)
// Source of truth: product/research/gtm.service.email/entities/email_account_activity_log.md
// Format: registry v2. 1 tool: the log is append-only and written by the
// service alone. Mounted on email.accounts.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import { filterOp, McpSearchResponse } from '@gtm/mcp-shared';
import {
  EmailAccount,
  EmailAccountActivityLog,
  EmailAccountActivityLogActionType,
  EmailAccountActivityLogStatus,
  EmailAccountSyncRun,
} from '../domains';
import { emailRoute, oneOf, RO, searchInput, str, when } from '../shared';

const EmailAccountActivityLogFilter = z.object({
  sid: str(['eq', 'in']),
  email_account_sid: str(['eq', 'in', 'is_null']),
  trace_id: str(['eq', 'in']).describe('The trace id of the request or job that wrote the row.'),
  action_type: oneOf(EmailAccountActivityLogActionType),
  status: oneOf(EmailAccountActivityLogStatus).describe('pending: a send attempt whose provider call is still out.'),
  error_code: str(['eq', 'in', 'is_null']),
  target_address: str(['eq', 'in', 'is_null'])
    .describe("Lowercase, exact. The recipient on suppression_skip and suppression_override rows, the mailbox's own address on the rest."),
  email_message_sid: str(['eq', 'in', 'is_null']),
  email_account_sync_run_sid: str(['eq', 'in', 'is_null']),
  duration_ms: filterOp(z.number().int(), ['eq', 'ne', 'gte', 'lte', 'gt', 'lt', 'is_null']).optional(),
  created_at: when(),
  updated_at: when(),
  deleted_at: when(['is_null', 'gte', 'lte']),
}).partial();

const EmailAccountActivityLogIncluded = z.object({
  email_account: EmailAccount.nullable(),
  sync_run: EmailAccountSyncRun.nullable(),
}).partial();

const EmailAccountActivityLogCounts = z.object({
  total_count: z.number().int(),
  groups: z.object({ action_type: z.record(z.number()), status: z.record(z.number()) }).partial().passthrough(),
}).passthrough();

const base = { service: 'email', entity: 'email_account_activity_log', mount: 'email.accounts' } as const;

export const emailAccountActivityLogTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_email_account_activity_log',
    description:
      "List the audit rows of the team's mailboxes, one per operation: send attempts and enqueues, stop-list skips and overrides, connects, reconnects, disconnects, deletes, pauses and resumes, forced syncs, OAuth refreshes and push renewals, each with its status, error_code and the actor. Use it for why a send failed (filter email_message_sid, action_type send_attempt), who paused, disconnected or deleted a mailbox, why a mailbox needs a reconnect (failed oauth_refresh rows) and who was stripped from a send (suppression_skip, target_address the recipient). Not for sync progress (search_email_account_sync_runs), bounces (search_email_bounce_log) or whether a send in doubt left (check_email_message_sent). Requires can_view_email_accounts.",
    toolClass: 'typical',
    route: emailRoute('POST', '/api/email-account-activity-log/search'),
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    inputSchema: searchInput(
      EmailAccountActivityLogFilter,
      z.enum(['created_at', 'duration_ms']),
      z.enum(['email_account', 'sync_run']),
    ),
    outputSchema: McpSearchResponse(EmailAccountActivityLog, EmailAccountActivityLogIncluded, EmailAccountActivityLogCounts),
    annotations: { title: 'Search email account activity log', ...RO },
  },
];
