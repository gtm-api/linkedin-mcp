import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { UsageMetaSchema } from '@gtm/mcp-shared';
import type { Registry } from './registry';
import type { ResolvedMount } from './mounts';
import type { DispatchContext, RuntimeDeps, ToolResult } from './types';
import { getAuthScope } from './auth-scope';
import { callableSchema, registeredShape, TeamSidOverride, toolOwnsTeamSid, validationFailedResult } from './input-schema';
import { toolDescription, withAffordances } from './tool-description';

// The unified facade: 3 meta-tools over the whole registry, for clients that
// want one URL instead of mounting each domain. `call_tool` re-enters the SAME
// middleware chain + dispatch as a direct call, so preview-gate / rate-limit /
// redaction are never bypassed, and it parses `arguments` against the target
// tool's own inputSchema first, exactly as the SDK does on a domain mount. That
// parse is not a nicety: `arguments` arrives as an opaque object, so without it
// every bound the schema states would be enforced on the per-domain URLs and
// unenforced on /mcp, which is the URL a production client mounts.

const toolsetId = (m: ResolvedMount) => m.config.path.replace(/^\/mcp\//, '').replace(/\//g, '.');

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export function registerFacadeTools(
  server: McpServer,
  catalog: ResolvedMount[],
  registry: Registry,
  deps: RuntimeDeps,
  run: (ctx: DispatchContext) => Promise<ToolResult>,
): void {
  const byToolset = new Map(catalog.map((m) => [toolsetId(m), m]));

  server.registerTool(
    'list_toolsets',
    {
      description:
        'List the available toolsets (domains) on this server. Each toolset groups related tools (e.g. linkedin.messaging, id.billing). Start here, then get_toolset_tools to inspect one, then call_tool to run a tool. Requires OAuth authorization (Bearer token).',
      inputSchema: { _meta: UsageMetaSchema.optional() },
      annotations: { title: 'List toolsets', ...RO },
    },
    async (): Promise<ToolResult> => {
      const toolsets = catalog.map((m) => ({
        toolset: toolsetId(m),
        title: m.config.name,
        description: (m.config.instructions ?? '').split('\n')[0],
        tool_count: m.tools.length,
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ toolsets }, null, 2) }], structuredContent: { toolsets } };
    },
  );

  server.registerTool(
    'get_toolset_tools',
    {
      description:
        'List the tools in a toolset. Default (lite) returns name + title + one-line summary; pass verbose:true for full descriptions, safety flags, and parameter names. Run one via call_tool.',
      inputSchema: {
        toolset: z.string().describe('Toolset id from list_toolsets, e.g. "linkedin.messaging".'),
        verbose: z.boolean().optional().describe('Include full descriptions + parameter names.'),
        _meta: UsageMetaSchema.optional(),
      },
      annotations: { title: 'Get toolset tools', ...RO },
    },
    async (args): Promise<ToolResult> => {
      const key = String(args.toolset);
      const mount = byToolset.get(key);
      if (!mount) {
        return { content: [{ type: 'text', text: `Unknown toolset "${key}". Call list_toolsets for the valid ids.` }], isError: true };
      }
      const verbose = args.verbose === true;
      const tools = mount.tools.map((t) =>
        verbose
          ? {
              name: t.name,
              title: t.annotations.title,
              description: toolDescription(t),
              dangerous: t.dangerous,
              availability: t.availability,
              // registeredShape, not t.inputSchema.shape: a dangerous tool also
              // takes commit_token, and call_tool now parses against exactly
              // this set, so listing anything else would misdescribe the call.
              params: Object.keys(registeredShape(t)),
            }
          : { name: t.name, title: t.annotations.title, summary: withAffordances(t.description.split('\n')[0].slice(0, 160), t) },
      );
      return { content: [{ type: 'text', text: JSON.stringify({ toolset: key, tools }, null, 2) }], structuredContent: { toolset: key, tools } };
    },
  );

  server.registerTool(
    'call_tool',
    {
      description:
        'Invoke a tool by name (discovered via get_toolset_tools) with its arguments object. Behaves exactly like calling the tool on its domain mount. Dangerous tools still require the two-step preview→confirm (pass commit_token inside arguments on the confirm call). To act in another of your teams, set the top-level team_sid: the edge swaps the token for that team (the OAuth grant must cover it); every response echoes the team it ran in as meta.team_sid.',
      inputSchema: {
        name: z.string().describe('Exact tool name.'),
        arguments: z.record(z.unknown()).optional().describe("The tool's arguments object."),
        team_sid: TeamSidOverride.optional(),
        _meta: UsageMetaSchema.optional(),
      },
      annotations: { title: 'Call tool', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args): Promise<ToolResult> => {
      const name = String(args.name);
      const entry = registry.byName.get(name);
      if (!entry) {
        return { content: [{ type: 'text', text: `Unknown tool "${name}". Use list_toolsets → get_toolset_tools to discover tools.` }], isError: true };
      }
      // The team-scope override: the top-level `team_sid` param, or - the
      // natural agent gesture - `arguments.team_sid` on a tool that does not
      // own the field, lifted out BEFORE the parse (the tool schema would
      // silently strip it otherwise, which is exactly how the 2026-08-19
      // wrong-team incident stayed invisible). Tools whose own contract has a
      // team_sid body field (toolOwnsTeamSid) keep it: entity data, not
      // transport.
      let override = typeof args.team_sid === 'string' ? args.team_sid : undefined;
      let rawArgs = (args.arguments ?? {}) as Record<string, unknown>;
      if (override === undefined && !toolOwnsTeamSid(entry.tool) && 'team_sid' in rawArgs) {
        const { team_sid: lifted, ...rest } = rawArgs;
        const liftParse = z.object({ team_sid: TeamSidOverride }).safeParse({ team_sid: lifted });
        if (!liftParse.success) return validationFailedResult(entry.tool, liftParse.error);
        override = liftParse.data.team_sid;
        rawArgs = rest;
      }

      // Parse before anything else runs, so a malformed call costs no preview
      // round trip, no commit-token KV write and no backend hop, and the agent
      // gets the same validation_failed envelope a domain mount would return.
      const parsed = callableSchema(entry.tool).safeParse(rawArgs);
      if (!parsed.success) return validationFailedResult(entry.tool, parsed.error);

      const ctx: DispatchContext = {
        tool: entry.tool,
        args: parsed.data,
        scope: getAuthScope(),
        deps,
        ...(override !== undefined ? { teamSidOverride: override } : {}),
      };
      return run(ctx);
    },
  );
}
