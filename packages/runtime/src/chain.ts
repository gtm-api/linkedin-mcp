import type { DispatchContext, ToolResult } from './types';

// A middleware wraps the core dispatch. Result-transforming middlewares
// (redaction, size-budget) act on `await next(ctx)`; gating middlewares
// (preview-gate, rate-limit) may short-circuit before calling next.
export type ToolMiddleware = (
  ctx: DispatchContext,
  next: (ctx: DispatchContext) => Promise<ToolResult>,
) => Promise<ToolResult>;

export function composeChain(
  middlewares: ToolMiddleware[],
  core: (ctx: DispatchContext) => Promise<ToolResult>,
): (ctx: DispatchContext) => Promise<ToolResult> {
  return middlewares.reduceRight<(ctx: DispatchContext) => Promise<ToolResult>>(
    (next, mw) => (ctx) => mw(ctx, next),
    core,
  );
}
