import type { AuthScope } from '@gtm/mcp-runtime';
import type { AuthConfig } from '../config';

export type VerifyResult =
  | { kind: 'ok'; scope: Omit<AuthScope, 'mountPath'> }
  | { kind: 'fail'; status: 401 | 403; wwwAuthenticate: string; error: string };

const LEEWAY_S = 60;

function b64urlToString(seg: string): string {
  let b = seg.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b.length % 4;
  if (pad) b += '='.repeat(4 - pad);
  return new TextDecoder().decode(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)));
}

function decodeSegment(seg: string): Record<string, unknown> | null {
  try {
    return JSON.parse(b64urlToString(seg)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// The protected-resource metadata URL a 401 points the client at. It is
// origin-rooted (RFC 9728) and index.ts serves it at exactly that path, so
// derive it with the URL parser. It used to be `resource.replace(/\/mcp.*$/, '')`,
// which silently produced `https:/` for any resource whose HOST starts with
// `mcp.` (the intended production URL is https://mcp.gtm-api.com/mcp: the trim
// matched the host, not the path), and the client was then sent to a URL that
// does not exist. A resource that is absent or unparseable can only be answered
// with the relative path, which at least resolves against this same origin.
const PRM_PATH = '/.well-known/oauth-protected-resource';

function prmUrlFor(resource: string | null): string {
  if (!resource) return PRM_PATH;
  try {
    return `${new URL(resource).origin}${PRM_PATH}`;
  } catch {
    return PRM_PATH;
  }
}

// OAuth 2.1 resource-server token check.
//
// The platform signs JWTs with a shared HS256 secret; that secret must never
// live at the public edge, so the worker does NOT verify the signature - it
// does structural + claim checks (alg/exp/nbf/iss/aud) and forwards the Bearer
// to the first-party backends, whose auth:jwt guard is the authoritative
// signature + revocation + team + permission check. (Signature introspection
// against the id AS is the fast-follow; see MCP_SERVER_RUNTIME.md §5.)
//
// Dev bypass: AUTH_MODE=dev + DEV_BEARER lets the local connector be a bare URL
// and relaxes the issuer check (jwt:fake carries an artisan-context iss). Never
// active in deployed environments: config.ts refuses AUTH_MODE=dev outside a
// local ENV_NAME.
//
// The verifier takes the VERIFIED AuthConfig, never the raw Env. That is the
// fix for the hole the audit found: the iss and aud checks used to be guarded
// on `issuer &&` / `resource &&`, so an unset var silently turned each one into
// a no-op and any expired token from any issuer passed. In `jwt` mode those two
// fields are non-optional strings, so the check cannot disable itself; a config
// that lacks them never produces an AuthConfig at all and the worker refuses to
// serve (index.ts, 503).
export function makeVerifier(auth: AuthConfig) {
  const prmUrl = prmUrlFor(auth.resource);

  const fail = (error: string, desc: string): VerifyResult => ({
    kind: 'fail',
    status: 401,
    error,
    wwwAuthenticate: `Bearer resource_metadata="${prmUrl}", error="${error}", error_description="${desc}"`,
  });

  return function verify(request: Request): VerifyResult {
    const header = request.headers.get('Authorization');
    let token: string | null = null;
    if (header && header.startsWith('Bearer ')) token = header.slice(7).trim();
    else if (auth.mode === 'dev' && auth.devBearer) token = auth.devBearer;
    if (!token) return fail('invalid_request', 'missing bearer token');

    // Api-key bearer (`gtm_live_…`, authentication.mdx): an opaque platform
    // credential, not a JWT: none of the claim checks below apply. The
    // whitelist it verifies against lives in the id service, which this edge
    // must not hold, so the bearer is forwarded as-is and the backend guard's
    // api-key branch is the authoritative check. Same trust model as the JWT
    // signature: the edge screens shape, the backend decides. A garbage
    // `gtm_live_` string costs one backend 401, exactly like a garbage JWT
    // that passes structural checks.
    if (token.startsWith('gtm_live_')) {
      return {
        kind: 'ok',
        scope: {
          token,
          teamSid: request.headers.get('Team-SID'),
          // Unknown at the edge for opaque keys, the backend resolves the
          // key's own team and ignores foreign Team-SID claims anyway; the
          // rate-limit gate falls through to its per-token axis.
          tokenTeamSid: null,
          actor: { type: 'api_key', sid: null },
          permissions: [],
          traceId: request.headers.get('X-Trace-Id') ?? crypto.randomUUID(),
        },
      };
    }

    const parts = token.split('.');
    if (parts.length !== 3) return fail('invalid_token', 'malformed jwt');
    const jwtHeader = decodeSegment(parts[0]);
    const payload = decodeSegment(parts[1]);
    if (!jwtHeader || !payload) return fail('invalid_token', 'undecodable jwt');

    // Never accept unsigned or algorithm-confused tokens.
    if (jwtHeader.alg !== 'HS256') return fail('invalid_token', 'unsupported alg');

    const now = Math.floor(Date.now() / 1000);
    const exp = typeof payload.exp === 'number' ? payload.exp : undefined;
    const nbf = typeof payload.nbf === 'number' ? payload.nbf : undefined;
    if (exp !== undefined && now > exp + LEEWAY_S) return fail('invalid_token', 'token expired');
    if (nbf !== undefined && now < nbf - LEEWAY_S) return fail('invalid_token', 'token not yet valid');

    // iss enforced outside dev (jwt:fake tokens carry an artisan-context iss).
    // Unconditional in jwt mode: the issuer is part of the config or the worker
    // is not serving.
    if (auth.mode === 'jwt' && payload.iss !== auth.issuer) {
      return fail('invalid_token', 'issuer mismatch');
    }
    // aud, when present, must target this MCP resource. Optional in dev, where
    // the resource itself is optional; always applied in jwt mode.
    if (auth.resource && payload.aud !== undefined) {
      const aud = payload.aud;
      const ok = Array.isArray(aud) ? aud.includes(auth.resource) : aud === auth.resource;
      if (!ok) return fail('invalid_token', 'audience mismatch');
    }

    const ai = (payload.access_identity ?? {}) as Record<string, unknown>;
    const perms = ai.permissions as { tokens?: unknown } | unknown[] | undefined;
    const permTokens: string[] = Array.isArray(perms)
      ? (perms as string[])
      : Array.isArray((perms as { tokens?: unknown })?.tokens)
        ? (perms as { tokens: string[] }).tokens
        : [];
    const actorType = (ai.actor_type as AuthScope['actor']['type']) ?? 'user';
    const actorSid = (ai.actor_sid as string | undefined) ?? (payload.sub as string | undefined) ?? null;

    return {
      kind: 'ok',
      scope: {
        token,
        teamSid: request.headers.get('Team-SID'),
        // The team CLAIM, read but never forwarded (backend-client sends only
        // `teamSid`, the header). It exists so the rate-limit gate can key on
        // the paying tenant in the ordinary case, which is a client that sends
        // no Team-SID header and lets the backend read this same claim.
        tokenTeamSid: (ai.team_sid as string | undefined) ?? null,
        actor: { type: actorType, sid: actorSid },
        permissions: permTokens,
        traceId: request.headers.get('X-Trace-Id') ?? crypto.randomUUID(),
      },
    };
  };
}
