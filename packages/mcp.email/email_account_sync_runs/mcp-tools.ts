// Entity: Email Account Sync Run (gtm.service.email)
// Source of truth: product/research/gtm.service.email/entities/email_account_sync_runs.md
// Format: registry v2. 1 tool: a run is written by the sync engine alone; the
// one write that starts a run is sync_email_account on the mailbox. Mounted on
// email.accounts, beside the verb whose answer names a run to poll here.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import { McpSearchResponse } from '@gtm/mcp-shared';
import {
  EmailAccount,
  EmailAccountSyncRun,
  EmailAccountSyncRunStatus,
  EmailAccountSyncRunSyncMode,
  EmailAccountSyncRunSyncType,
  EmailAccountSyncRunTriggeredBy,
} from '../domains';
import { emailRoute, oneOf, RO, searchInput, str, when } from '../shared';

const EmailAccountSyncRunFilter = z.object({
  sid: str(['eq', 'in']).describe('One run by sid: how a forced sync is polled.'),
  email_account_sid: str(['eq', 'in']),
  sync_type: oneOf(EmailAccountSyncRunSyncType, ['eq', 'in']),
  sync_mode: oneOf(EmailAccountSyncRunSyncMode, ['eq']).describe('initial: the first import of a mailbox.'),
  triggered_by: oneOf(EmailAccountSyncRunTriggeredBy, ['eq', 'in']),
  status: oneOf(EmailAccountSyncRunStatus, ['eq', 'in']).describe('{ in: [pending, in_progress] } is what is still syncing.'),
  started_at: when(['gte', 'lte']),
  finished_at: when(['gte', 'lte', 'is_null']),
  created_at: when(['gte', 'lte']),
}).partial();

const EmailAccountSyncRunIncluded = z.object({
  email_account: EmailAccount.nullable(),
}).partial();

const EmailAccountSyncRunCounts = z.object({
  total_count: z.number().int(),
  groups: z.object({ status: z.record(z.number()), sync_mode: z.record(z.number()) }).partial().passthrough(),
}).passthrough();

const base = { service: 'email', entity: 'email_account_sync_runs', mount: 'email.accounts' } as const;

export const emailAccountSyncRunsTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_email_account_sync_runs',
    description:
      "List the sync runs of the team's mailboxes: one run is one drain of a mailbox's messages or folders, with its status (pending, in_progress, completed, cancelled; there is no failed), its counters and, while it waits, wait_reason and next_attempt_at. Use it to poll the run sync_email_account started (filter sid, page_size 1, until completed or cancelled), to see what is still syncing or how far the first import of a new mailbox is (sync_mode initial, messages_upserted), and why data is stale. A cancelled run says why in error_message; auth_dead means the mailbox needs a reconnect. Not for how fresh a mailbox is: read last_messages_sync_at on the mailbox. Requires can_view_email_accounts.",
    toolClass: 'typical',
    route: emailRoute('POST', '/api/email-account-sync-runs/search'),
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    inputSchema: searchInput(
      EmailAccountSyncRunFilter,
      z.enum(['created_at', 'started_at', 'finished_at', 'last_progress_at']),
      z.enum(['email_account']),
    ),
    outputSchema: McpSearchResponse(EmailAccountSyncRun, EmailAccountSyncRunIncluded, EmailAccountSyncRunCounts),
    annotations: { title: 'Search email account sync runs', ...RO },
  },
];
