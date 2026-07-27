import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerFacadeTools } from './facade';
import { runWithAuthScope } from './auth-scope';
import { buildRegistry } from './registry';
import type { ResolvedMount } from './mounts';
import type { AuthScope, DispatchContext, RuntimeDeps, ToolDefinition, ToolPackage, ToolResult } from './types';

// The facade's own parse step. On a domain mount the SDK builds a z.object from
// the registered shape and rejects a bad call before the handler runs; on /mcp
// the same call arrives inside an opaque `arguments` object, so the facade has
// to do it. These tests pin that the two paths agree: a call the SDK would
// reject never reaches dispatch, and a call it would accept arrives parsed.

function mkTool(over: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'search_things',
    description: 'Search things.',
    service: 'linkedin',
    entity: 'things',
    mount: 'linkedin.things',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/things/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: z.object({
      sort: z.object({ field: z.enum(['created_at', 'updated_at']) }).optional(),
      page_size: z.number().int().min(0).max(200).optional(),
      _meta: z.any().optional(),
    }),
    outputSchema: z.any(),
    annotations: { title: 'Search things', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    ...over,
  };
}

const deps = { config: { envName: 'test' } } as unknown as RuntimeDeps;
const SCOPE = {
  token: 't', teamSid: null, actor: { type: 'user', sid: 'us_1' },
  permissions: [], traceId: 'trace', mountPath: '/mcp',
} as AuthScope;

/** Registers the facade against a stub server and returns its 3 handlers. */
function facade(tools: ToolDefinition[]) {
  const dispatched: DispatchContext[] = [];
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<ToolResult>>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: (args: Record<string, unknown>) => Promise<ToolResult>) => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;

  const pkg: ToolPackage = { id: 'mcp.linkedin/things', service: 'linkedin', entity: 'things', tools };
  const mount: ResolvedMount = {
    config: { path: '/mcp/linkedin/things', name: 'Things', instructions: 'Things.' },
    tools,
  } as unknown as ResolvedMount;

  registerFacadeTools(server, [mount], buildRegistry([pkg]), deps, async (ctx) => {
    dispatched.push(ctx);
    return { content: [{ type: 'text', text: 'ok' }] };
  });

  // The worker populates the AsyncLocalStorage scope before any handler runs;
  // the facade reads it only AFTER the parse, which the rejection tests rely on.
  const call = (args: Record<string, unknown>) => runWithAuthScope(SCOPE, () => handlers.get('call_tool')!(args));
  const list = handlers.get('get_toolset_tools')!;
  return { call, list, dispatched };
}

describe('facade call_tool argument validation', () => {
  it('rejects an off-contract value before dispatch, with a validation_failed envelope', async () => {
    const { call, dispatched } = facade([mkTool()]);

    const result = await call({ name: 'search_things', arguments: { sort: { field: 'nope' } } });

    // Nothing reached the middleware chain: no preview round trip, no backend hop.
    expect(dispatched).toEqual([]);
    expect(result.isError).toBe(true);
    const envelope = result.structuredContent as { success: boolean; error: Record<string, unknown> };
    expect(envelope.success).toBe(false);
    expect(envelope.error.code).toBe('validation_failed');
    expect(envelope.error.context).toMatchObject({ source: 'mcp_runtime', tool: 'search_things' });
    // The offending key is named, so the agent can fix the call from the message.
    expect(Object.keys(envelope.error.field_errors as object)).toEqual(['sort.field']);
    expect(result.content[0].text).toContain('sort.field');
  });

  it('rejects a bound the inputSchema states and the backend enforces', async () => {
    const { call, dispatched } = facade([mkTool()]);

    const result = await call({ name: 'search_things', arguments: { page_size: 500 } });

    expect(dispatched).toEqual([]);
    expect(Object.keys((result.structuredContent as { error: { field_errors: object } }).error.field_errors)).toEqual(['page_size']);
  });

  it('passes a valid call through parsed, stripping keys the schema does not declare', async () => {
    const { call, dispatched } = facade([mkTool()]);

    const result = await call({ name: 'search_things', arguments: { page_size: 25, bogus: 'x' } });

    expect(result.isError).toBeUndefined();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].args).toEqual({ page_size: 25 });
  });

  it('accepts commit_token on a dangerous tool, which the tool schema itself never declares', async () => {
    const { call, dispatched } = facade([mkTool({
      name: 'delete_thing',
      operation: 'delete',
      envelope: 'delete_simple',
      dangerous: true,
      annotations: { title: 'Delete thing', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    })]);

    const result = await call({ name: 'delete_thing', arguments: { commit_token: 'tok_1' } });

    expect(result.isError).toBeUndefined();
    expect(dispatched[0].args).toEqual({ commit_token: 'tok_1' });
  });

  it('still reports an unknown tool name rather than parsing against nothing', async () => {
    const { call, dispatched } = facade([mkTool()]);

    const result = await call({ name: 'no_such_tool', arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown tool');
    expect(dispatched).toEqual([]);
  });

  it('verbose get_toolset_tools lists commit_token among a dangerous tool params', async () => {
    const { list } = facade([mkTool({
      name: 'delete_thing',
      operation: 'delete',
      envelope: 'delete_simple',
      dangerous: true,
      annotations: { title: 'Delete thing', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    })]);

    const result = await list({ toolset: 'linkedin.things', verbose: true });
    const [tool] = (result.structuredContent as { tools: Array<{ params: string[] }> }).tools;

    expect(tool.params).toContain('commit_token');
  });
});
