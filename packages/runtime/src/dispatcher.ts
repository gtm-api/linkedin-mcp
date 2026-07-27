import type { DispatchContext, ToolResult } from './types';
import { backendFetch } from './backend-client';
import { mapErrorEnvelope, transportErrorResult } from './error-map';
import { renderSuccess } from './envelope';

// The generic core handler shared by all 229 tools. Because every backend
// endpoint speaks the same envelope, dispatch is data-driven: it needs nothing
// but the tool's route metadata. Never throws - every failure is an
// isError:true tool result.
export async function dispatch(ctx: DispatchContext): Promise<ToolResult> {
  // Local tools (bundled knowledge index) execute in-worker; same middleware
  // chain and envelope contract, no backend hop.
  if (ctx.tool.localHandler) {
    try {
      return renderSuccess(ctx, await ctx.tool.localHandler(ctx));
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: {
                code: 'internal_error',
                message: `Local tool failed: ${String((err as { message?: string })?.message ?? err)}`,
              },
            }),
          },
        ],
        isError: true,
      };
    }
  }

  const res = await backendFetch(ctx);

  if (res.kind === 'transport_error') {
    return transportErrorResult(ctx, res);
  }

  const env = res.envelope as { success?: boolean } | null;
  if (env && env.success === false) {
    return mapErrorEnvelope(res.status, env as never, ctx);
  }
  return renderSuccess(ctx, res.envelope);
}
