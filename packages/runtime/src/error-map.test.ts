import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { mapErrorEnvelope } from './error-map';
import type { DispatchContext, RuntimeDeps, ToolDefinition } from './types';

const deps = {
  config: { envName: 'test', version: '0', baseUrls: { linkedin: '', id: '', orchestration: '', support: '' }, backendTimeoutMs: 1, responseCharBudget: 1, maxBatchSize: 16, rateLimit: { enabled: false, windowSeconds: 60, callsPerWindow: 0, writesPerWindow: 0 }, previewGate: { enabled: false, secret: null, ttlSeconds: 1 } },
  logger: { info() {}, error() {} },
} as RuntimeDeps;

const tool: ToolDefinition = {
  name: 'get_linkedin_account', description: 'd', service: 'linkedin', entity: 'e', mount: 'm',
  route: { service: 'linkedin', method: 'GET', pathTemplate: '/api/x/{sid}' },
  operation: 'get', envelope: 'get', availability: 'ga', dangerous: false,  inputSchema: z.object({ _meta: z.any().optional() }), outputSchema: z.any(),
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

  it('renders forbidden(scope_missing) with the token and both repair paths', () => {
    const r = mapErrorEnvelope(403, { success: false, error: { code: 'forbidden', message: 'Access denied: required scope is missing from the token', recoverable: false, context: { reason: 'scope_missing', required_permission: 'can_view_linkedin_accounts' } }, meta: { trace_id: 'tr-1' } }, ctx);
    expect(r.isError).toBe(true);
    const text = r.content[0].text;
    expect(text).toContain('can_view_linkedin_accounts');
    expect(text).toMatch(/workspace admin/i);
    expect(text).toMatch(/reconnect the GTM connector/i);
    expect(text).toMatch(/do not retry/i);
    expect(text).toMatch(/trace: tr-1/);
    // The raw JSON dump is what this case used to be; naming the token is the point.
    expect(text).not.toMatch(/context: \{/);
  });

  it('renders forbidden(route_not_declared) as a server-side gap, not a caller problem', () => {
    const r = mapErrorEnvelope(403, { success: false, error: { code: 'forbidden', message: 'Access denied', recoverable: false, context: { reason: 'route_not_declared', route: 'POST /api/x' } } }, ctx);
    expect(r.content[0].text).toMatch(/server-side/i);
    expect(r.content[0].text).not.toMatch(/workspace admin/i);
  });

  it('renders any other forbidden with its context and a do-not-retry', () => {
    const r = mapErrorEnvelope(403, { success: false, error: { code: 'forbidden', message: 'Access denied: user is not a member of this team', recoverable: false, context: { reason: 'wrong_team' } } }, ctx);
    expect(r.content[0].text).toMatch(/wrong_team/);
    expect(r.content[0].text).toMatch(/do not retry/i);
  });

  it('renders rate_limited with retry hint and trace footer', () => {
    const r = mapErrorEnvelope(429, { success: false, error: { code: 'rate_limited', message: 'slow down', recoverable: true, context: { retry_after: 42 } }, meta: { trace_id: 'abc' } }, ctx);
    expect(r.content[0].text).toMatch(/retry after 42s/i);
    expect(r.content[0].text).toMatch(/trace: abc/);
  });
});
