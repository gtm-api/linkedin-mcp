import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ResolvedMount } from './mounts';
import type { Registry } from './registry';
import type { DispatchContext, RuntimeDeps, ToolResult } from './types';
import type { ToolMiddleware } from './chain';
import { composeChain } from './chain';
import { dispatch } from './dispatcher';
import { getAuthScope } from './auth-scope';
import { registerFacadeTools } from './facade';
import { registeredShape } from './input-schema';
import { toolDescription } from './tool-description';

export type ServerFactory = (mount: ResolvedMount, catalog?: ResolvedMount[]) => McpServer;

// Appended to every mount's server instructions (facade included), here at the
// single SDK seam so no mount can opt out: whatever the surface, the client
// agent answers its user with the minimum, not with prose around the data.
export const REPLY_STYLE =
  'Reply style: keep every answer as simple and short as the request allows, for support answers and plain context alike. Give the minimum that answers the ask or supplies the needed context, then stop. No filler, no padding, no unrequested detail.';

/** Mount instructions + the global reply-style rule; the rule alone when a mount has none. */
export function composeInstructions(mountInstructions?: string): string {
  return mountInstructions ? `${mountInstructions}\n\n${REPLY_STYLE}` : REPLY_STYLE;
}

// Build a factory that returns a fresh McpServer per request (stateless,
// server-instance-per-request). The generic dispatch is wrapped once with the
// middleware chain; each tool handler reads its AuthScope from AsyncLocalStorage
// (populated by the worker before the request runs). A `facade: 'toolsets'`
// mount registers the 3 meta-tools over the whole registry instead of a flat
// tool list; `catalog` is the set of domain mounts it presents as toolsets.
export function createServerFactory(
  registry: Registry,
  deps: RuntimeDeps,
  middlewares: ToolMiddleware[] = [],
): ServerFactory {
  const run = composeChain(middlewares, dispatch);

  return (mount: ResolvedMount, catalog: ResolvedMount[] = []): McpServer => {
    const server = new McpServer(
      { name: mount.config.name, version: deps.config.version },
      { instructions: composeInstructions(mount.config.instructions) },
    );

    if (mount.config.facade === 'toolsets') {
      registerFacadeTools(server, catalog, registry, deps, run);
      return server;
    }

    for (const tool of mount.tools) {
      server.registerTool(
        tool.name,
        {
          description: toolDescription(tool),
          // Registered shape (incl. commit_token on dangerous tools) comes from
          // input-schema.ts, the same module the facade parses against, so the
          // two entry points cannot advertise different contracts.
          inputSchema: registeredShape(tool),
          annotations: tool.annotations,
        },
        async (args: Record<string, unknown>): Promise<ToolResult> => {
          const ctx: DispatchContext = {
            tool,
            args: args ?? {},
            scope: getAuthScope(),
            deps,
          };
          return run(ctx);
        },
      );
    }

    return server;
  };
}
