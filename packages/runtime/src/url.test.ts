import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { buildRequest } from './url';
import type { DispatchContext, RuntimeDeps, ToolDefinition } from './types';

const deps: RuntimeDeps = {
  config: {
    envName: 'test', version: '0',
    baseUrls: { linkedin: 'http://backend', id: 'http://id', orchestration: 'http://orchestration', support: '' },
    backendTimeoutMs: 1000, responseCharBudget: 1000, maxBatchSize: 16, rateLimit: { enabled: false, windowSeconds: 60, callsPerWindow: 0, writesPerWindow: 0 },
    previewGate: { enabled: false, secret: null, ttlSeconds: 300 },
  },
  logger: { info() {}, error() {} },
};

function tool(over: Partial<ToolDefinition>): ToolDefinition {
  return {
    name: 't', description: 'd', service: 'linkedin', entity: 'e', mount: 'm',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/x/search' },
    operation: 'search', envelope: 'search', availability: 'ga',
    dangerous: false,    inputSchema: z.object({ _meta: z.any().optional() }), outputSchema: z.any(),
    annotations: { title: 't', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    ...over,
  };
}

function ctx(t: ToolDefinition, args: Record<string, unknown>): DispatchContext {
  return { tool: t, args, scope: { token: '', teamSid: null, actor: { type: 'user', sid: null }, permissions: [], traceId: 't', mountPath: 'm' }, deps };
}

describe('buildRequest', () => {
  it('POST search: body carries filters, drops _meta', () => {
    const t = tool({});
    const { url, body } = buildRequest(ctx(t, { page_size: 3, filter: { q: 'x' }, _meta: { user_goal: 'g' } }));
    expect(url).toBe('http://backend/api/x/search');
    expect(body).toEqual({ page_size: 3, filter: { q: 'x' } });
  });

  // commit_token is the preview gate's field, and the gate only runs on
  // dangerous tools. Dropping it there is belt-and-suspenders; dropping it on a
  // non-dangerous tool would swallow a field the tool legitimately owns (the
  // mass-action commit token minted by the backend's own preview verb).
  it('drops commit_token on a dangerous tool (gate-owned field)', () => {
    const t = tool({ dangerous: true, annotations: { title: 't', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } });
    const { body } = buildRequest(ctx(t, { page_size: 3, commit_token: 'zz' }));
    expect(body).toEqual({ page_size: 3 });
  });

  it('forwards commit_token on a non-dangerous tool (the tool owns the field)', () => {
    const t = tool({ operation: 'create', envelope: 'create' });
    const { body } = buildRequest(ctx(t, { plan: { steps: [] }, commit_token: 'backend.token' }));
    expect(body).toEqual({ plan: { steps: [] }, commit_token: 'backend.token' });
  });

  it('GET get: substitutes {sid} and sends the rest as query', () => {
    const t = tool({ route: { service: 'linkedin', method: 'GET', pathTemplate: '/api/x/{sid}' }, operation: 'get', envelope: 'get' });
    const { url, body } = buildRequest(ctx(t, { sid: 'ln_ac_abcdefgh123', include: ['a', 'b'], _meta: {} }));
    expect(body).toBeUndefined();
    expect(url).toBe('http://backend/api/x/ln_ac_abcdefgh123?include%5B%5D=a&include%5B%5D=b');
  });

  it('POST action: {sid} in path, remaining fields in body', () => {
    const t = tool({ route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/x/{sid}/reset-sync' }, operation: 'action', envelope: 'action_async' });
    const { url, body } = buildRequest(ctx(t, { sid: 'ln_ac_abcdefgh123', types: ['messaging'] }));
    expect(url).toBe('http://backend/api/x/ln_ac_abcdefgh123/reset-sync');
    expect(body).toEqual({ types: ['messaging'] });
  });
});
