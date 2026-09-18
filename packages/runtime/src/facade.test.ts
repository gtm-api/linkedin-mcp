import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerFacadeTools } from './facade';
import { PACING_CONTRACT } from './tool-description';
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

  // Until 2026-09-16 an undeclared key was stripped in silence and the call
  // went through (the MCP audit report, items 1 and 2: a dotted filter key
  // parsed to an empty filter and answered the whole team). Now it is the 422
  // the backend would answer, with a hint that names the shape.
  it('refuses a key the schema does not declare, with a hint, and dispatches nothing', async () => {
    const { call, dispatched } = facade([mkTool()]);

    const result = await call({ name: 'search_things', arguments: { page_size: 25, bogus: 'x' } });

    expect(result.isError).toBe(true);
    expect(dispatched).toEqual([]);
    const errors = (result.structuredContent as { error: { code: string; field_errors: Record<string, Array<{ rule: string; message: string }>> } }).error;
    expect(errors.code).toBe('validation_failed');
    expect(errors.field_errors['(root)'][0].rule).toBe('unknown_key');
    expect(errors.field_errors['(root)'][0].message).toContain('unknown key "bogus"');
  });

  it('names the nested shape for a dotted filter key and filter.q for a top-level q', async () => {
    const { call, dispatched } = facade([mkTool({
      inputSchema: z.object({
        filter: z.object({ name: z.object({ eq: z.string().optional() }).optional(), q: z.string().optional() }).optional(),
        page_size: z.number().int().min(0).max(200).optional(),
        _meta: z.any().optional(),
      }),
    })]);

    const dotted = await call({ name: 'search_things', arguments: { filter: { 'name.eq': 'Ann' } } });
    expect(dotted.isError).toBe(true);
    const dottedErrors = (dotted.structuredContent as { error: { field_errors: Record<string, Array<{ message: string }>> } }).error.field_errors;
    expect(dottedErrors['filter'][0].message).toContain('filter: {"name": {"eq": <value>}}');

    const topQ = await call({ name: 'search_things', arguments: { q: 'Ann' } });
    expect(topQ.isError).toBe(true);
    const qErrors = (topQ.structuredContent as { error: { field_errors: Record<string, Array<{ message: string }>> } }).error.field_errors;
    expect(qErrors['(root)'][0].message).toContain('filter: {"q": "<text>"}');

    expect(dispatched).toEqual([]);
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

  it('sets teamSidOverride from the top-level team_sid param, never through args', async () => {
    const { call, dispatched } = facade([mkTool()]);

    const result = await call({ name: 'search_things', arguments: { page_size: 5 }, team_sid: 'ts_tm_bbbbbbbbbbbb' });

    expect(result.isError).toBeUndefined();
    expect(dispatched[0].teamSidOverride).toBe('ts_tm_bbbbbbbbbbbb');
    expect(dispatched[0].args).toEqual({ page_size: 5 });
  });

  it('lifts arguments.team_sid on a tool that does not own the field (the natural agent gesture)', async () => {
    const { call, dispatched } = facade([mkTool()]);

    const result = await call({ name: 'search_things', arguments: { page_size: 5, team_sid: 'ts_tm_bbbbbbbbbbbb' } });

    expect(result.isError).toBeUndefined();
    expect(dispatched[0].teamSidOverride).toBe('ts_tm_bbbbbbbbbbbb');
    expect(dispatched[0].args).toEqual({ page_size: 5 });
  });

  it('rejects a malformed lifted team_sid instead of silently dropping it', async () => {
    const { call, dispatched } = facade([mkTool()]);

    const result = await call({ name: 'search_things', arguments: { team_sid: 'not-a-team' } });

    expect(dispatched).toEqual([]);
    expect(result.isError).toBe(true);
    expect(Object.keys((result.structuredContent as { error: { field_errors: object } }).error.field_errors)).toEqual(['team_sid']);
  });

  it('leaves team_sid in the args of a tool whose own contract claims the field', async () => {
    const { call, dispatched } = facade([mkTool({
      name: 'create_api_key',
      operation: 'create',
      envelope: 'create',
      inputSchema: z.object({ team_sid: z.string(), label: z.string().optional(), _meta: z.any().optional() }),
      annotations: { title: 'Create api key', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    })]);

    const result = await call({ name: 'create_api_key', arguments: { team_sid: 'ts_tm_bbbbbbbbbbbb', label: 'ci' } });

    expect(result.isError).toBeUndefined();
    expect(dispatched[0].teamSidOverride).toBeUndefined();
    expect(dispatched[0].args).toEqual({ team_sid: 'ts_tm_bbbbbbbbbbbb', label: 'ci' });
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

// The facade registers three meta-tools, so neither the per-tool MCP annotations
// nor a mount's server instructions reach its client: the listing is the only
// place a facade agent can learn that a call drives a live session and is paced.
describe('facade get_toolset_tools pacing', () => {
  const send = mkTool({
    name: 'send_thing',
    description: 'Send a thing.',
    operation: 'action',
    envelope: 'action',
    pacedBucket: 'send_messages',
    annotations: { title: 'Send thing', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  });

  it('marks the paced tool in the lite row and states the contract once for the listing', async () => {
    const { list } = facade([mkTool(), send]);

    const listing = (await list({ toolset: 'linkedin.things' })).structuredContent as {
      pacing?: string; tools: Array<{ name: string; summary: string }>;
    };

    expect(listing.pacing).toBe(PACING_CONTRACT);
    expect(listing.tools.find((row) => row.name === 'send_thing')!.summary).toBe('Send a thing. Paced: send_messages.');
    expect(listing.tools.find((row) => row.name === 'search_things')!.summary).toBe('Search things.');
  });

  it('carries the bucket and the session-driving hints on a verbose row', async () => {
    const { list } = facade([mkTool(), send]);

    const { tools } = (await list({ toolset: 'linkedin.things', verbose: true })).structuredContent as {
      tools: Array<{ name: string; read_only: boolean; open_world: boolean; paced_bucket: string | null }>;
    };

    expect(tools.find((row) => row.name === 'send_thing')).toMatchObject({ read_only: false, open_world: true, paced_bucket: 'send_messages' });
    expect(tools.find((row) => row.name === 'search_things')).toMatchObject({ read_only: true, open_world: false, paced_bucket: null });
  });

  it('adds no pacing note to a toolset that has no paced tool', async () => {
    const { list } = facade([mkTool()]);

    const listing = (await list({ toolset: 'linkedin.things' })).structuredContent as Record<string, unknown>;

    expect(listing).not.toHaveProperty('pacing');
  });
});
