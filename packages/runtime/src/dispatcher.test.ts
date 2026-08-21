import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { dispatch } from './dispatcher';
import { backendFetch } from './backend-client';
import type { DispatchContext, RuntimeDeps, ToolDefinition } from './types';

// The status-vs-envelope decision table. Everything else in dispatch() is a
// pass-through to functions with their own suites (error-map, envelope); what
// belongs HERE is which renderer a given backend answer reaches. The one that
// was missing, and that this file exists to pin: an HTTP error whose body is
// NOT the platform envelope must never render as success (2026-08-21, the
// trace-id 422 that reached callers as a success-shaped result and logged
// ok:true).
vi.mock('./backend-client', () => ({ backendFetch: vi.fn() }));
const fetchMock = vi.mocked(backendFetch);

const deps = {
  config: { envName: 'test', version: '0', baseUrls: { linkedin: '', id: '', orchestration: '', support: '' }, backendTimeoutMs: 1, responseCharBudget: 1, maxBatchSize: 16, rateLimit: { enabled: false, windowSeconds: 60, callsPerWindow: 0, writesPerWindow: 0 }, previewGate: { enabled: false, secret: null, ttlSeconds: 1 } },
  logger: { info() {}, error() {} },
} as RuntimeDeps;

const tool: ToolDefinition = {
  name: 'search_linkedin_accounts', description: 'd', service: 'linkedin', entity: 'e', mount: 'm',
  route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-accounts/search' },
  operation: 'search', envelope: 'search', availability: 'ga', dangerous: false, inputSchema: z.object({ _meta: z.any().optional() }), outputSchema: z.any(),
  annotations: { title: 't', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
const ctx = { tool, args: {}, deps } as unknown as DispatchContext;

describe('dispatch status/envelope routing', () => {
  it('renders a 2xx platform envelope as success', async () => {
    fetchMock.mockResolvedValueOnce({ kind: 'ok', status: 200, envelope: { success: true, data: [] } });
    const r = await dispatch(ctx);
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toMatchObject({ success: true });
  });

  it('routes a platform error envelope to the code-specific mapper', async () => {
    fetchMock.mockResolvedValueOnce({
      kind: 'ok', status: 404,
      envelope: { success: false, error: { code: 'not_found', message: 'no such sid' } },
    });
    const r = await dispatch(ctx);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/no such sid/);
  });

  it('never renders an HTTP error without the platform envelope as success', async () => {
    // The 2026-08-21 live body: Laravel's own validation rendering, no
    // `success` field at all, minted by an auth-layer throw.
    fetchMock.mockResolvedValueOnce({
      kind: 'ok', status: 422,
      envelope: { message: 'The trace id field must be a valid UUID.', errors: { trace_id: ['The trace id field must be a valid UUID.'] } },
    });
    const r = await dispatch(ctx);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/HTTP 422/);
    expect(r.content[0].text).toMatch(/not from the tool arguments/i);
  });

  it('treats an empty-body 5xx the same way', async () => {
    fetchMock.mockResolvedValueOnce({ kind: 'ok', status: 502, envelope: {} });
    const r = await dispatch(ctx);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/HTTP 502/);
  });

  it('still renders transport failures via the transport path', async () => {
    fetchMock.mockResolvedValueOnce({ kind: 'transport_error', reason: 'timeout', detail: 'abort' });
    const r = await dispatch(ctx);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/timeout/i);
  });
});
