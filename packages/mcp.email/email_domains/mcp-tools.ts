// Entity: Email Domain (gtm.service.email), a sender domain
// Source of truth: product/research/gtm.service.email/entities/email_domains.md
// Format: registry v2. 2 tools (the email-domains route group). The list is
// read off the mailboxes' addresses, never registered: nothing creates or
// deletes a row here. Mounted on email.infrastructure.
//
// The search route declares a filter and nothing else (no sort, page_size,
// cursor or include): the whole list is one page.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import { McpActionResponse, McpSearchResponse } from '@gtm/mcp-shared';
import { EmailDomain } from '../domains';
import { emailCommon, emailRoute, RO } from '../shared';

const domainName = z.string().max(255);

const EmailDomainFilter = z.object({
  domain: z.object({
    eq: domainName,
    in: z.array(domainName).min(1).max(200),
  }).partial().strict().optional().describe('One domain, or up to 200.'),
}).partial();

const base = { service: 'email', entity: 'email_domains', mount: 'email.infrastructure' } as const;

export const emailDomainsTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_email_domains',
    description:
      "List the domains the workspace's connected mailboxes send from, each with what public DNS says about it (dns: mx, spf, dkim, dmarc), how many mailboxes are on it, the provider most of them use and the tracking host most of them are bound to. A slot reads valid, invalid, missing, pending (not looked up yet) or na (dkim: the selector cannot be guessed from outside). Use it for whether the sender domains are set up to send; the list is one page and follows the mailboxes, nothing is registered here. Not for domains the platform hosts mail on (search_email_sending_domains) or tracking hosts (search_email_tracking_domains). Requires can_view_email_accounts.",
    toolClass: 'typical',
    route: emailRoute('POST', '/api/email-domains/search'),
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    inputSchema: z.object({ filter: EmailDomainFilter.optional(), ...emailCommon }),
    outputSchema: McpSearchResponse(EmailDomain),
    annotations: { title: 'Search email sender domains', ...RO },
  },
  {
    ...base,
    name: 'check_email_domain_dns',
    description:
      "Look up the public DNS of one sender domain now and answer it with the fresh reading (item.dns: mx, spf, dkim, dmarc). Use it right after a record was added or changed; otherwise the reading refreshes by itself every six hours. The DKIM selectors asked for are those of the provider most mailboxes of the domain use. 404 for a domain none of the workspace's mailboxes is on. Requires can_view_email_accounts.",
    toolClass: 'typical',
    route: emailRoute('POST', '/api/email-domains/check-dns'),
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      domain: domainName.regex(/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/).describe('The sender domain, e.g. acme.com.'),
      ...emailCommon,
    }),
    outputSchema: McpActionResponse(EmailDomain, z.object({}).passthrough()),
    annotations: { title: 'Check email sender domain DNS', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
];
