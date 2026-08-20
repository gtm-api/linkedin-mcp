import type { ToolMiddleware } from '../chain';
import type { DispatchContext, RuntimeDeps, ToolResult } from '../types';

// Team-scope middleware: makes the multi-team OAuth grant actually usable.
//
// An installation token is single-team by design (cluster affinity + the
// member's frozen permission slice), and the re-mint verb - RFC 8693
// token-exchange - needs the grant credential, which a remote client
// (claude.ai) never exposes to tool calls. So the edge does the exchange with
// the request's OWN bearer as the subject (`subject_token_type=…:access_token`,
// id-side support 2026-08-20).
//
// The target team arrives OUTSIDE the tool args - per-tool contracts never
// carry a team (platform doctrine): the facade's `call_tool` takes a top-level
// `team_sid` (and lifts the natural `arguments.team_sid` gesture on tools that
// do not own the field) into `ctx.teamSidOverride`; domain mounts use the
// `Team-SID` header. This middleware resolves that into a sibling installation
// token and swaps the scope before dispatch.
//
// Position: BEFORE the preview gate, so the gate sees the RESOLVED scope and
// binds the team into the commit token - a preview confirmed for team A can
// never be committed into team B, whichever channel carried the override.

const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
const SUBJECT_TYPE_ACCESS_TOKEN = 'urn:ietf:params:oauth:token-type:access_token';

interface CachedSibling {
  token: string;
  expiresAtMs: number;
}

// Per-isolate sibling-token cache: one exchange per (bearer, team) per token
// lifetime instead of one per call. Keyed by the raw bearer so a rotated token
// naturally misses. Correctness never depends on a hit - this only saves the
// id round-trip.
const siblingCache = new Map<string, CachedSibling>();
const CACHE_MAX_ENTRIES = 500;
const CACHE_SAFETY_MS = 120_000;

/** Test seam: drop all cached sibling tokens. */
export function clearSiblingTokenCache(): void {
  siblingCache.clear();
}

function errorResult(
  code: 'forbidden' | 'internal_error',
  message: string,
  suggestion: string,
  ctx: DispatchContext,
  teamSid: string,
): ToolResult {
  return {
    content: [{ type: 'text', text: `${message}\n${suggestion}` }],
    isError: true,
    structuredContent: {
      success: false,
      error: {
        code,
        message,
        recoverable: true,
        suggestion,
        context: { source: 'mcp_runtime', tool: ctx.tool.name, team_sid: teamSid },
      },
    },
  };
}

async function exchangeForTeam(
  deps: RuntimeDeps,
  bearer: string,
  targetTeamSid: string,
): Promise<{ kind: 'ok'; token: string } | { kind: 'denied'; description: string } | { kind: 'transport'; detail: string }> {
  const cacheKey = `${bearer}|${targetTeamSid}`;
  const cached = siblingCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAtMs > now) return { kind: 'ok', token: cached.token };
  if (cached) siblingCache.delete(cacheKey);

  const base = deps.config.baseUrls.id;
  if (!base) return { kind: 'transport', detail: "no base URL configured for service 'id'" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.config.backendTimeoutMs);
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        grant_type: TOKEN_EXCHANGE_GRANT,
        subject_token: bearer,
        subject_token_type: SUBJECT_TYPE_ACCESS_TOKEN,
        target_team_sid: targetTeamSid,
      }),
      signal: controller.signal,
    });
    const json = (await res.json().catch(() => null)) as
      | { access_token?: string; expires_in?: number; error?: string; error_description?: string }
      | null;

    if (res.ok && json && typeof json.access_token === 'string') {
      const ttlMs = Math.max(0, (json.expires_in ?? 0) * 1000 - CACHE_SAFETY_MS);
      if (ttlMs > 0) {
        if (siblingCache.size >= CACHE_MAX_ENTRIES) siblingCache.clear();
        siblingCache.set(cacheKey, { token: json.access_token, expiresAtMs: now + ttlMs });
      }
      return { kind: 'ok', token: json.access_token };
    }

    return {
      kind: 'denied',
      description: json?.error_description ?? json?.error ?? `token endpoint answered ${res.status}`,
    };
  } catch (err) {
    return { kind: 'transport', detail: String((err as { message?: string })?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

export function makeTeamScope(deps: RuntimeDeps): ToolMiddleware {
  return async (ctx, next) => {
    // Target team: the explicit override first (facade call_tool), else a
    // Team-SID header that disagrees with the token claim (the domain-mount
    // channel, per connection).
    const override = typeof ctx.teamSidOverride === 'string' && ctx.teamSidOverride !== '' ? ctx.teamSidOverride : null;
    const headerTeam =
      ctx.scope.teamSid && ctx.scope.teamSid !== (ctx.scope.tokenTeamSid ?? ctx.scope.teamSid) ? ctx.scope.teamSid : null;
    const target = override ?? headerTeam;

    if (!target) return next(ctx);
    // Local tools never hit a backend - the team axis means nothing to them.
    if (ctx.tool.localHandler) return next(ctx);
    // Same team as the token: nothing to exchange.
    if (target === ctx.scope.tokenTeamSid) {
      return next({ ...ctx, scope: { ...ctx.scope, teamSid: target } });
    }

    if (ctx.scope.actor.type === 'api_key') {
      return errorResult(
        'forbidden',
        `team_sid ${target} cannot be honored: API keys are pinned to their own team.`,
        'Create an API key in the target workspace, or connect via OAuth (whose grant can cover several teams).',
        ctx,
        target,
      );
    }

    const exchanged = await exchangeForTeam(deps, ctx.scope.token, target);
    if (exchanged.kind === 'transport') {
      return errorResult(
        'internal_error',
        `Could not reach the token exchange for team ${target}: ${exchanged.detail}.`,
        'Retry the call; if it persists, drop team_sid to act in the token team.',
        ctx,
        target,
      );
    }
    if (exchanged.kind === 'denied') {
      return errorResult(
        'forbidden',
        `The platform refused to act in team ${target}: ${exchanged.description}.`,
        'The OAuth grant may not cover that team, or your membership lapsed. Reconnect the connector and pick the workspace on the consent screen, or call get_current_user with include:["accessible_teams"] to see your teams.',
        ctx,
        target,
      );
    }

    return next({
      ...ctx,
      scope: { ...ctx.scope, token: exchanged.token, teamSid: target, tokenTeamSid: target },
    });
  };
}
