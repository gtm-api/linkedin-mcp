// Entity: Email Folder (gtm.service.email)
// Source of truth: product/research/gtm.service.email/entities/email_folders.md
// Format: registry v2. 1 tool: the folder and label map of a mailbox is a
// read-only mirror the sync writes; a message moves through
// update_email_message, never through a folder. Mounted on email.messaging.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import { McpSearchResponse } from '@gtm/mcp-shared';
import { EmailAccount, EmailFolder, EmailFolderRole } from '../domains';
import { emailRoute, oneOf, RO, searchInput, str, when } from '../shared';

const EmailFolderFilter = z.object({
  sid: str(['eq', 'in']),
  email_account_sid: str(['eq', 'in']).describe("One mailbox's folders: the usual scope."),
  role: oneOf(EmailFolderRole),
  created_at: when(),
  updated_at: when(),
  deleted_at: when(['is_null', 'gte', 'lte']).describe('Default: live folders. { is_null: false } shows the ones that disappeared at the provider.'),
}).partial();

const EmailFolderIncluded = z.object({
  email_account: EmailAccount.nullable(),
}).partial();

const EmailFolderCounts = z.object({
  total_count: z.number().int(),
  groups: z.object({ role: z.record(z.number()) }).partial().passthrough(),
}).passthrough();

const base = { service: 'email', entity: 'email_folders', mount: 'email.messaging' } as const;

export const emailFoldersTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_email_folders',
    description:
      "List the folders and labels of the team's mailboxes with their role (inbox, sent, drafts, trash, spam, archive, starred, important, custom). Use it to turn a role or a name into a folder sid before filtering messages by folder or moving one with update_email_message: filter email_account_sid and role, page_size 1; a custom label is matched by name on the client, one page holds a mailbox's whole map. Gmail labels are flat, Graph and IMAP folders nest by parent_email_folder_sid. total_count is the provider's item count, not unread. Read only: folders cannot be created, renamed or deleted here. Requires can_view_email_messages.",
    toolClass: 'typical',
    route: emailRoute('POST', '/api/email-folders/search'),
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    inputSchema: searchInput(EmailFolderFilter, z.enum(['name', 'created_at', 'updated_at']), z.enum(['email_account'])),
    outputSchema: McpSearchResponse(EmailFolder, EmailFolderIncluded, EmailFolderCounts),
    annotations: { title: 'Search email folders', ...RO },
  },
];
