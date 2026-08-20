import { z } from 'zod';
import type { ToolDefinition, ToolResult } from './types';

// The ONE definition of "what this tool accepts", used by both entry points.
//
// A domain mount hands `registeredShape()` to the SDK, which builds a z.object
// from it and parses every call before the handler runs. The unified /mcp facade
// takes `arguments` as an opaque object, so nothing on that path parses anything
// unless it does it here: without this module the facade would forward whatever
// the client sent, and every bound the inputSchema states (page_size caps, sid
// prefixes, sort-column enums) would hold on the per-domain URLs and mean
// nothing on the one URL a production client actually mounts. An off-contract
// sort column would then reach the backend and come back a 500 instead of the
// 422 the same call earns on a domain mount.
//
// Both entry points therefore read the shape from here rather than assembling
// their own, so the two surfaces cannot drift apart again.

const COMMIT_TOKEN = z
  .string()
  .optional()
  .describe(
    'Confirmation token from the preview step. Omit on the first call to get a preview; pass the returned token (with identical args) to execute.',
  );

/**
 * The team-scope override, advertised in exactly ONE contract: the facade's
 * `call_tool` (top level, next to `name`/`arguments`). Deliberately NOT
 * injected into per-tool schemas - the platform doctrine is that a tool's
 * team comes from the token, never from its arguments, and the advertised
 * contracts must keep saying so. Domain mounts switch teams via the
 * `Team-SID` header instead (per connection).
 */
export const TeamSidOverride = z
  .string()
  .length(18)
  .startsWith('ts_tm_')
  .describe(
    'Run this call in another of your teams. The edge exchanges the request token for a sibling installation token (RFC 8693); the OAuth grant must cover that team and you must be a live member. Omit to act in the token team (see meta.team_sid on any response).',
  );

/**
 * Whether the tool's OWN contract has a `team_sid` body field (e.g.
 * create_api_key keys a new api-key to a team). The facade never lifts the
 * field out of those tools' arguments - it is entity data and reaches the
 * backend as declared.
 */
export function toolOwnsTeamSid(tool: ToolDefinition): boolean {
  return 'team_sid' in tool.inputSchema.shape;
}

/**
 * The tool's own inputSchema shape, plus `commit_token` on dangerous tools.
 * Added here rather than in the entity files so the preview-gate field stays
 * consistent and the entity files stay clean.
 */
export function registeredShape(tool: ToolDefinition): z.ZodRawShape {
  return tool.dangerous
    ? { ...tool.inputSchema.shape, commit_token: COMMIT_TOKEN }
    : tool.inputSchema.shape;
}

/** The same contract as a parseable object, for callers that hold the args. */
export function callableSchema(tool: ToolDefinition): z.AnyZodObject {
  return z.object(registeredShape(tool));
}

/**
 * A Zod failure rendered as the backend's own validation_failed envelope
 * (McpException::render). Same code, same field_errors shape and the same
 * prose as the `validation_failed` branch of error-map.ts, so an agent cannot
 * tell a locally rejected call from a backend-rejected one and needs no second
 * recovery strategy. `context.source` is the one field that differs, so a
 * caller CAN tell them apart without parsing prose.
 */
export function validationFailedResult(tool: ToolDefinition, error: z.ZodError): ToolResult {
  const fieldErrors: Record<string, Array<{ rule: string; message: string }>> = {};
  const lines = [`Validation failed for ${tool.name}:`];

  for (const issue of error.issues) {
    const field = issue.path.length ? issue.path.join('.') : '(root)';
    (fieldErrors[field] ??= []).push({ rule: issue.code, message: issue.message });
    lines.push(`  • ${field}: ${issue.message} [${issue.code}]`);
  }
  lines.push('Fix the arguments against the tool schema and call again. Nothing was sent to the backend.');

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    isError: true,
    structuredContent: {
      success: false,
      error: {
        code: 'validation_failed',
        message: `The arguments do not match the schema of ${tool.name}.`,
        recoverable: true,
        suggestion: 'Read the tool schema (get_toolset_tools with verbose:true) and correct the arguments.',
        field_errors: fieldErrors,
        context: { source: 'mcp_runtime', tool: tool.name },
      },
    },
  };
}
