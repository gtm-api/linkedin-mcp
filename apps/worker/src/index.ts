import {
  buildRegistry,
  createServerFactory,
  makePreviewGate,
  resolveMounts,
  stubGate,
  runWithAuthScope,
  type AuthScope,
  type Logger,
  type ResolvedMount,
} from '@gtm/mcp-runtime';
import { linkedinPackages } from '@gtm/mcp-linkedin';
import { idPackages } from '@gtm/mcp-id';
import { orchestrationPackages } from '@gtm/mcp-orchestration';
import { supportPackages } from '@gtm/mcp-support';
import { MOUNTS } from './mounts.config';
import { buildRuntimeConfig, type Env } from './env';
import { kvCommitTokenStore } from './bindings';
import { makeVerifier } from './auth/verifier';
import { handleMcpMessage } from './transport';

// Env-independent: built once per isolate. A bad registry / over-budget mount
// throws here and the isolate fails fast.
const REGISTRY = buildRegistry([
  ...linkedinPackages,
  ...idPackages,
  ...orchestrationPackages,
  ...supportPackages,
]);
const RESOLVED = resolveMounts(REGISTRY, MOUNTS);
const MOUNT_BY_PATH = new Map<string, ResolvedMount>(RESOLVED.map((m) => [m.config.path, m]));
// Domain mounts form the facade's toolset catalog (the facade itself excluded).
const DOMAIN_MOUNTS = RESOLVED.filter((m) => m.config.facade !== 'toolsets');

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Accept, Authorization, Team-SID, X-Trace-Id, Mcp-Protocol-Version, Mcp-Session-Id',
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS, ...extra },
  });
}

const logger: Logger = {
  info: (event) => console.log(JSON.stringify({ time: new Date().toISOString(), level: 'info', ...event })),
  error: (event) => console.error(JSON.stringify({ time: new Date().toISOString(), level: 'error', ...event })),
};

// Distil one JSON-RPC message + its response into the fields we log: the method,
// the tool being called (resolved THROUGH the facade - `call_tool` unwraps to the
// real inner tool, shown as `call_tool→<tool>`), and whether it succeeded.
function summarizeCall(
  msg: unknown,
  resp: unknown,
): { method?: string; tool?: string; ok: boolean } {
  const m = msg as
    | { method?: string; params?: { name?: string; arguments?: { name?: string } } }
    | null;
  const r = resp as { error?: unknown; result?: { isError?: boolean } } | null;
  const method = m?.method;
  let tool: string | undefined;
  if (method === 'tools/call') {
    tool = m?.params?.name;
    const inner = m?.params?.arguments?.name;
    if (tool === 'call_tool' && inner) tool = `call_tool→${inner}`;
  }
  const ok = r == null ? true : r.error == null && r.result?.isError !== true;
  return { method, tool, ok };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === '/health') {
      return json({
        status: 'ok',
        env: env.ENV_NAME ?? 'local',
        version: '0.0.0',
        gate: env.PREVIEW_TOKEN_SECRET ? 'armed' : 'off',
        mounts: RESOLVED.map((m) => ({ path: m.config.path, tools: m.tools.length })),
        tools: REGISTRY.byName.size,
      });
    }

    if (url.pathname === '/.well-known/oauth-protected-resource') {
      return json({
        resource: env.MCP_RESOURCE_URL,
        authorization_servers: env.AUTH_ISSUER ? [env.AUTH_ISSUER] : [],
        bearer_methods_supported: ['header'],
      });
    }

    const mount = MOUNT_BY_PATH.get(url.pathname);
    if (!mount) {
      return json(
        { error: 'not_found', message: `No MCP mount at ${url.pathname}`, mounts: [...MOUNT_BY_PATH.keys()] },
        404,
      );
    }

    if (request.method !== 'POST') {
      // Stateless streamable HTTP: no server→client SSE channel, so a client's
      // GET probe for one correctly gets 405 (spec-allowed). Advertise POST per
      // RFC 9110 §15.5.6 (405 SHOULD carry Allow).
      return json(
        { error: 'method_not_allowed', message: 'MCP requests are POST (stateless streamable HTTP).' },
        405,
        { Allow: 'POST, OPTIONS' },
      );
    }

    const verify = makeVerifier(env);
    const auth = verify(request);
    if (auth.kind === 'fail') {
      return json({ error: auth.error }, auth.status, { 'WWW-Authenticate': auth.wwwAuthenticate });
    }

    let message: unknown;
    try {
      message = await request.json();
    } catch {
      return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
    }

    const deps = {
      config: buildRuntimeConfig(env),
      logger,
      commitTokens: env.COMMIT_TOKENS ? kvCommitTokenStore(env.COMMIT_TOKENS) : undefined,
      // Support-KB vector search: present only where the env binds AI+Vectorize
      // (production). Absent → the KB tools fall back to the bundled BM25 index.
      extensions:
        env.AI && env.VECTORIZE_KB
          ? { supportKb: { ai: env.AI, vectorize: env.VECTORIZE_KB } }
          : undefined,
    };
    // stubGate FIRST: a stub_501 tool is answered in-worker, so a dangerous stub
    // never mints a commit token, never writes KV and never hits the backend.
    const factory = createServerFactory(REGISTRY, deps, [stubGate, makePreviewGate(deps)]);
    const scope: AuthScope = { ...auth.scope, mountPath: mount.config.path };

    const batch = Array.isArray(message) ? message : [message];
    const responses = await runWithAuthScope(scope, async () => {
      const out: unknown[] = [];
      for (const msg of batch) {
        const server = factory(mount, DOMAIN_MOUNTS);
        const t0 = Date.now();
        const resp = await handleMcpMessage(server, msg as never);
        const { method, tool, ok } = summarizeCall(msg, resp);
        // One wide-event line per JSON-RPC message - the always-on "what did the
        // MCP receive" record (tool resolved through the facade's call_tool).
        logger.info({
          trace_id: scope.traceId,
          mount: mount.config.path,
          method,
          ...(tool ? { tool } : {}),
          ok,
          dur_ms: Date.now() - t0,
          team: scope.teamSid ? 'set' : 'token',
          actor: scope.actor.type,
        });
        if (resp != null) out.push(resp);
      }
      return out;
    });

    if (responses.length === 0) {
      return new Response(null, { status: 202, headers: CORS });
    }
    return json(Array.isArray(message) ? responses : responses[0]);
  },
};
