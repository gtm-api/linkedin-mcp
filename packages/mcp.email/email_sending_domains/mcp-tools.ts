// Entity: Email Sending Domain (gtm.service.email)
// Source of truth: product/research/gtm.service.email/entities/email_sending_domains.md
// Format: registry v2. 4 tools (the email-sending-domains route group: no get,
// no update). Mounted on email.infrastructure.
//
// A sending domain carries mailboxes the platform hosts itself (provider
// gtm_hosted). Connected mailboxes (google, microsoft, imap_smtp) involve none:
// their own domains and DNS are search_email_domains.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  filterOp,
  McpActionResponse,
  McpCreateResponse,
  McpSearchResponse,
  McpSimpleDeleteResponse,
} from '@gtm/mcp-shared';
import { EmailDomainVerificationStatus, EmailSendingDomain } from '../domains';
import { emailCommon, emailRoute, oneOf, RO, searchInput, sid, str, when } from '../shared';

const EmailSendingDomainFilter = z.object({
  sid: str(['eq', 'in']),
  domain: str(['eq', 'in']).describe('Exact domain, lowercase.'),
  status: oneOf(EmailDomainVerificationStatus).describe('{ eq: verified }: domains a hosted mailbox can be made on.'),
  q: z.string().optional().describe('Part of a domain.'),
  accounts_count: filterOp(z.number().int().nonnegative(), ['eq', 'gte', 'lte']).optional()
    .describe('{ eq: 0 }: domains with no mailbox.'),
  verified_at: when(['gte', 'lte', 'is_null']),
  last_checked_at: when(['gte', 'lte', 'is_null']),
  created_at: when(['gte', 'lte']),
  deleted_at: when(['is_null']),
}).partial();

const EmailSendingDomainCounts = z.object({
  total_count: z.number().int(),
  groups: z.object({ status: z.record(z.number()) }).partial().passthrough(),
}).passthrough();

const base = { service: 'email', entity: 'email_sending_domains', mount: 'email.infrastructure' } as const;

export const emailSendingDomainsTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_email_sending_domains',
    description:
      "List the team's sending domains: domains set up so the platform itself hosts mailboxes on them (provider gtm_hosted), each with status (pending, verified, failed), dns_records (what to install and what the last check saw) and accounts_count. Use it to find a verified domain, to see which need DNS attention (status ne verified) and which hold no mailbox (accounts_count eq 0). Not for the domains of connected Google, Microsoft or IMAP mailboxes: those are search_email_domains. Requires can_view_email_sending_domains.",
    toolClass: 'typical',
    route: emailRoute('POST', '/api/email-sending-domains/search'),
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    inputSchema: searchInput(
      EmailSendingDomainFilter,
      z.enum(['created_at', 'domain', 'verified_at', 'accounts_count', 'last_checked_at']),
    ),
    outputSchema: McpSearchResponse(EmailSendingDomain, undefined, EmailSendingDomainCounts),
    annotations: { title: 'Search email sending domains', ...RO },
  },
  {
    ...base,
    name: 'create_email_sending_domain',
    description:
      'Register a domain for mailboxes the platform hosts itself and get the DNS records to install (item.dns_records: MX, SPF, DKIM, return path, DMARC). A top-level domain or a subdomain both work. The row starts pending and nothing is checked yet: have the records installed, then call verify_email_sending_domain_dns. A domain the team already registered is answered as it is (already_exists). Requires can_manage_email_sending_domains.',
    toolClass: 'typical',
    route: emailRoute('POST', '/api/email-sending-domains'),
    operation: 'create',
    envelope: 'create',
    availability: 'ga',
    dangerous: false,
    inputSchema: z.object({
      domain: z.string().min(4).max(255).describe('The domain mailboxes will be hosted on, e.g. try-acme.com.'),
      ...emailCommon,
    }),
    outputSchema: McpCreateResponse(EmailSendingDomain),
    annotations: { title: 'Create email sending domain', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    ...base,
    name: 'delete_email_sending_domain',
    description:
      'Remove a sending domain. Refused with 409 delete_blocked while a hosted mailbox lives on it (error.blockers names them): delete those mailboxes first. Its bounce history and stop-list rows stay. Repeating it is safe. Through MCP the first call only previews. Requires can_manage_email_sending_domains.',
    toolClass: 'typical',
    route: emailRoute('DELETE', '/api/email-sending-domains/{sid}'),
    operation: 'delete',
    envelope: 'delete_simple',
    availability: 'ga',
    dangerous: true,
    inputSchema: z.object({ sid: sid('em_sd_'), ...emailCommon }),
    outputSchema: McpSimpleDeleteResponse,
    annotations: { title: 'Delete email sending domain', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    ...base,
    name: 'verify_email_sending_domain_dns',
    description:
      "Check a sending domain's DNS records now, against public DNS, and answer the refreshed row: item.status and, per record in item.dns_records, what was seen; result.previous_status is what it was before. Use it after the records were installed or to see which record is wrong (the invalid one names the host and value to fix). DNS takes time to spread, so do not call it in a loop: a daily check moves the status by itself. Requires can_manage_email_sending_domains.",
    toolClass: 'typical',
    route: emailRoute('POST', '/api/email-sending-domains/{sid}/verify-dns'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: sid('em_sd_'), ...emailCommon }),
    outputSchema: McpActionResponse(EmailSendingDomain, z.object({ previous_status: EmailDomainVerificationStatus })),
    annotations: { title: 'Verify email sending domain DNS', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
];
