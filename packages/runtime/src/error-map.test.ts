import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { mapErrorEnvelope } from './error-map';
import type { DispatchContext, RuntimeDeps, ToolDefinition } from './types';

const deps = {
  config: { envName: 'test', version: '0', baseUrls: { linkedin: '', id: '', orchestration: '', support: '' }, backendTimeoutMs: 1, responseCharBudget: 1, previewGate: { enabled: false, secret: null, ttlSeconds: 1 } },
  logger: { info() {}, error() {} },
} as RuntimeDeps;

const tool: ToolDefinition = {
  name: 'get_linkedin_account', description: 'd', service: 'linkedin', entity: 'e', mount: 'm',
  route: { service: 'linkedin', method: 'GET', pathTemplate: '/api/x/{sid}' },
  operation: 'get', envelope: 'get', availability: 'ga', dangerous: false, creditable: false,
  inputSchema: z.object({ _meta: z.any().optional() }), outputSchema: z.any(),
  annotations: { title: 't', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
const ctx = { tool } as DispatchContext;

describe('mapErrorEnvelope', () => {
  it('renders not_implemented as planned/do-not-retry', () => {
    const r = mapErrorEnvelope(501, { success: false, error: { code: 'not_implemented', message: 'nope', recoverable: false } }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/planned|not shipped/i);
    expect(r.content[0].text).toMatch(/do not retry/i);
  });

  it('renders validation_failed with field bullets', () => {
    const r = mapErrorEnvelope(422, { success: false, error: { code: 'validation_failed', message: 'bad', recoverable: true, field_errors: { sid: [{ rule: 'size', message: 'must be 18 chars' }] } } }, ctx);
    expect(r.content[0].text).toMatch(/sid: must be 18 chars/);
  });

  it('renders rate_limited with retry hint and trace footer', () => {
    const r = mapErrorEnvelope(429, { success: false, error: { code: 'rate_limited', message: 'slow down', recoverable: true, context: { retry_after: 42 } }, meta: { trace_id: 'abc' } }, ctx);
    expect(r.content[0].text).toMatch(/retry after 42s/i);
    expect(r.content[0].text).toMatch(/trace: abc/);
  });
});
