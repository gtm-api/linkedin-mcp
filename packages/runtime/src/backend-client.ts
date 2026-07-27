import type { DispatchContext } from './types';
import { buildRequest } from './url';

export type BackendResult =
  | { kind: 'ok'; status: number; envelope: unknown }
  | { kind: 'transport_error'; reason: 'timeout' | 'network' | 'non_json'; status?: number; detail: string };

// Single backend call for one tool. Attaches auth + trace headers, times out
// via AbortController, and returns any JSON body (incl. 4xx/5xx error
// envelopes) as kind:'ok' - only non-JSON / network / timeout is a
// transport_error. Never throws.
export async function backendFetch(ctx: DispatchContext): Promise<BackendResult> {
  const { tool, scope, deps } = ctx;
  const { url, body } = buildRequest(ctx);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.config.backendTimeoutMs);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${scope.token}`,
    Accept: 'application/json',
    'X-Trace-Id': scope.traceId,
  };
  if (scope.teamSid) headers['Team-SID'] = scope.teamSid;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  try {
    const res = await fetch(url, {
      method: tool.route.method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!text) return { kind: 'ok', status: res.status, envelope: {} };
    try {
      return { kind: 'ok', status: res.status, envelope: JSON.parse(text) };
    } catch {
      return { kind: 'transport_error', reason: 'non_json', status: res.status, detail: text.slice(0, 500) };
    }
  } catch (err) {
    const isAbort = (err as { name?: string })?.name === 'AbortError';
    return {
      kind: 'transport_error',
      reason: isAbort ? 'timeout' : 'network',
      detail: String((err as { message?: string })?.message ?? err),
    };
  } finally {
    clearTimeout(timer);
  }
}
