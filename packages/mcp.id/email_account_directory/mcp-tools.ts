// Entity: Email Account Directory (gtm.service.id): every mailbox of a workspace across its email servers
// Source of truth: product/research/gtm.service.id/entities/email_account_directory.md
// Format: registry v2. One definition, REST only (surface api): a line in the public REST
// reference and in the coverage gate, served on no mount. Where the tool mounts is decided
// with the owner's open question on whether email tools name only the mailbox (research
// Decisions & deferrals; ADR 001 D13); serving it then is dropping `surface: 'api'` here and
// `**surface:** api` in the research block. Authored 2026-11-13 with the route (gtm.service.id
// branch mailbox-directory-2026-11-13).
//
// provider, status, subscription_hold_reason and sending_paused_reason are the email
// service's enums, which a server rolled ahead of id may extend: id keeps the strings as
// reported, so they are plain strings here with the known values in the description, and a
// value added later passes through instead of failing a whole page. The mount is metadata
// only while the surface is api.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import { filterOp, usageMetaField, McpSearchResponse } from '@gtm/mcp-shared';

// The full EmailAccountDirectoryDomain, in its order.
const EmailAccountDirectoryRow = z.object({
  sid: z.string().describe('The mailbox\'s own sid (em_ac_...), the one its server uses.'),
  team_sid: z.string(),
  email_box_sid: z.string().nullable()
    .describe('The email server that holds the mailbox (em_bx_...): the server to address any call about it. Null for a mailbox of the shared deployment that no server owns.'),
  provider: z.string().describe('google, microsoft, imap_smtp or gtm_hosted.'),
  address: z.string().describe('Lowercase.'),
  address_domain: z.string().describe('The part of the address after the @.'),
  display_name: z.string().nullable(),
  label: z.string().nullable().describe('The customer\'s own tag on the mailbox.'),
  status: z.string()
    .describe('connecting, active, reconnect_required, disconnected or subscription_required, as the server last reported it.'),
  reconnect_reason: z.string().nullable().describe('Why the mailbox needs reconnecting, while status is reconnect_required.'),
  subscription_hold_reason: z.string().nullable()
    .describe('server_full or server_suspended, while status is subscription_required.'),
  sending_paused_reason: z.string().nullable()
    .describe('manual, bounce_rate, complaint_rate, provider_block, warmup_guard or provider_quota. Null: sending is not paused, though a status other than active still keeps the mailbox from sending.'),
  connected_at: z.string().nullable(),
  status_changed_at: z.string().describe('When the current status was first reported.'),
  observed_at: z.string().describe('The server\'s clock at the read this copy is from: how fresh the row is.'),
  created_at: z.string().nullable().describe('The mailbox\'s own creation time.'),
  updated_at: z.string().nullable().describe('The last change of this copy.'),
  deleted_at: z.string().nullable(),
}).passthrough();

const EmailAccountDirectoryCounts = z.object({
  total_count: z.number().int().nonnegative(),
  groups: z.record(z.unknown())
    .describe('Per axis (email_box_sid, status, provider, subscription_hold_reason, sending_paused_reason) a map value to count, over the whole filter. A null value is in no group.'),
}).passthrough();

const EmailAccountDirectoryFilter = z.object({
  q: z.string().min(2).max(100).optional()
    .describe('A part of the address, the display name or the label, 2 to 100 characters.'),
  sid: filterOp(z.string(), ['eq', 'in']).optional(),
  email_box_sid: filterOp(z.string(), ['eq', 'in', 'is_null']).optional()
    .describe('One server\'s mailboxes.'),
  provider: filterOp(z.string(), ['eq', 'in']).optional(),
  status: filterOp(z.string(), ['eq', 'ne', 'in', 'nin']).optional(),
  subscription_hold_reason: filterOp(z.string(), ['eq', 'in', 'is_null']).optional(),
  address: filterOp(z.string(), ['eq', 'in']).optional().describe('The whole address; a part of it goes in q.'),
  address_domain: filterOp(z.string(), ['eq', 'in']).optional(),
  label: filterOp(z.string(), ['eq', 'in', 'is_null']).optional(),
  sending_paused_reason: filterOp(z.string(), ['eq', 'in', 'is_null']).optional()
    .describe('is_null false: every mailbox whose sending is paused.'),
  connected_at: filterOp(z.string(), ['gte', 'lte', 'is_null']).optional(),
  status_changed_at: filterOp(z.string(), ['gte', 'lte']).optional(),
  created_at: filterOp(z.string(), ['gte', 'lte']).optional(),
}).partial();

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const base = {
  service: 'id',
  entity: 'email_account_directory',
  mount: 'id.platform',
} as const;

export const emailAccountDirectoryTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_email_account_directory',
    description:
      "List every mailbox of the workspace across its email servers: address, the server that holds it (email_box_sid), provider, status and its reason, sending pause, label. counts.groups splits the whole filter by server, status, provider, hold reason and pause. Read from id's directory, so a server that is down keeps its mailboxes listed. Sent today, limits and health stay on the mailbox's own server. page_size 0 counts only. Requires can_view_email_accounts.",
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/email-account-directory/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    surface: 'api',
    inputSchema: z.object({
      filter: EmailAccountDirectoryFilter.optional(),
      sort: z.object({
        field: z.enum(['address', 'label', 'status_changed_at', 'connected_at', 'created_at']),
        direction: z.enum(['asc', 'desc']).optional(),
      }).optional().describe('Default address, ascending. No label and no connected_at come first ascending, last descending.'),
      page_size: z.number().int().min(0).max(500).optional()
        .describe('0..500, default 50. 0 = counts only.'),
      cursor: z.string().optional().describe('pagination.next_cursor of the previous page.'),
      ...usageMetaField,
    }),
    outputSchema: McpSearchResponse(EmailAccountDirectoryRow, undefined, EmailAccountDirectoryCounts),
    annotations: { title: 'Search mailbox directory', ...RO },
  },
];
