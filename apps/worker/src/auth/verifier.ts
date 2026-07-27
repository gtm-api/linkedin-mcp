import type { AuthScope } from '@gtm/mcp-runtime';
import type { Env } from '../env';

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
// active in deployed environments.
export function makeVerifier(env: Env) {
  const origin = (env.MCP_RESOURCE_URL ?? '').replace(/\/mcp.*$/, '');
  const prmUrl = `${origin}/.well-known/oauth-protected-resource`;
  const devMode = env.AUTH_MODE === 'dev';
  const issuer = env.AUTH_ISSUER;
  const resource = env.MCP_RESOURCE_URL;

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
    else if (devMode && env.DEV_BEARER) token = env.DEV_BEARER;
    if (!token) return fail('invalid_request', 'missing bearer token');

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
    if (!devMode && issuer && payload.iss !== issuer) {
      return fail('invalid_token', 'issuer mismatch');
    }
    // aud, when present, must target this MCP resource.
    if (resource && payload.aud !== undefined) {
      const aud = payload.aud;
      const ok = Array.isArray(aud) ? aud.includes(resource) : aud === resource;
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
        actor: { type: actorType, sid: actorSid },
        permissions: permTokens,
        traceId: request.headers.get('X-Trace-Id') ?? crypto.randomUUID(),
      },
    };
  };
}
