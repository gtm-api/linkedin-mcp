// Entity: Email Tracking Domain (gtm.service.email)
// Source of truth: product/research/gtm.service.email/entities/email_tracking_domains.md
// Format: registry v2. 4 tools (the email-tracking-domains route group: no get,
// no update: a domain is immutable, a wrong one is deleted and made again).
// Mounted on email.infrastructure.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  McpActionResponse,
  McpCreateResponse,
  McpSearchResponse,
  McpSimpleDeleteResponse,
} from '@gtm/mcp-shared';
import { EmailDomainVerificationStatus, EmailTrackingDomain } from '../domains';
import { emailCommon, emailRoute, oneOf, RO, searchInput, sid, str, when } from '../shared';

const EmailTrackingDomainFilter = z.object({
  sid: str(['eq', 'in']),
  domain: str(['eq', 'in']).describe('Exact hostname, lowercase.'),
  status: oneOf(EmailDomainVerificationStatus).describe('{ ne: verified } is what needs attention.'),
  q: z.string().optional().describe('Part of a hostname.'),
  last_checked_at: when(['gte', 'lte', 'is_null']),
  created_at: when(['gte', 'lte']),
  deleted_at: when(['is_null']),
}).partial();

const EmailTrackingDomainCounts = z.object({
  total_count: z.number().int(),
  groups: z.object({ status: z.record(z.number()) }).partial().passthrough(),
}).passthrough();

const base = { service: 'email', entity: 'email_tracking_domains', mount: 'email.infrastructure' } as const;

export const emailTrackingDomainsTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_email_tracking_domains',
    description:
      "List the team's tracking domains: the customer's own hostnames that open pixels, rewritten links and unsubscribe links of sent mail point at. Each row carries status (pending, verified, failed) and dns_records, the CNAME to install with what the last check saw. Use it to find a verified domain before binding it to a mailbox (update_email_account, email_tracking_domain_sid) and to see which ones need attention (status ne verified). Requires can_view_email_tracking_domains.",
    toolClass: 'typical',
    route: emailRoute('POST', '/api/email-tracking-domains/search'),
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    inputSchema: searchInput(EmailTrackingDomainFilter, z.enum(['created_at', 'domain', 'last_checked_at'])),
    outputSchema: McpSearchResponse(EmailTrackingDomain, undefined, EmailTrackingDomainCounts),
    annotations: { title: 'Search email tracking domains', ...RO },
  },
  {
    ...base,
    name: 'create_email_tracking_domain',
    description:
      'Register a hostname for open, click and unsubscribe tracking and get the CNAME record to install (item.dns_records). The hostname must be a subdomain, e.g. link.acme.com: a CNAME cannot sit at the top of a zone. The row starts pending and nothing is checked yet: have the record installed, then call verify_email_tracking_domain_dns. A hostname the team already registered is answered as it is (already_exists). Requires can_manage_email_tracking_domains.',
    toolClass: 'typical',
    route: emailRoute('POST', '/api/email-tracking-domains'),
    operation: 'create',
    envelope: 'create',
    availability: 'ga',
    dangerous: false,
    inputSchema: z.object({
      domain: z.string().min(4).max(255).describe('The tracking hostname, a subdomain such as link.acme.com.'),
      ...emailCommon,
    }),
    outputSchema: McpCreateResponse(EmailTrackingDomain),
    annotations: { title: 'Create email tracking domain', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    ...base,
    name: 'delete_email_tracking_domain',
    description:
      'Remove a tracking domain. Refused with 409 delete_blocked while a mailbox is bound to it (error.blockers names them): unbind each with update_email_account first. The engagement history it collected stays. Repeating it is safe. Through MCP the first call only previews. Requires can_manage_email_tracking_domains.',
    toolClass: 'typical',
    route: emailRoute('DELETE', '/api/email-tracking-domains/{sid}'),
    operation: 'delete',
    envelope: 'delete_simple',
    availability: 'ga',
    dangerous: true,
    inputSchema: z.object({ sid: sid('em_td_'), ...emailCommon }),
    outputSchema: McpSimpleDeleteResponse,
    annotations: { title: 'Delete email tracking domain', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    ...base,
    name: 'verify_email_tracking_domain_dns',
    description:
      "Check a tracking domain's DNS record now, against public DNS, and answer the refreshed row: item.status and, per record in item.dns_records, what was seen; result.previous_status is what it was before. Use it after the CNAME was installed or to see why a domain is still pending or failed (the invalid record names the host and value to fix). A valid record is not enough: once it is in place the host itself is asked, and the domain turns verified only when the host serves the tracking links. A domain whose record reads valid and that stays pending waits on its host: result.host_served is false, result.host_reason says why (host_no_address, host_not_public, host_no_certificate, host_not_routed, host_did_not_answer) and result.host_message says it in words; null means the host was not asked or the look did not complete. DNS takes time to spread, so do not call it in a loop: a daily check moves the status by itself. Requires can_manage_email_tracking_domains.",
    toolClass: 'typical',
    route: emailRoute('POST', '/api/email-tracking-domains/{sid}/verify-dns'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: sid('em_td_'), ...emailCommon }),
    outputSchema: McpActionResponse(
      EmailTrackingDomain,
      z.object({
        previous_status: EmailDomainVerificationStatus,
        host_served: z.boolean().nullable().describe('Whether the host answered the tracking links with this server\'s own proof; null when it was not asked (the record is not in place) or the look did not complete.'),
        host_reason: z.string().nullable().describe('Why the host does not serve them, as a token: host_no_address, host_not_public, host_no_certificate, host_not_routed or host_did_not_answer; null when it serves them or was not asked.'),
        host_message: z.string().nullable().describe('The same reason in words, for a person.'),
      }),
    ),
    annotations: { title: 'Verify email tracking domain DNS', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
];
