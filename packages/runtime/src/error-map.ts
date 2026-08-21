import type { DispatchContext, ToolResult } from './types';

// The backend error envelope (McpException::render). `meta` is present only on
// delete_blocked; most errors omit it.
interface ErrorEnvelope {
  success: false;
  error: {
    code: string;
    message: string;
    recoverable?: boolean;
    suggestion?: string;
    field_errors?: Record<string, Array<{ rule?: string; message?: string } | string>>;
    blockers?: Array<Record<string, unknown>>;
    context?: Record<string, unknown>;
  };
  meta?: { trace_id?: string; debug_url?: string };
}

function traceFooter(env: ErrorEnvelope): string[] {
  const out: string[] = [];
  if (env.meta?.trace_id) out.push(`trace: ${env.meta.trace_id}`);
  if (env.meta?.debug_url) out.push(`debug: ${env.meta.debug_url}`);
  return out;
}

// Map a backend error envelope to an MCP tool result. Never throws; always
// isError:true with actionable, code-specific guidance for the model.
export function mapErrorEnvelope(
  status: number,
  env: ErrorEnvelope,
  ctx: DispatchContext,
): ToolResult {
  const e = env.error ?? { code: 'internal_error', message: 'Unknown error' };
  const code = e.code ?? 'internal_error';
  const tool = ctx.tool.name;
  const lines: string[] = [];

  switch (code) {
    case 'validation_failed': {
      lines.push(`Validation failed for ${tool}:`);
      for (const [field, errs] of Object.entries(e.field_errors ?? {})) {
        for (const fe of errs) {
          const text = typeof fe === 'string' ? fe : `${fe.message ?? ''}${fe.rule ? ` [${fe.rule}]` : ''}`;
          lines.push(`  • ${field}: ${text}`);
        }
      }
      if (e.suggestion) lines.push(e.suggestion);
      break;
    }
    case 'nothing_to_update':
    case 'relation_not_found':
      lines.push(e.message);
      if (e.suggestion) lines.push(e.suggestion);
      break;
    case 'not_found':
      lines.push(e.message);
      lines.push(e.suggestion ?? 'Verify the sid, or use the matching search tool to look it up.');
      break;
    case 'invalid_transition':
    case 'duplicate_rejected':
    case 'conflict':
      lines.push(e.message);
      if (e.context) lines.push(`context: ${JSON.stringify(e.context)}`);
      if (e.suggestion) lines.push(e.suggestion);
      break;
    case 'delete_blocked': {
      lines.push(e.message);
      for (const b of e.blockers ?? []) {
        lines.push(`  • [${b.severity}] ${b.description} -> ${b.resolution_hint ?? b.resolution ?? ''}`);
      }
      break;
    }
    case 'rate_limited':
    case 'limit_exceeded': {
      lines.push(e.message);
      const retry = (e.context?.retry_after as number | undefined);
      if (retry != null) lines.push(`Retryable: retry after ${retry}s.`);
      else lines.push('Retryable after a short backoff.');
      break;
    }
    // 402. Every one of these is a slot/plan decision (seat cap, add-on headroom,
    // webhook cap), never a transient failure, and the backend ships a
    // machine-readable code plus a `context` that usually names the repair
    // (insufficient_proxy_5g_slots carries suggested_action: buy_proxy_5g_slot),
    // so the context is surfaced rather than dropped.
    case 'payment_required':
      lines.push(e.message);
      if (e.context) lines.push(`context: ${JSON.stringify(e.context)}`);
      lines.push('This is a plan/quota decision, not a transient failure. Inspect the workspace plan with search_billing_subscriptions or get_billing_subscription, and the catalog with search_billing_products; buying more capacity is add_billing_subscription_addon / change_billing_subscription.');
      break;
    case 'unauthorized':
      lines.push(e.message);
      lines.push('The backend rejected the token (likely expired). Ask the user to reconnect the GTM connector.');
      break;
    // 403. Three shapes hide behind one code, and the difference decides what the
    // model should do next, so they are split rather than dumped as a JSON blob.
    // The backend gate (CheckPermissions) puts a machine-readable `reason` in
    // context; the permission ones also carry the exact token.
    case 'forbidden': {
      const reason = typeof e.context?.reason === 'string' ? e.context.reason : undefined;
      const required =
        typeof e.context?.required_permission === 'string' ? e.context.required_permission : undefined;

      if (reason === 'scope_missing' && required) {
        // The single most likely 403 after permission enforcement went on. Retrying
        // is pointless: the token set is frozen on this connection. Both repair
        // paths are named because which one applies depends on how the caller
        // connected, and the model cannot tell from here.
        lines.push(`${tool} requires the '${required}' permission and this connection does not carry it.`);
        lines.push(
          `Two ways to fix it, both needing a human: ask a workspace admin to add '${required}' to the member's permissions, or reconnect the GTM connector and consent to a scope that includes it.`,
        );
        lines.push('Do not retry with the same credentials, and do not try a different tool to get the same data: the answer will not change until the permission is granted.');
      } else if (reason === 'route_not_declared') {
        lines.push(`${tool} was refused by the server's permission gate because the route it calls declares no required permission.`);
        lines.push('This is a server-side configuration gap, not a missing permission on your side. Nothing the caller can grant will unblock it. Report it with the trace id below.');
      } else {
        lines.push(e.message);
        if (e.context) lines.push(`context: ${JSON.stringify(e.context)}`);
        lines.push('Do not retry: a 403 is a decision about the caller, not a transient failure.');
      }
      break;
    }
    case 'not_implemented':
      lines.push(`${tool} is planned but not shipped yet. The contract is locked, the capability lands in a future release.`);
      lines.push('Do not retry; pick an alternative tool or ask the user how to proceed.');
      break;
    case 'service_unavailable':
      lines.push(e.message);
      lines.push('Temporary: retry in a few seconds.');
      break;
    case 'internal_error':
    default:
      lines.push(e.message || 'Internal error.');
      lines.push('Unexpected server error. Share the trace id below with support.');
      break;
  }

  lines.push('', ...traceFooter(env));
  return {
    content: [{ type: 'text', text: lines.filter((l) => l !== undefined).join('\n').trimEnd() }],
    isError: true,
    structuredContent: env as unknown as Record<string, unknown>,
  };
}

// A backend HTTP error whose body is NOT the platform error envelope
// (`{success:false, error:{...}}`): a gateway or framework layer answered
// before any controller ran. Live case 2026-08-21: a Laravel 422 minted during
// auth resolution (raw `{message, errors}` body) fell through to
// renderSuccess, the caller read it as a tool-argument problem, and the wide
// event logged ok:true. Never a success. Name the layer honestly so the model
// does not go debugging its arguments, and surface what the body did say.
export function httpErrorResult(
  ctx: DispatchContext,
  status: number,
  body: unknown,
): ToolResult {
  const b = (body ?? {}) as { message?: unknown; errors?: unknown };
  const lines: string[] = [
    `${ctx.tool.name} failed: the backend rejected the call with HTTP ${status} outside the tool's own contract (no MCP error envelope).`,
    'This usually comes from an infrastructure or middleware layer, not from the tool arguments.',
  ];
  if (typeof b.message === 'string' && b.message !== '') lines.push(b.message);
  // Laravel's validation shape ({field: [messages]}) is the known offender;
  // flatten it so the actual reason is readable.
  if (b.errors && typeof b.errors === 'object') {
    for (const [field, fieldMessages] of Object.entries(b.errors as Record<string, unknown>)) {
      for (const m of Array.isArray(fieldMessages) ? fieldMessages : [fieldMessages]) {
        lines.push(`  • ${field}: ${typeof m === 'string' ? m : JSON.stringify(m)}`);
      }
    }
  }
  lines.push(
    status >= 500
      ? 'Server-side failure: a retry may help; if it persists, report it with the body above.'
      : 'Rewording the arguments will not fix this; report it with the body above if it is not a header/credential problem on your side.',
  );
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    isError: true,
    structuredContent: body && typeof body === 'object' ? (body as Record<string, unknown>) : { body },
  };
}

export function transportErrorResult(
  ctx: DispatchContext,
  err: { reason: string; status?: number; detail: string },
): ToolResult {
  const lines = [
    `${ctx.tool.name} could not reach the backend (${err.reason}).`,
  ];
  if (err.status) lines.push(`HTTP ${err.status}.`);
  if (err.reason === 'timeout') lines.push('The request timed out. Retry, or narrow the query.');
  else lines.push('This is a transport/gateway problem, not a bad request. Retry shortly.');
  if (err.detail) lines.push(`detail: ${err.detail.slice(0, 300)}`);
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    isError: true,
  };
}
