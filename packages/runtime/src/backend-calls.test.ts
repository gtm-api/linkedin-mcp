import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { backendFetch } from './backend-client';
import { withBackendCalls } from './backend-calls';
import type { AuthScope, DispatchContext, RuntimeDeps, ToolDefinition } from './types';

// What the wide event says about each backend call of a message: the status and
// the time to the response headers once they came, the time to the end, the
// response's cf-ray, and the error when no usable answer came. The point is to
// tell a call lost on Cloudflare's leg (no headers by the fuse) from a slow
// backend or a body that stalled after the headers.

const TRACE = '0190f0aa-1111-7222-8333-444455556666';
const RAY = '8f00000000000001-AMS';
const FUSE = 55_000;

function mkCtx(pathTemplate = '/api/things/search'): DispatchContext {
  return {
    tool: {
      name: 'search_things',
      route: { service: 'linkedin', method: 'POST', pathTemplate },
      dangerous: false,
      inputSchema: z.object({}),
    } as unknown as ToolDefinition,
    args: { page_size: 5 },
    scope: { token: 'jwt', teamSid: null, actor: { type: 'user', sid: null }, permissions: [], traceId: TRACE, mountPath: '/mcp' } as AuthScope,
    deps: { config: { baseUrls: { linkedin: 'http://linkedin.test' }, backendTimeoutMs: FUSE } } as unknown as RuntimeDeps,
  };
}

const answer = (body: ConstructorParameters<typeof Response>[0], status = 200, headers: Record<string, string> = { 'cf-ray': RAY }) =>
  new Response(body, { status, headers });

/** A fetch that never answers and rejects when the fuse aborts it, as a real fetch does. */
const hangingFetch = () =>
  vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
  );

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('backend calls on the wide event', () => {
  it('notes a call that answered: its status, the time to its headers and to its end, its ray', async () => {
    const fetchSpy = vi.fn(async () => answer('{"success":true}'));
    vi.stubGlobal('fetch', fetchSpy);

    const { result, calls } = await withBackendCalls(() => backendFetch(mkCtx()));

    expect(result.kind).toBe('ok');
    expect(calls).toEqual([
      { svc: 'linkedin', kind: 'tool', status: 200, hdr_ms: expect.any(Number), ms: expect.any(Number), ray: RAY },
    ]);
    // The trace id the gateway and the backend log goes out with the call.
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-Trace-Id']).toBe(TRACE);
  });

  // route.headerParams: the bound argument goes out as a header beside the three
  // every call carries, and never in the body (2026-11-13, Email-Box-SID).
  it('sends a header the route binds, out of the body, beside its own', async () => {
    const fetchSpy = vi.fn(async () => answer('{"success":true}'));
    vi.stubGlobal('fetch', fetchSpy);

    const ctx = mkCtx();
    ctx.tool = { ...ctx.tool, route: { ...ctx.tool.route, headerParams: { 'Email-Box-SID': 'email_box_sid' } } };
    ctx.args = { page_size: 5, email_box_sid: 'em_bx_Hx7kQ3mN2pL4' };
    await backendFetch(ctx);

    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Email-Box-SID']).toBe('em_bx_Hx7kQ3mN2pL4');
    expect(headers.Authorization).toBe('Bearer jwt');
    expect(headers['X-Trace-Id']).toBe(TRACE);
    expect(JSON.parse(init.body as string)).toEqual({ page_size: 5 });
  });

  // Header names are case-insensitive on the wire: `authorization` beside the
  // client's own `Authorization` would reach the backend as one header with two
  // values. The registry refuses such a binding; a tool that got past it never
  // leaves the worker.
  it('makes no call for a route that binds a header the client sets itself', async () => {
    const fetchSpy = vi.fn(async () => answer('{"success":true}'));
    vi.stubGlobal('fetch', fetchSpy);

    const ctx = mkCtx();
    ctx.tool = { ...ctx.tool, route: { ...ctx.tool.route, headerParams: { authorization: 'forged' } } };
    ctx.args = { page_size: 5, forged: 'Bearer other' };

    await expect(backendFetch(ctx)).rejects.toThrow(/set by the runtime/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('notes a call whose headers never came as a timeout at the fuse, with no status', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangingFetch());

    const pending = withBackendCalls(() => backendFetch(mkCtx()));
    await vi.advanceTimersByTimeAsync(FUSE);
    const { result, calls } = await pending;

    expect(result).toMatchObject({ kind: 'transport_error', reason: 'timeout' });
    expect(calls).toEqual([{ svc: 'linkedin', kind: 'tool', ms: FUSE, err: 'timeout' }]);
  });

  it('keeps the status and the time to headers of an answer whose body the fuse cut', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) =>
        answer(
          new ReadableStream({
            start(controller) {
              init.signal?.addEventListener('abort', () =>
                controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })),
              );
            },
          }),
        ),
      ),
    );

    const pending = withBackendCalls(() => backendFetch(mkCtx()));
    await vi.advanceTimersByTimeAsync(FUSE);
    const { calls } = await pending;

    expect(calls).toEqual([{ svc: 'linkedin', kind: 'tool', status: 200, hdr_ms: 0, ms: FUSE, ray: RAY, err: 'timeout' }]);
  });

  it('notes a body that is not JSON with its status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer('<html>502 Bad Gateway</html>', 502)));

    const { calls } = await withBackendCalls(() => backendFetch(mkCtx()));

    expect(calls).toEqual([
      { svc: 'linkedin', kind: 'tool', status: 502, hdr_ms: expect.any(Number), ms: expect.any(Number), ray: RAY, err: 'non_json' },
    ]);
  });

  it('notes a fetch that threw as a network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))));

    const { calls } = await withBackendCalls(() => backendFetch(mkCtx()));

    expect(calls).toEqual([{ svc: 'linkedin', kind: 'tool', ms: expect.any(Number), err: 'network' }]);
  });

  it('names the validate twin and the preview route, in the order they were sent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer('{"success":true}', 200, {})));

    const { calls } = await withBackendCalls(async () => {
      await backendFetch(mkCtx(), { validateOnly: true });
      await backendFetch(mkCtx(), { kind: 'preview' });
      await backendFetch(mkCtx());
    });

    expect(calls.map((c) => c.kind)).toEqual(['validate', 'preview', 'tool']);
    // No cf-ray on the answer, no ray on the note.
    expect(calls.every((c) => !('ray' in c))).toBe(true);
  });

  it('gives each message only its own calls while two are in flight in one isolate', async () => {
    let releaseA: () => void = () => {};
    const aGate = new Promise<void>((resolve) => (releaseA = resolve));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/api/a')) {
          await aGate;
          return answer('{}', 201);
        }
        return answer('{}', 202);
      }),
    );

    const a = withBackendCalls(() => backendFetch(mkCtx('/api/a')));
    const b = withBackendCalls(() => backendFetch(mkCtx('/api/b')));
    const { calls: bCalls } = await b;
    releaseA();
    const { calls: aCalls } = await a;

    expect(aCalls.map((c) => c.status)).toEqual([201]);
    expect(bCalls.map((c) => c.status)).toEqual([202]);
  });

  it('notes nothing and throws nothing outside a message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer('{"success":true}')));

    await expect(backendFetch(mkCtx())).resolves.toMatchObject({ kind: 'ok', status: 200 });
  });
});
