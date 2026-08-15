import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { stubGate } from './stub-gate';
import { makePreviewGate } from './preview-gate';
import { composeChain } from '../chain';
import type {
  CommitTokenStore,
  DispatchContext,
  RuntimeDeps,
  ToolAvailability,
  ToolDefinition,
  ToolResult,
} from '../types';

const SECRET = 'unit-secret';
const NOW = 1_700_000_000_000;

function mkTool(availability: ToolAvailability, dangerous: boolean): ToolDefinition {
  return {
    name: 'create_linkedin_post',
    description: 'd',
    service: 'linkedin',
    entity: 'linkedin_posting',
    mount: 'linkedin.content',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-posting/create-post' },
    operation: 'action',
    envelope: 'action',
    availability,
    dangerous,
    inputSchema: z.object({ _meta: z.any().optional() }),
    outputSchema: z.any(),
    annotations: { title: 't', readOnlyHint: false, destructiveHint: dangerous, idempotentHint: false, openWorldHint: false },
  };
}

function mkDeps(store: CommitTokenStore, puts: string[]): RuntimeDeps {
  return {
    config: {
      envName: 'test', version: '0', baseUrls: { linkedin: '', id: '', orchestration: '', support: '' },
      backendTimeoutMs: 1000, responseCharBudget: 1000, maxBatchSize: 16, rateLimit: { enabled: false, windowSeconds: 60, callsPerWindow: 0, writesPerWindow: 0 },
      previewGate: { enabled: true, secret: SECRET, ttlSeconds: 300 },
    },
    logger: { info() {}, error() {} },
    commitTokens: {
      get: (k) => store.get(k),
      put: async (k, v, ttl) => { puts.push(k); await store.put(k, v, ttl); },
    },
    now: () => NOW,
  };
}

function memStore(): CommitTokenStore {
  const map = new Map<string, string>();
  return { get: async (k) => map.get(k) ?? null, put: async (k, v) => { map.set(k, v); } };
}

function mkCtx(tool: ToolDefinition, deps: RuntimeDeps, args: Record<string, unknown> = {}): DispatchContext {
  return {
    tool,
    args,
    scope: { token: '', teamSid: null, actor: { type: 'user', sid: null }, permissions: [], traceId: 't', mountPath: 'm' },
    deps,
  };
}

describe('stub-gate middleware', () => {
  it('lets a GA tool straight through to the next link', async () => {
    const deps = mkDeps(memStore(), []);
    const next = async (): Promise<ToolResult> => ({ content: [{ type: 'text', text: 'EXECUTED' }] });
    const res = await stubGate(mkCtx(mkTool('ga', false), deps), next);
    expect(res.content[0].text).toBe('EXECUTED');
  });

  it('answers a stub_501 tool in-worker, without calling next', async () => {
    const deps = mkDeps(memStore(), []);
    let called = false;
    const next = async (): Promise<ToolResult> => {
      called = true;
      return { content: [{ type: 'text', text: 'EXECUTED' }] };
    };
    const res = await stubGate(mkCtx(mkTool('stub_501', false), deps), next);

    expect(called).toBe(false);
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({
      success: false,
      error: {
        code: 'not_implemented',
        recoverable: false,
        context: { source: 'mcp_runtime', availability: 'stub_501' },
      },
    });
    // The agent must be told not to retry, in the text block too (some clients
    // only read content[]).
    expect(res.content[0].text).toContain('Do not retry');
  });

  it('short-circuits a DANGEROUS stub before the preview gate: no token, no KV write', async () => {
    const puts: string[] = [];
    const deps = mkDeps(memStore(), puts);
    let reachedCore = false;
    const core = async (): Promise<ToolResult> => {
      reachedCore = true;
      return { content: [{ type: 'text', text: 'EXECUTED' }] };
    };
    // Exactly the worker's chain order.
    const run = composeChain([stubGate, makePreviewGate(deps)], core);

    const res = await run(mkCtx(mkTool('stub_501', true), deps, { text: 'hello' }));

    expect(reachedCore).toBe(false);
    expect(puts).toEqual([]);
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ error: { code: 'not_implemented' } });
    // The old path answered a dangerous tool with a preview + commit_token.
    expect(res.structuredContent).not.toHaveProperty('commit_token');
    expect(res.structuredContent).not.toHaveProperty('preview');
  });

  it('still gates a dangerous GA tool through preview (the stub gate is not a bypass)', async () => {
    const deps = mkDeps(memStore(), []);
    const core = async (): Promise<ToolResult> => ({ content: [{ type: 'text', text: 'EXECUTED' }] });
    const run = composeChain([stubGate, makePreviewGate(deps)], core);

    const res = await run(mkCtx(mkTool('ga', true), deps, { text: 'hello' }));

    expect(res.structuredContent).toMatchObject({ preview: true, dangerous: true });
    expect(typeof res.structuredContent?.commit_token).toBe('string');
  });
});
