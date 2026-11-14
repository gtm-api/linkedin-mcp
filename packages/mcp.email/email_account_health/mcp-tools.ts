// Entity: Email Account Health (gtm.service.email)
// Source of truth: product/research/gtm.service.email/entities/email_account_health.md
// Format: registry v2. 1 tool: a snapshot is written by the health job alone.
// The latest snapshot of a mailbox rides search_email_accounts and
// get_email_account (include health); this tool is the history and the fleet
// triage. Mounted on email.accounts.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import { filterOp, McpSearchResponse } from '@gtm/mcp-shared';
import { EmailAccountHealth, EmailAccountHealthWarmupLevel } from '../domains';
import { emailRoute, oneOf, RO, searchInput, str, when } from '../shared';

const EmailAccountHealthFilter = z.object({
  sid: str(['eq', 'in']),
  email_account_sid: str(['eq', 'in']).describe("One mailbox's history."),
  health_score: filterOp(z.number().int().min(0).max(100), ['eq', 'ne', 'gte', 'lte', 'gt', 'lt']).optional()
    .describe('{ lt: 50 } is the at-risk band.'),
  warmup_level: oneOf(EmailAccountHealthWarmupLevel),
  bounce_rate_30d: filterOp(z.number().min(0).max(1), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional()
    .describe('0 to 1. { is_null: true }: nothing sent in the 30 days.'),
  created_at: when().describe('When the snapshot was taken.'),
  deleted_at: when(['is_null', 'gte', 'lte']),
}).partial();

const EmailAccountHealthCounts = z.object({
  total_count: z.number().int(),
  groups: z.record(z.unknown()),
}).passthrough();

const base = { service: 'email', entity: 'email_account_health', mount: 'email.accounts' } as const;

export const emailAccountHealthTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_email_account_health',
    description:
      "List the health snapshots of the team's mailboxes: health_score (0 to 100), warmup_level, sent and bounce, complaint, reply and open rates of the last 30 days, the DNS state and tips (what to fix, worst first). Each row is one capture, so a mailbox has a history. Use it for which mailboxes are at risk (health_score lt 50, sort health_score asc) and how one mailbox moved over time (email_account_sid with a created_at range). For the latest snapshot of a mailbox use get_email_account or search_email_accounts with include health; for the bounces behind a rate, search_email_bounce_log. A snapshot is taken on a schedule and cannot be forced. Requires can_view_email_accounts.",
    toolClass: 'typical',
    route: emailRoute('POST', '/api/email-account-health/search'),
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    inputSchema: searchInput(EmailAccountHealthFilter, z.enum(['created_at', 'health_score'])),
    outputSchema: McpSearchResponse(EmailAccountHealth, undefined, EmailAccountHealthCounts),
    annotations: { title: 'Search email account health', ...RO },
  },
];
