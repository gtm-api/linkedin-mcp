// Entity: LinkedIn Benchmark (gtm.service.linkedin)
// Source of truth: product/research/gtm.service.linkedin/entities/linkedin_benchmarks.md
// Format: registry v2, where each tool carries route metadata so the generic
// dispatcher can drive it. 1 tool (the linkedin-benchmarks route group).
// Benchmarks are platform-GLOBAL weekly rows (no team_sid); the public surface
// is a single read of the latest row. Mounted on linkedin.account-monitor.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import { usageMetaField, McpActionResponse } from '@gtm/mcp-shared';

// Item projection: every field of LinkedinBenchmarkDomain (platform-global row:
// no team_sid / updated_at / created_by / deleted_at). The three metric-group
// JSON blobs (group_1/2/3) are parser-driven per MARKET_BENCHMARKS.md and kept as
// z.record. .passthrough() keeps forward-compat if the backend adds fields.
const LinkedinBenchmark = z.object({
  sid: z.string(),

  // Period identity: one row per ISO week
  period_start: z.string(),
  period_end: z.string(),
  period_iso_week: z.string(),

  // Sample size
  sample_size: z.number(),

  // Metric groups: parser-driven JSON namespaces (shape owned by MARKET_BENCHMARKS.md)
  group_1: z.record(z.unknown()).describe('Business conversions (MARKET_BENCHMARKS.md §3).'),
  group_2: z.record(z.unknown()).describe('LinkedIn quota hits (§4).'),
  group_3: z.record(z.unknown()).describe('LinkedIn logouts (§5).'),

  // Timestamp
  created_at: z.string(),
}).passthrough();

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const base = {
  service: 'linkedin',
  entity: 'linkedin_benchmarks',
  mount: 'linkedin.account-monitor',
} as const;

export const linkedinBenchmarksTools: ToolDefinition[] = [
  {
    ...base,
    name: 'get_latest_linkedin_benchmark',
    description:
      'Return the most recent platform benchmark row (largest period_start < today). Platform-GLOBAL: every team reads the same weekly row. No parameters. ' +
      'Use to compare an account or fleet against the market (acceptance rate, reply rates) and to calibrate safe daily ceilings by cohort. Pair it with linkedin-account-snapshots / linkedin-accounts / *.metrics for the per-account numbers to compare against. ' +
      'Every metric lives in the group_1 / group_2 / group_3 JSON blobs; dereference the specific path per MARKET_BENCHMARKS.md. ' +
      'NOT for a single account\'s current numbers (linkedin-accounts / -snapshots), live limit utilisation (linkedin-account-smart-limits), a specific quota hit (linkedin-account-quota-hits), or historical trends (internal-only). Cold start returns 404 no_benchmark_published.',
    toolClass: 'trivial',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-benchmarks/get-latest-benchmark' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ ...usageMetaField }),
    outputSchema: McpActionResponse(LinkedinBenchmark),
    annotations: { title: 'Get latest LinkedIn benchmark', ...RO },
  },
];
