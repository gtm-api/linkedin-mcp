import type { ToolPackage } from '@gtm/mcp-runtime/types';
import { emailAccountsTools } from './email_accounts/mcp-tools';
import { emailAccountSyncRunsTools } from './email_account_sync_runs/mcp-tools';
import { emailAccountActivityLogTools } from './email_account_activity_log/mcp-tools';
import { emailAccountHealthTools } from './email_account_health/mcp-tools';
import { emailBoxSettingsTools } from './email_box_settings/mcp-tools';
import { emailOauthAppsTools } from './email_oauth_apps/mcp-tools';
import { emailDomainsTools } from './email_domains/mcp-tools';
import { emailTrackingDomainsTools } from './email_tracking_domains/mcp-tools';
import { emailSendingDomainsTools } from './email_sending_domains/mcp-tools';
import { emailMessagesTools } from './email_messages/mcp-tools';
import { emailThreadsTools } from './email_threads/mcp-tools';
import { emailFoldersTools } from './email_folders/mcp-tools';
import { emailSuppressionsTools } from './email_suppressions/mcp-tools';
import { emailBounceLogTools } from './email_bounce_log/mcp-tools';
import { emailEngagementsTools } from './email_engagements/mcp-tools';

export { EMAIL_BOX_HEADER } from './shared';

const pkg = (entity: string, tools: ToolPackage['tools']): ToolPackage => ({
  id: `mcp.email/${entity}`,
  service: 'email',
  entity,
  tools,
});

// One ToolPackage per entity of gtm.service.email, in the order of its four
// mounts (accounts, infrastructure, messaging, deliverability); mounts
// (apps/worker/src/mounts.config.ts) select by each tool's `mount`. See
// PACKAGES.md.
export const emailPackages: ToolPackage[] = [
  pkg('email_accounts', emailAccountsTools),
  pkg('email_account_sync_runs', emailAccountSyncRunsTools),
  pkg('email_account_activity_log', emailAccountActivityLogTools),
  pkg('email_account_health', emailAccountHealthTools),
  pkg('email_box_settings', emailBoxSettingsTools),
  pkg('email_oauth_apps', emailOauthAppsTools),
  pkg('email_domains', emailDomainsTools),
  pkg('email_tracking_domains', emailTrackingDomainsTools),
  pkg('email_sending_domains', emailSendingDomainsTools),
  pkg('email_messages', emailMessagesTools),
  pkg('email_threads', emailThreadsTools),
  pkg('email_folders', emailFoldersTools),
  pkg('email_suppressions', emailSuppressionsTools),
  pkg('email_bounce_log', emailBounceLogTools),
  pkg('email_engagements', emailEngagementsTools),
];
