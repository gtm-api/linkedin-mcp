// Entity: Cloud Browser (gtm.service.linkedin)
// Source of truth: product/research/gtm.service.linkedin/entities/cloud_browsers.md
// Format: registry v2, where each tool carries route metadata so the generic
// dispatcher can drive it. 1 tool (the cloud-browsers public route group; the
// rest of the lifecycle is internal/external-only), mounted on linkedin.browsers.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  usageMetaField,
  McpActionResponse,
} from '@gtm/mcp-shared';

// Tight projection: the documented CloudBrowserListTeamOccupancyItem (research
// §MCP Tools / list-team-occupancy): a deliberately-stripped 4-field row (slot
// sid / token / port / hostname / rdp_settings are omitted from this surface).
// connected_user_sid is NULL for external smart-link allocations. passthrough
// tolerates any extra field the live projection may carry.
const CloudBrowserOccupancySlot = z.object({
  connected_antidetect_browser_sid: z.string(),
  connected_user_sid: z.string().nullable(),
  connected_at: z.string(),
  connected_till: z.string(),
}).passthrough();

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const base = {
  service: 'linkedin',
  entity: 'cloud_browsers',
  mount: 'linkedin.browsers',
} as const;

export const cloudBrowsersTools: ToolDefinition[] = [
  {
    ...base,
    name: 'list_cloud_browser_team_occupancy',
    description:
      'List the cloud-browser slots the team currently occupies. Each slot carries the connected antidetect_browser sid, the connected user, and the connect / expiry timestamps. Read-only snapshot returned in result.items.',
    toolClass: 'trivial',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/cloud-browsers/list-team-occupancy' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ ...usageMetaField }),
    outputSchema: McpActionResponse(z.null(), z.object({ items: z.array(CloudBrowserOccupancySlot) }).passthrough()),
    annotations: { title: 'List cloud-browser team occupancy', ...RO },
  },
];
