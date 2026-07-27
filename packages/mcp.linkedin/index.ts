import type { ToolPackage } from '@gtm/mcp-runtime/types';
import { linkedinAccountsTools } from './linkedin_accounts/mcp-tools';
import { linkedinAccountSmartLimitsTools } from './linkedin_account_smart_limits/mcp-tools';
import { linkedinAccountSnapshotsTools } from './linkedin_account_snapshots/mcp-tools';
import { linkedinBenchmarksTools } from './linkedin_benchmarks/mcp-tools';
import { linkedinAccountQuotaHitsTools } from './linkedin_account_quota_hits/mcp-tools';
import { linkedinAccountBlockLogTools } from './linkedin_account_block_log/mcp-tools';
import { linkedinAccountActivityLogTools } from './linkedin_account_activity_log/mcp-tools';
import { linkedinAccountSyncRunsTools } from './linkedin_account_sync_runs/mcp-tools';
import { linkedinConversationsTools } from './linkedin_conversations/mcp-tools';
import { linkedinMessagesTools } from './linkedin_messages/mcp-tools';
import { linkedinConnectionsTools } from './linkedin_connections/mcp-tools';
import { linkedinConnectionRequestsTools } from './linkedin_connection_requests/mcp-tools';
import { linkedinConnectionInvitationsTools } from './linkedin_connection_invitations/mcp-tools';
import { linkedinFollowersTools } from './linkedin_followers/mcp-tools';
import { linkedinPostingTools } from './linkedin_posting/mcp-tools';
import { linkedinScrapingTools } from './linkedin_scraping/mcp-tools';
import { linkedinAutoScrapesTools } from './linkedin_auto_scrapes/mcp-tools';
import { linkedinAutoScrapeRunsTools } from './linkedin_auto_scrape_runs/mcp-tools';
import { linkedinAutoScrapeResultsTools } from './linkedin_auto_scrape_results/mcp-tools';
import { linkedinCustomRequestsTools } from './linkedin_custom_requests/mcp-tools';
import { linkedinEnrichmentTools } from './linkedin_enrichment/mcp-tools';
import { dataRequestsTools } from './data_requests/mcp-tools';
import { antidetectBrowsersTools } from './antidetect_browsers/mcp-tools';
import { antidetectBrowserProxiesTools } from './antidetect_browser_proxies/mcp-tools';
import { antidetectBrowserLogsTools } from './antidetect_browser_logs/mcp-tools';
import { cloudBrowsersTools } from './cloud_browsers/mcp-tools';
import { cloudBrowserSessionsTools } from './cloud_browser_sessions/mcp-tools';

const pkg = (entity: string, tools: ToolPackage['tools']): ToolPackage => ({
  id: `mcp.linkedin/${entity}`,
  service: 'linkedin',
  entity,
  tools,
});

// One ToolPackage per entity; mounts (apps/worker/src/mounts.config.ts) select
// packages. Full LinkedIn coverage (see PACKAGES.md).
export const linkedinPackages: ToolPackage[] = [
  pkg('linkedin_accounts', linkedinAccountsTools),
  pkg('linkedin_account_smart_limits', linkedinAccountSmartLimitsTools),
  pkg('linkedin_account_snapshots', linkedinAccountSnapshotsTools),
  pkg('linkedin_benchmarks', linkedinBenchmarksTools),
  pkg('linkedin_account_quota_hits', linkedinAccountQuotaHitsTools),
  pkg('linkedin_account_block_log', linkedinAccountBlockLogTools),
  pkg('linkedin_account_activity_log', linkedinAccountActivityLogTools),
  pkg('linkedin_account_sync_runs', linkedinAccountSyncRunsTools),
  pkg('linkedin_conversations', linkedinConversationsTools),
  pkg('linkedin_messages', linkedinMessagesTools),
  pkg('linkedin_connections', linkedinConnectionsTools),
  pkg('linkedin_connection_requests', linkedinConnectionRequestsTools),
  pkg('linkedin_connection_invitations', linkedinConnectionInvitationsTools),
  pkg('linkedin_followers', linkedinFollowersTools),
  pkg('linkedin_posting', linkedinPostingTools),
  pkg('linkedin_scraping', linkedinScrapingTools),
  pkg('linkedin_auto_scrapes', linkedinAutoScrapesTools),
  pkg('linkedin_auto_scrape_runs', linkedinAutoScrapeRunsTools),
  pkg('linkedin_auto_scrape_results', linkedinAutoScrapeResultsTools),
  pkg('linkedin_custom_requests', linkedinCustomRequestsTools),
  pkg('linkedin_enrichment', linkedinEnrichmentTools),
  pkg('data_requests', dataRequestsTools),
  pkg('antidetect_browsers', antidetectBrowsersTools),
  pkg('antidetect_browser_proxies', antidetectBrowserProxiesTools),
  pkg('antidetect_browser_logs', antidetectBrowserLogsTools),
  pkg('cloud_browsers', cloudBrowsersTools),
  pkg('cloud_browser_sessions', cloudBrowserSessionsTools),
];
