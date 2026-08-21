import {
  buildRegistry,
  checkBatchSize,
  createServerFactory,
  makePreviewGate,
  makeRateLimitGate,
  makeSizeBudget,
  makeTeamScope,
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
import { fatalProblems, inspectConfig, requiredBaseUrlServices } from './config';
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
// Which services this build actually dispatches to, so the config check demands
// a base URL for exactly those. Env-independent, hence module scope.
const REQUIRED_SERVICES = requiredBaseUrlServices(RESOLVED);

// The wildcard origin stays, and the reasoning is recorded here so the next
// reader does not have to re-derive it.
//
// `*` is safe HERE because this server has no ambient authority to steal. Every
// request is authorized by a Bearer header and nothing else: no cookies, no
// session, no client certificate. A browser will not attach an Authorization
// header cross-origin on its own, and the CORS spec forbids pairing `*` with
// credentialed requests at all, so a hostile page cannot make an authenticated
// call in a visitor's name. It can only replay a token it was already given,
// and a page holding our bearer can call the API directly from a server with no
// browser and no CORS involved. Tightening the origin would therefore cost the
// browser-hosted MCP clients (which is how a connector is mounted) and buy
// nothing.
//
// The invariant that MUST hold for that argument: never add
// `Access-Control-Allow-Credentials: true`, and never move authentication into
// a cookie. Either change turns this wildcard into a cross-site request forgery
// hole against every tool on the server.
//
// Max-Age is the one thing that was missing: without it a browser client
// preflights every single POST, doubling the request count on a public edge.
const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Accept, Authorization, Team-SID, X-Trace-Id, Mcp-Protocol-Version, Mcp-Session-Id',
  'Access-Control-Max-Age': '86400',
};

// Health, discovery and the config refusal must never be read from a cache:
// a stale 200 is exactly the "looks fine, serves nothing" state this closes.
const NO_STORE: Record<string, string> = { 'Cache-Control': 'no-store' };

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
//
// `ok` is the CALLER's outcome, not the transport's: false when the JSON-RPC
// envelope errored OR the tool result carries isError:true. For that to mean
// anything, the dispatcher guarantees every backend HTTP >= 400 becomes an
// isError result even when the body is not the platform error envelope; the
// 2026-08-21 trace-id 422 logged ok:true precisely because that guarantee was
// missing. An alert on ok=false therefore sees business failures, not just
// envelope failures.
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

    // One config verdict per request, shared by /health, discovery and the
    // refusal below, so the three can never disagree about whether this worker
    // is operational. It is a handful of string checks over env vars.
    const config = inspectConfig(env, REQUIRED_SERVICES);

    if (url.pathname === '/health') {
      // 503 when the worker is not operational, 200 with status 'degraded' when
      // it serves with a fail-closed piece missing. Rationale in config.ts.
      return json(
        {
          status: config.status,
          env: env.ENV_NAME ?? 'local',
          version: '0.0.0',
          auth_mode: env.AUTH_MODE ?? null,
          gate: config.previewGate,
          commit_tokens: config.commitTokens,
          // Which enforcer is counting, not just whether the feature is on:
          // 'edge' and 'isolate_local' are different guarantees, and only
          // /health can tell an operator which one a deploy actually got.
          rate_limit: config.rateLimit,
          max_batch_size: config.maxBatchSize,
          discovery: config.discovery.status,
          problems: config.problems,
          mounts: RESOLVED.map((m) => ({ path: m.config.path, tools: m.tools.length })),
          tools: REGISTRY.byName.size,
        },
        config.status === 'fail' ? 503 : 200,
        NO_STORE,
      );
    }

    if (url.pathname === '/.well-known/oauth-protected-resource') {
      if (config.discovery.status === 'unconfigured') {
        return json(
          {
            status: 'fail',
            error: 'configuration_error',
            message:
              `This worker cannot produce an OAuth protected-resource document: ${config.discovery.missing.join(', ')} ` +
              'unset or unusable. See /health.',
            missing: config.discovery.missing,
          },
          503,
          NO_STORE,
        );
      }
      return json(
        {
          resource: config.discovery.resource,
          authorization_servers: config.discovery.authorizationServers,
          bearer_methods_supported: ['header'],
        },
        200,
        NO_STORE,
      );
    }

    // A misconfigured worker refuses every MCP request instead of serving a
    // 250-tool catalog whose every call fails (or, worse, serving with the
    // token checks silently disabled). `config.auth === null` is implied by
    // status 'fail'; it is spelled out because it is what narrows AuthConfig
    // for makeVerifier below.
    if (config.status === 'fail' || config.auth === null) {
      return json(
        {
          status: 'fail',
          error: 'configuration_error',
          message: 'This MCP worker is misconfigured and is refusing to serve. See /health.',
          problems: fatalProblems(config),
        },
        503,
        NO_STORE,
      );
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

    const verify = makeVerifier(config.auth);
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

    const runtime = buildRuntimeConfig(env);

    // Batch cap, before anything is built. The loop below gives every element
    // its own backend call with its own 25s timeout, so the length of this
    // array is a fan-out multiplier on a public URL. Rejected whole: a partial
    // batch would leave the caller guessing which half ran. Rationale for the
    // number in packages/runtime/src/middleware/batch-cap.ts.
    const batch = Array.isArray(message) ? message : [message];
    const rejected = checkBatchSize(batch.length, runtime.maxBatchSize);
    if (rejected) return json(rejected.body, rejected.status);

    const deps = {
      config: runtime,
      logger,
      commitTokens: env.COMMIT_TOKENS ? kvCommitTokenStore(env.COMMIT_TOKENS) : undefined,
      rateLimiters: { calls: env.RATE_LIMIT_CALLS, writes: env.RATE_LIMIT_WRITES },
      // The knowledge tools have exactly one retrieval backend: the Mintlify
      // discovery index over the published docs site. No fallback by decision
      // (2026-08-14): a stale local index answering silently is invisible
      // quality damage, so an unconfigured or unreachable backend surfaces as
      // an error instead. The worker boots fine without the secret; the two
      // KB tools then error clearly and everything else is unaffected.
      extensions: env.MINTLIFY_ASSISTANT_KEY
        ? {
            mintlifySearch: {
              key: env.MINTLIFY_ASSISTANT_KEY,
              domain: env.MINTLIFY_DOCS_DOMAIN ?? 'docs.gtm-api.com',
            },
          }
        : undefined,
    };
    // Chain order, outermost first, and every position is load-bearing:
    //
    //   makeSizeBudget    outermost, because it is the only result TRANSFORM
    //                     here. Everything below it can short-circuit, and a
    //                     short-circuit result (a preview echoing its args, an
    //                     error envelope with a long field_errors map) has to
    //                     be measured too. Outermost is the only position that
    //                     sees every result that leaves the server.
    //   makeRateLimitGate first of the gates, ahead of the free ones. A limiter
    //                     a caller can dodge by picking a tool name is not a
    //                     limiter, and worker CPU is billed whether or not the
    //                     targeted tool would have reached a backend.
    //   stubGate          a stub_501 tool is answered in-worker, so a dangerous
    //                     stub never mints a commit token, never writes KV and
    //                     never hits the backend.
    //   makeTeamScope     resolves the team override (facade `team_sid` param /
    //                     Team-SID header) into a sibling-team installation
    //                     token (RFC 8693) and swaps the scope, BEFORE the
    //                     preview gate so the gate binds the RESOLVED team
    //                     into the commit token.
    //   makePreviewGate   last gate before dispatch: by here the call is within
    //                     its budget, scoped to its final team, and is going to
    //                     really run. The commit token binds (tool, args, team),
    //                     so a preview for team A can never commit into team B.
    const factory = createServerFactory(REGISTRY, deps, [
      makeSizeBudget(deps),
      makeRateLimitGate(deps),
      stubGate,
      makeTeamScope(deps),
      makePreviewGate(deps),
    ]);
    const scope: AuthScope = { ...auth.scope, mountPath: mount.config.path };

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
