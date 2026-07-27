import type { DispatchContext, ToolResult } from '../types';
import type { ToolMiddleware } from '../chain';

// Short-circuit for tools the registry marks `availability: 'stub_501'`.
//
// The backend route for these exists and validates the whole request, then
// answers 501 not_implemented (§5.9 blocked-on-plugin). That is the right
// backend behaviour, but paying for it from the MCP side is pure waste: the
// answer never depends on the arguments, the team, or anything the backend
// knows. Worse, 2 of the 15 stubs are also `dangerous: true`, so without this
// gate a single stub call costs a preview round trip, a KV write for the
// commit-token jti, and a second round trip, before a fixed 501 comes back.
//
// So the stub answer is produced here, as the FIRST middleware in the chain:
// ahead of the preview gate (no token is minted, no KV write happens) and ahead
// of dispatch (no backend hop). The wording matches the `not_implemented` branch
// of error-map.ts, so an agent sees the same thing whether the 501 came from the
// backend or from here, and the same instruction not to retry.
//
// The envelope mirrors McpException::render exactly (success:false + error{}),
// which is what every other error path on this server puts in
// structuredContent. `context.source = 'mcp_runtime'` is the one field that
// differs, so a caller CAN tell the short-circuit from a backend 501 (and a
// test can assert no fetch happened) without having to parse prose.
export const stubGate: ToolMiddleware = async (ctx, next) => {
  if (ctx.tool.availability !== 'stub_501') return next(ctx);
  return stubResult(ctx);
};

export function stubResult(ctx: DispatchContext): ToolResult {
  const tool = ctx.tool.name;
  const envelope = {
    success: false,
    error: {
      code: 'not_implemented',
      message: `${tool} is planned but not shipped yet. The contract is locked, the capability lands in a future release.`,
      recoverable: false,
      suggestion: 'Do not retry; pick an alternative tool or ask the user how to proceed.',
      context: {
        source: 'mcp_runtime',
        availability: 'stub_501',
        route: `${ctx.tool.route.method} ${ctx.tool.route.pathTemplate}`,
      },
    },
  };
  return {
    content: [
      {
        type: 'text',
        text: [
          `${tool} is planned but not shipped yet. The contract is locked, the capability lands in a future release.`,
          'Do not retry; pick an alternative tool or ask the user how to proceed.',
          'Nothing was sent to the backend and nothing changed.',
        ].join('\n'),
      },
    ],
    isError: true,
    structuredContent: envelope,
  };
}
