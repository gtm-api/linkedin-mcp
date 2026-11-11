import { AsyncLocalStorage } from 'node:async_hooks';

// What the wide event of one JSON-RPC message says about the backend calls it
// made: the worker's `backend` field (apps/worker/src/index.ts), one entry per
// call, in the order they were sent.
//
// Why (2026-11-11): of the 295 calls this worker cut at 25 s in the 14 days
// before, 98 were lost on Cloudflare's leg between the worker and the gateway,
// and the wide event could not tell them from a slow backend: it held neither
// whether the response headers ever came back, nor when, nor under which
// Cloudflare ray. The gateway's and the backends' access logs now carry the same
// trace id and the ray (gtm.deployment.ansible,
// roles/nginx/templates/log-trace-maps.conf.j2), so one call reads as one query
// from this event down to the PHP process.

export type BackendCallKind =
  /** The tool's own route. */
  | 'tool'
  /** The preview gate's validate twin (`/api/_validate/...`). */
  | 'validate'
  /** The preview gate's dry run of a tool that declares a previewRoute. */
  | 'preview'
  /** The team scope's token exchange on id (`/oauth/token`). */
  | 'token';

/** Why a call brought back no usable answer: the fuse fired, the fetch threw, or the body was not JSON. */
export type BackendCallError = 'timeout' | 'network' | 'non_json';

export interface BackendCallNote {
  /** The service the call went to. */
  svc: string;
  kind: BackendCallKind;
  /** The HTTP status, once the response headers arrived. */
  status?: number;
  /** Milliseconds from the send to the response headers. */
  hdr_ms?: number;
  /** Milliseconds from the send to the end of the call: the body read, or the error. */
  ms: number;
  /** The response's cf-ray header: Cloudflare's id of the request, the one a ticket to Cloudflare names. */
  ray?: string;
  err?: BackendCallError;
}

/** The part of a Response the timer reads, so a test can hand it anything that answers. */
interface AnsweredHeaders {
  status: number;
  headers: { get(name: string): string | null };
}

export interface BackendCallTimer {
  /** The response headers arrived. */
  headers(res: AnsweredHeaders): void;
  /** The call ends without a usable answer. */
  fail(reason: BackendCallError): void;
  /** The call is over: note it. Call once, from a `finally`. */
  end(): void;
}

const storage = new AsyncLocalStorage<BackendCallNote[]>();

/**
 * Runs `fn` with a list of its own, which every backend call made inside it is
 * noted in. One list per JSON-RPC message: concurrent requests in one isolate
 * each see only their own calls (the same AsyncLocalStorage reasoning as
 * auth-scope.ts).
 */
export async function withBackendCalls<T>(fn: () => Promise<T>): Promise<{ result: T; calls: BackendCallNote[] }> {
  const calls: BackendCallNote[] = [];
  const result = await storage.run(calls, fn);
  return { result, calls };
}

/**
 * Times one backend call from its send. Outside withBackendCalls (a test that
 * calls backendFetch directly) the note goes nowhere.
 */
export function startBackendCall(svc: string, kind: BackendCallKind): BackendCallTimer {
  const t0 = Date.now();
  let status: number | undefined;
  let hdrMs: number | undefined;
  let ray: string | null = null;
  let err: BackendCallError | undefined;
  return {
    headers(res) {
      status = res.status;
      hdrMs = Date.now() - t0;
      ray = res.headers.get('cf-ray');
    },
    fail(reason) {
      err = reason;
    },
    end() {
      storage.getStore()?.push({
        svc,
        kind,
        ...(status !== undefined ? { status, hdr_ms: hdrMs } : {}),
        ms: Date.now() - t0,
        ...(ray ? { ray } : {}),
        ...(err ? { err } : {}),
      });
    },
  };
}
