import type { ToolPackage } from '@gtm/mcp-runtime/types';
import { webhooksTools } from './webhooks/mcp-tools';
import { webhookLogsTools } from './webhook_logs/mcp-tools';
import { massActionsTools } from './mass_actions/mcp-tools';
import { massActionItemsTools } from './mass_action_items/mcp-tools';

const pkg = (entity: string, tools: ToolPackage['tools']): ToolPackage => ({
  id: `mcp.orchestration/${entity}`,
  service: 'orchestration',
  entity,
  tools,
});

// One ToolPackage per entity; mounts (apps/worker/src/mounts.config.ts) select
// packages. gtm.service.orchestration owns the cross-service plumbing: the
// webhook registry + delivery log, and the mass-action execution plane
// (parent run + its per-target items). See PACKAGES.md.
export const orchestrationPackages: ToolPackage[] = [
  pkg('webhooks', webhooksTools),
  pkg('webhook_logs', webhookLogsTools),
  pkg('mass_actions', massActionsTools),
  pkg('mass_action_items', massActionItemsTools),
];
