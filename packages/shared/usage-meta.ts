// Usage-analytics `_meta` - attached (optional) to every MCP tool input.
// Mirrors product/MCP_USAGE_ANALYTICS.md §2: the agent states, in one line,
// what the user is ultimately trying to achieve. Stripped from the request
// before it reaches the backend; captured as a telemetry datapoint.

import { z } from 'zod';

export const UsageMetaSchema = z
  .object({
    user_goal: z
      .string()
      .max(500)
      .optional()
      .describe(
        'One sentence: what the user is ultimately trying to achieve with this call. Used for usage analytics; never sent to the backend.',
      ),
  })
  .passthrough();

export type UsageMeta = z.infer<typeof UsageMetaSchema>;

// Spread into a z.object shape to add the optional `_meta` field:
//   z.object({ sid: ..., ...usageMetaField })
export const usageMetaField = { _meta: UsageMetaSchema.optional() } as const;
