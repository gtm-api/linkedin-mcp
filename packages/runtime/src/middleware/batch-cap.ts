// JSON-RPC batch cap.
//
// This is the one control in this directory that is NOT a ToolMiddleware, and
// it cannot be: the thing being capped is the JSON-RPC envelope, which the
// transport unwraps before any tool exists. It lives here anyway because it is
// the same class of control as its neighbours and belongs where the next person
// looks for them. apps/worker/src/index.ts calls it once, between parsing the
// body and building the chain.
//
// What it stops: the worker loops an array of JSON-RPC messages and gives each
// one a backend call with a 25s timeout, from a public URL that answers
// Access-Control-Allow-Origin '*'. Without a cap, one POST carrying a
// thousand-element array is a thousand-deep fan-out into our own services,
// authored by whoever holds any valid bearer.
//
// ── The number ──────────────────────────────────────────────────────────────
// 16. Two independent ceilings put it there, and the tighter one wins:
//
//   Cloudflare subrequests. A Worker invocation may make 50 subrequests on the
//   Free plan and 1000 on Paid, and KV reads and writes count too. Worst case
//   per batch element here is 1 backend fetch plus the preview gate's 2 KV ops
//   on a dangerous tool, so 3. 16 x 3 = 48, which fits under 50, so the cap
//   holds on EITHER plan rather than quietly depending on which one we are on.
//
//   Wall clock. The loop is sequential and each element gets backendTimeoutMs
//   (25s). Sixteen slow elements is already 400s of hanging request; anything
//   larger is not a batch, it is a denial of service against ourselves.
//
// The generosity check runs the other way: MCP revision 2025-06-18 REMOVED
// JSON-RPC batching from the protocol, so a current client sends exactly one
// message per POST. 16 is sixteen times what any real caller needs, and no
// agent that talks to this server has ever sent two.

/** JSON-RPC 2.0 error response, id null (the batch as a whole is rejected). */
export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: null;
  error: { code: number; message: string; data: Record<string, unknown> };
}

export interface BatchRejection {
  status: 400 | 413;
  body: JsonRpcErrorResponse;
}

export const DEFAULT_MAX_BATCH_SIZE = 16;

/**
 * `null` when the batch may proceed. Covers both ends: JSON-RPC 2.0 §6 makes an
 * empty array an Invalid Request, and today an empty array walks the whole
 * request to a 202 with nothing done, which tells the caller nothing.
 */
export function checkBatchSize(size: number, limit: number): BatchRejection | null {
  if (size === 0) {
    return {
      status: 400,
      body: {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32600,
          message: 'Invalid Request: an empty JSON-RPC batch has nothing to execute.',
          data: { reason: 'empty_batch' },
        },
      },
    };
  }
  if (size <= limit) return null;
  return {
    status: 413,
    body: {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32600,
        message:
          `Invalid Request: this batch carries ${size} JSON-RPC messages and the server accepts at most ` +
          `${limit}. Nothing in it ran. Each message costs one backend call with a 25s timeout, so a large ` +
          'batch is a fan-out, not a speed-up. Split it into requests of at most ' +
          `${limit} messages, or send one message per request (the current MCP revision has no batching ` +
          'at all, so one per request is what clients do).',
        data: { reason: 'batch_too_large', received: size, max_batch_size: limit },
      },
    },
  };
}
