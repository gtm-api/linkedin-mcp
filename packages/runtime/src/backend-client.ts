import type { DispatchContext } from './types';
import { buildRequest } from './url';
import { startBackendCall } from './backend-calls';

export type BackendResult =
  | { kind: 'ok'; status: number; envelope: unknown }
  | { kind: 'transport_error'; reason: 'timeout' | 'network' | 'non_json'; status?: number; detail: string };

// Single backend call for one tool. Attaches auth + trace headers and the
// route's own (route.headerParams), times out
// via AbortController, and returns any JSON body (incl. 4xx/5xx error
// envelopes) as kind:'ok' - only non-JSON / network / timeout is a
// transport_error. Never throws. The fuse is the config's backendTimeoutMs (55 s
// by default, apps/worker/src/config.ts says why); `timeoutMs` overrides it for
// the calls that must stay short (the preview gate's validate twin and preview
// route). Every call is noted for the message's wide event (backend-calls.ts):
// `validateOnly` marks the validate twin, `kind: 'preview'` the preview route.
export async function backendFetch(
  ctx: DispatchContext,
  opts: { validateOnly?: boolean; timeoutMs?: number; kind?: 'tool' | 'preview' } = {},
): Promise<BackendResult> {
  const { tool, scope, deps } = ctx;
  const { url, body, headers: routeHeaders } = buildRequest(ctx, opts);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? deps.config.backendTimeoutMs);

  // The route's own headers (route.headerParams, e.g. Email-Box-SID). None of
  // them is one of the headers set below: buildRequest refuses that binding.
  const headers: Record<string, string> = {
    ...routeHeaders,
    Authorization: `Bearer ${scope.token}`,
    Accept: 'application/json',
    'X-Trace-Id': scope.traceId,
  };
  if (scope.teamSid) headers['Team-SID'] = scope.teamSid;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const call = startBackendCall(tool.route.service, opts.validateOnly ? 'validate' : (opts.kind ?? 'tool'));
  try {
    const res = await fetch(url, {
      method: tool.route.method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    call.headers(res);
    const text = await res.text();
    if (!text) return { kind: 'ok', status: res.status, envelope: {} };
    try {
      return { kind: 'ok', status: res.status, envelope: JSON.parse(text) };
    } catch {
      call.fail('non_json');
      return { kind: 'transport_error', reason: 'non_json', status: res.status, detail: text.slice(0, 500) };
    }
  } catch (err) {
    const isAbort = (err as { name?: string })?.name === 'AbortError';
    call.fail(isAbort ? 'timeout' : 'network');
    return {
      kind: 'transport_error',
      reason: isAbort ? 'timeout' : 'network',
      detail: String((err as { message?: string })?.message ?? err),
    };
  } finally {
    clearTimeout(timer);
    call.end();
  }
}
