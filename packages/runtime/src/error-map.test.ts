import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { httpErrorResult, mapErrorEnvelope, transportErrorResult } from './error-map';
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

  it('renders forbidden(not_a_user_actor) as a dead end, not a missing scope', () => {
    const r = mapErrorEnvelope(403, { success: false, error: { code: 'forbidden', message: 'An API key is a standalone identity with its own permissions, not a person, so there is no current user behind this request.', recoverable: false, suggestion: 'Authenticate as a user (sign in to the app, or connect through OAuth) when you need the profile of the person behind a request.', context: { reason: 'not_a_user_actor', actor_type: 'api_key', actor_sid: 'id_ak_GAU6zPYwbVf9' } } }, ctx);
    const text = r.content[0].text;
    expect(text).toMatch(/standalone identity/);
    expect(text).toMatch(/connect through OAuth/);
    expect(text).toMatch(/do not switch tools/i);
    // Not a permission problem: the scope_missing copy must not leak in here.
    expect(text).not.toMatch(/workspace admin/i);
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

  it('renders a timestamp retry_after as a clock, not as seconds, and keeps the suggestion', () => {
    const r = mapErrorEnvelope(429, { success: false, error: { code: 'rate_limited', message: 'cooldown', recoverable: true, suggestion: 'Refresh the thread first.', context: { reason: 'recruiter_inmail_cooldown', retry_after: '2026-09-05T10:00:00+00:00' } } }, ctx);
    expect(r.content[0].text).toMatch(/retry after 2026-09-05T10:00:00\+00:00\./);
    expect(r.content[0].text).not.toMatch(/00:00s/);
    expect(r.content[0].text).toMatch(/Refresh the thread first\./);
  });
});

describe('httpErrorResult (backend error without the platform envelope)', () => {
  it('renders a raw Laravel 422 as isError, naming the layer, not the arguments', () => {
    // The 2026-08-21 live shape: AccessIdentityValue's uuid rule threw during
    // auth resolution and Laravel rendered its own validation body.
    const r = httpErrorResult(ctx, 422, {
      message: 'The trace id field must be a valid UUID.',
      errors: { trace_id: ['The trace id field must be a valid UUID.'] },
    });
    expect(r.isError).toBe(true);
    const text = r.content[0].text;
    expect(text).toMatch(/HTTP 422/);
    expect(text).toMatch(/no MCP error envelope/i);
    expect(text).toMatch(/not from the tool arguments/i);
    expect(text).toMatch(/trace_id: The trace id field must be a valid UUID\./);
    expect(r.structuredContent).toMatchObject({ message: 'The trace id field must be a valid UUID.' });
  });

  it('renders a bodyless 5xx as isError with a retry hint', () => {
    const r = httpErrorResult(ctx, 502, {});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/HTTP 502/);
    expect(r.content[0].text).toMatch(/retry may help/i);
  });

  it('wraps a non-object body instead of dropping it', () => {
    const r = httpErrorResult(ctx, 403, 'nope');
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({ body: 'nope' });
  });
});

// A timeout is this server giving up on the wait, not the backend refusing: the
// backend may have completed the call. Until 2026-09-28 every timeout said
// "retry" and a scrape that had completed was run again at a second slot (the
// MCP audit report, 17.09 item 15).
describe('transportErrorResult on a timeout', () => {
  const timeout = { reason: 'timeout', detail: 'AbortError' };
  const writeTool = (over: Partial<ToolDefinition>): ToolDefinition => ({
    ...tool,
    operation: 'action', envelope: 'action',
    annotations: { title: 't', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    ...over,
  });

  it('lets a read retry', () => {
    const r = transportErrorResult(({ tool, args: {} } as unknown as DispatchContext), timeout);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('A read repeats safely');
  });

  it('tells a scrape with an idempotency_key to retry with the same key', () => {
    const scrape = writeTool({
      name: 'scrape_linkedin_search_people',
      inputSchema: z.object({ url: z.string(), idempotency_key: z.string().optional(), _meta: z.any().optional() }),
    });
    const r = transportErrorResult(({ tool: scrape, args: { url: 'https://x', idempotency_key: 'walk-42-p3' } } as unknown as DispatchContext), timeout);
    expect(r.content[0].text).toContain('may have completed the call');
    expect(r.content[0].text).toContain('SAME idempotency_key (walk-42-p3)');
    expect(r.content[0].text).not.toContain('Retry, or narrow');
  });

  it('tells a scrape without a key to read the ledger first and to carry a key from now on', () => {
    const scrape = writeTool({
      name: 'scrape_linkedin_search_people',
      inputSchema: z.object({ url: z.string(), idempotency_key: z.string().optional(), _meta: z.any().optional() }),
    });
    const r = transportErrorResult(({ tool: scrape, args: { url: 'https://x' } } as unknown as DispatchContext), timeout);
    expect(r.content[0].text).toContain('search_data_requests');
    expect(r.content[0].text).toContain('Pass an idempotency_key on every attempt');
  });

  it('tells a send to read the thread before sending again', () => {
    const send = writeTool({ name: 'send_linkedin_message' });
    const r = transportErrorResult(({ tool: send, args: {} } as unknown as DispatchContext), timeout);
    expect(r.content[0].text).toContain('must not be sent twice');
  });

  it('tells any other write to check what landed', () => {
    const post = writeTool({ name: 'create_linkedin_post' });
    const r = transportErrorResult(({ tool: post, args: {} } as unknown as DispatchContext), timeout);
    expect(r.content[0].text).toContain('Check first what landed');
  });

  it('keeps the plain retry line for a transport failure that is not a timeout', () => {
    const r = transportErrorResult(({ tool, args: {} } as unknown as DispatchContext), { reason: 'connection_refused', detail: 'ECONNREFUSED' });
    expect(r.content[0].text).toContain('Retry shortly');
  });
});
