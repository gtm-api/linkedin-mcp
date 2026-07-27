import type { DispatchContext, RuntimeDeps, ToolResult } from '../types';
import type { ToolMiddleware } from '../chain';

// Human-in-the-loop consent gate for tools flagged `dangerous: true`
// (destructive / paid). Stateless, HMAC commit-token design (ported from the
// legacy gs.mcp preview-gate, but armed by default):
//   - Call 1 (no commit_token): NO backend call. Returns a preview + a short-
//     lived HMAC commit_token bound to the tool name and a hash of the args.
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
): Promise<{ token: string; expiresIn: number }> {
  const iat = Math.floor(nowMs / 1000);
  const payload: TokenPayload = { v: 1, tool, args_hash: argsHash, iat, exp: iat + ttlSeconds, jti };
  const body = b64urlFromString(JSON.stringify(payload));
  const sig = await hmac(secret, body);
  return { token: `${body}.${sig}`, expiresIn: ttlSeconds };
}

export type VerifyVerdict =
  | { ok: true; jti: string }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'wrong_tool' | 'args_mismatch' };

export async function verifyCommitToken(
  token: string,
  tool: string,
  argsHash: string,
  secret: string,
  nowMs: number,
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
  if (payload.exp * 1000 <= nowMs) return { ok: false, reason: 'expired' };
  return { ok: true, jti: payload.jti };
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function previewResult(ctx: DispatchContext, token: string, expiresIn: number): ToolResult {
  const action = ctx.tool.route.pathTemplate.split('/').pop() ?? ctx.tool.name;
  const text = [
    `⚠️ ${ctx.tool.name} is a protected action and needs confirmation before it runs.`,
    `Nothing has changed yet. Review the arguments below, then call ${ctx.tool.name} AGAIN with the exact same arguments plus "commit_token": "${token}" to execute.`,
    `The token is single-use and expires in ${expiresIn}s.`,
    '',
    `arguments: ${JSON.stringify((() => { const { commit_token: _c, ...r } = ctx.args; return r; })())}`,
  ].join('\n');
  return {
    content: [{ type: 'text', text }],
    structuredContent: {
      preview: true,
      tool: ctx.tool.name,
      action,
      dangerous: true,
      creditable: ctx.tool.creditable,
      commit_token: token,
      expires_in_seconds: expiresIn,
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
    const provided = typeof ctx.args.commit_token === 'string' ? (ctx.args.commit_token as string) : undefined;

    if (!provided) {
      const jti = crypto.randomUUID();
      const { token, expiresIn } = await mintCommitToken(ctx.tool.name, argsHash, gate.secret, gate.ttlSeconds, nowMs, jti);
      return previewResult(ctx, token, expiresIn);
    }

    const verdict = await verifyCommitToken(provided, ctx.tool.name, argsHash, gate.secret, nowMs);
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
