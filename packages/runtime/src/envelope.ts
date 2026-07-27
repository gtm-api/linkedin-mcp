import type { DispatchContext, ToolResult } from './types';

// Render a SUCCESS envelope into an MCP tool result. The full envelope becomes
// structuredContent; the text block is a readable JSON rendering for models
// that only consume text. (Size-budget trimming is applied by middleware.)
export function renderSuccess(
  _ctx: DispatchContext,
  envelope: unknown,
): ToolResult {
  const structured =
    envelope && typeof envelope === 'object'
      ? (envelope as Record<string, unknown>)
      : { value: envelope };
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
    structuredContent: structured,
  };
}
