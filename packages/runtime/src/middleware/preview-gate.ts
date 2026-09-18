import type { DispatchContext, RuntimeDeps, ToolResult } from '../types';
import type { ToolMiddleware } from '../chain';
import { backendFetch } from '../backend-client';
import { mapErrorEnvelope } from '../error-map';

// Human-in-the-loop consent gate for tools flagged `dangerous: true`
// (destructive / paid). Stateless, HMAC commit-token design (ported from the
// legacy gs.mcp preview-gate, but armed by default):
//   - Call 1 (no commit_token): nothing executes. The arguments are checked
//     against the backend's validate twin first (see validateOnBackend), then a
//     preview is returned with a short-lived HMAC commit_token bound to the tool
//     name and a hash of the args.
//   - Call 2 (commit_token present): verify signature + expiry + tool + args
//     hash, mark the token's jti single-use in KV, then execute.
// Fail-closed: no secret / no store / KV error → refuse to execute.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function b64urlFromBytes(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlFromString(str: string): string {
  return b64urlFromBytes(encoder.encode(str));
}
function stringFromB64url(s: string): string {
  let b = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b.length % 4;
  if (pad) b += '='.repeat(4 - pad);
  return decoder.decode(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)));
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return b64urlFromBytes(new Uint8Array(sig));
}

async function sha256hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Stable JSON stringify (sorted keys) so the args hash is order-independent.
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

// Hash of the call args, excluding the gate/telemetry fields that differ
// between the preview call and the commit call.
export async function canonicalArgsHash(args: Record<string, unknown>): Promise<string> {
  const { commit_token: _c, _meta: _m, ...rest } = args;
  return sha256hex(canonical(rest));
}

interface TokenPayload {
  v: 1;
  tool: string;
  args_hash: string;
  /* Team the preview was issued under (resolved scope, team-scope middleware
     runs first). Empty string when the scope carries no team (api-key edge
     case). Binds confirm-to-preview across tenants: a preview for team A can
     never be committed into team B. */
  team: string;
  iat: number;
  exp: number;
  jti: string;
}

export async function mintCommitToken(
  tool: string,
  argsHash: string,
  secret: string,
  ttlSeconds: number,
  nowMs: number,
  jti: string,
  team = '',
): Promise<{ token: string; expiresIn: number }> {
  const iat = Math.floor(nowMs / 1000);
  const payload: TokenPayload = { v: 1, tool, args_hash: argsHash, team, iat, exp: iat + ttlSeconds, jti };
  const body = b64urlFromString(JSON.stringify(payload));
  const sig = await hmac(secret, body);
  return { token: `${body}.${sig}`, expiresIn: ttlSeconds };
}

export type VerifyVerdict =
  | { ok: true; jti: string }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'wrong_tool' | 'args_mismatch' | 'team_mismatch' };

export async function verifyCommitToken(
  token: string,
  tool: string,
  argsHash: string,
  secret: string,
  nowMs: number,
  team = '',
): Promise<VerifyVerdict> {
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [body, sig] = parts;
  const expected = await hmac(secret, body);
  if (!timingSafeEqual(sig, expected)) return { ok: false, reason: 'bad_signature' };
  let payload: TokenPayload;
  try {
    payload = JSON.parse(stringFromB64url(body)) as TokenPayload;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (payload.tool !== tool) return { ok: false, reason: 'wrong_tool' };
  if (payload.args_hash !== argsHash) return { ok: false, reason: 'args_mismatch' };
  // Pre-team tokens (payload.team undefined) fail closed as a mismatch too:
  // they cannot prove which tenant their preview showed.
  if ((payload.team ?? '') !== team) return { ok: false, reason: 'team_mismatch' };
  if (payload.exp * 1000 <= nowMs) return { ok: false, reason: 'expired' };
  return { ok: true, jti: payload.jti };
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

// One line saying what the confirmed call will do, built from the arguments
// alone: the preview makes no backend call, so ids stay ids (no names resolved).
// Long values are cut so a message body does not swallow the line.
function effectSummary(tool: string, action: string, args: Record<string, unknown>): string {
  const brief = (value: unknown): string => {
    if (value === null || value === undefined) return 'null';
    if (typeof value === 'string') return value.length > 60 ? JSON.stringify(value.slice(0, 57) + '...') : JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.length} item${value.length === 1 ? '' : 's'}]`;
    if (typeof value === 'object') return `{${Object.keys(value as object).length} keys}`;
    return String(value);
  };
  const parts = Object.entries(args).map(([key, value]) => `${key}=${brief(value)}`);
  return `${tool} will run ${action}${parts.length ? ` with ${parts.join(', ')}` : ' with no arguments'}.`;
}

/**
 * Ask the backend's validate twin whether the real route would refuse these
 * arguments before its action even starts (auth, permissions, the FormRequest).
 *
 * Until 2026-09-18 a preview made no backend call at all, so a payload the commit
 * would answer 422 to sailed through: the human confirmed it, and only the
 * confirmed call found out. Now the refusal arrives AT the preview, rendered
 * exactly as the real call would render it, and no token is minted for it.
 *
 * Returns the refusal, `'passed'`, or `'unavailable'`. Unavailable is every answer
 * that is not a verdict on the arguments: no twin on that backend (404, which an
 * unaware backend gives and an aware one gives for a sid it cannot bind, the same
 * way the commit would), a transport failure, a 5xx, a body that is not the
 * platform envelope. The gate then previews as it always did: the twin makes a
 * preview stronger where it exists and never makes it unavailable.
 */
async function validateOnBackend(ctx: DispatchContext): Promise<ToolResult | 'passed' | 'unavailable'> {
  if (ctx.tool.localHandler || !ctx.tool.route.pathTemplate.startsWith('/api/')) return 'unavailable';

  const { commit_token: _drop, ...args } = ctx.args;
  let res;
  try {
    res = await backendFetch({ ...ctx, args }, { validateOnly: true });
  } catch {
    return 'unavailable';
  }
  if (res.kind === 'transport_error' || res.status === 404 || res.status >= 500) return 'unavailable';

  const env = res.envelope as { success?: boolean; operation?: string } | null;
  if (env?.success === true && env.operation === 'validate') return 'passed';
  if (env?.success === false && res.status >= 400) return mapErrorEnvelope(res.status, env as never, ctx);
  return 'unavailable';
}

function previewResult(ctx: DispatchContext, token: string, expiresIn: number, team: string, validated: boolean): ToolResult {
  const action = ctx.tool.route.pathTemplate.split('/').pop() ?? ctx.tool.name;
  const { commit_token: _committed, ...args } = ctx.args;
  const summary = effectSummary(ctx.tool.name, action, args);
  const text = [
    `⚠️ ${ctx.tool.name} is a protected action and needs confirmation before it runs.`,
    `Nothing has changed yet. Review the arguments below, then call ${ctx.tool.name} AGAIN with the exact same arguments plus "commit_token": "${token}" to execute.`,
    `The token is single-use and expires in ${expiresIn}s.`,
    ...(team !== '' ? [`It will execute in team ${team}.`] : []),
    ...(validated ? ['The arguments passed the backend\'s own validation; what the action finds when it runs (limits, seats, the target\'s state) is only known at commit.'] : []),
    '',
    summary,
    `arguments: ${JSON.stringify(args)}`,
  ].join('\n');
  // The arguments and the summary ride in structuredContent too: a client that
  // reads only the structured block (the audit report of 2026-09-16, T2) used to
  // see a token and nothing about what it was confirming.
  return {
    content: [{ type: 'text', text }],
    structuredContent: {
      preview: true,
      tool: ctx.tool.name,
      action,
      dangerous: true,
      summary,
      arguments: args,
      // true = the backend's validate twin accepted these arguments; false = the
      // backend has no twin (or did not answer), so only the MCP schema checked them.
      validated,
      commit_token: token,
      expires_in_seconds: expiresIn,
      team_sid: team !== '' ? team : null,
      instruction: `Re-call ${ctx.tool.name} with the same args + commit_token to execute.`,
    },
  };
}

const FAIL_MESSAGES: Record<string, string> = {
  malformed: 'The commit_token is malformed. Request a fresh preview (call again without commit_token).',
  bad_signature: 'The commit_token signature is invalid. Request a fresh preview.',
  expired: 'The commit_token has expired. Request a fresh preview and confirm promptly.',
  wrong_tool: 'The commit_token was issued for a different tool. Request a fresh preview.',
  args_mismatch: 'The arguments changed since the preview. Request a fresh preview for the new arguments.',
  team_mismatch: 'The team changed since the preview. Request a fresh preview in the team you are committing to.',
};

export function makePreviewGate(deps: RuntimeDeps): ToolMiddleware {
  return async (ctx, next) => {
    if (!ctx.tool.dangerous) return next(ctx);

    const gate = deps.config.previewGate;
    if (!gate.enabled || !gate.secret) {
      return errorResult(
        `${ctx.tool.name} is a protected action but the preview gate is not configured on this server; refusing to execute (fail-closed).`,
      );
    }

    const nowMs = deps.now?.() ?? Date.now();
    const argsHash = await canonicalArgsHash(ctx.args);
    // The RESOLVED team: the team-scope middleware runs before this gate, so
    // tokenTeamSid already reflects any team_sid override / Team-SID header.
    const team = ctx.scope.tokenTeamSid ?? ctx.scope.teamSid ?? '';
    const provided = typeof ctx.args.commit_token === 'string' ? (ctx.args.commit_token as string) : undefined;

    if (!provided) {
      const validation = await validateOnBackend(ctx);
      if (typeof validation !== 'string') return validation;

      const jti = crypto.randomUUID();
      const { token, expiresIn } = await mintCommitToken(ctx.tool.name, argsHash, gate.secret, gate.ttlSeconds, nowMs, jti, team);
      return previewResult(ctx, token, expiresIn, team, validation === 'passed');
    }

    const verdict = await verifyCommitToken(provided, ctx.tool.name, argsHash, gate.secret, nowMs, team);
    if (!verdict.ok) return errorResult(FAIL_MESSAGES[verdict.reason]);

    const store = deps.commitTokens;
    if (!store) return errorResult('The preview-gate store is unavailable; refusing to execute (fail-closed).');
    try {
      if (await store.get(verdict.jti)) {
        return errorResult('This confirmation token was already used. Request a fresh preview.');
      }
      await store.put(verdict.jti, '1', Math.max(60, gate.ttlSeconds + 30));
    } catch {
      return errorResult('Could not record the confirmation token (fail-closed); not executing.');
    }

    const { commit_token: _drop, ...rest } = ctx.args;
    return next({ ...ctx, args: rest });
  };
}
