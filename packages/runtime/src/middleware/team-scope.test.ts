import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { clearSiblingTokenCache, makeTeamScope } from './team-scope';
import type { AuthScope, DispatchContext, RuntimeDeps, ToolDefinition, ToolResult } from '../types';

// The team-scope middleware is what turns a multi-team OAuth grant into a
// usable capability: ctx.teamSidOverride (set by the facade's call_tool) or a
// divergent Team-SID header becomes an RFC 8693 access-subject exchange
// against id and a swapped scope. Tool args are never touched - the override
// travels OUTSIDE the tool contract.

const TEAM_A = 'ts_tm_aaaaaaaaaaaa';
const TEAM_B = 'ts_tm_bbbbbbbbbbbb';

function mkTool(over: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'search_things',
    description: 'Search things.',
    service: 'linkedin',
    entity: 'things',
    mount: 'linkedin.things',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/things/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    inputSchema: z.object({ page_size: z.number().optional() }),
    outputSchema: z.any(),
    annotations: { title: 'Search things', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    ...over,
  } as ToolDefinition;
}

const deps = {
  config: { baseUrls: { id: 'http://id.test' }, backendTimeoutMs: 1000 },
} as unknown as RuntimeDeps;

function mkScope(over: Partial<AuthScope> = {}): AuthScope {
  return {
    token: 'jwt-original',
    teamSid: null,
    tokenTeamSid: TEAM_A,
    actor: { type: 'user', sid: 'us_mb_aaaaaaaaaaaa' },
    permissions: [],
    traceId: 'trace-1',
    mountPath: '/mcp',
    ...over,
  } as AuthScope;
}

function mkCtx(
  args: Record<string, unknown>,
  over: { scope?: Partial<AuthScope>; tool?: Partial<ToolDefinition>; override?: string } = {},
): DispatchContext {
  return {
    tool: mkTool(over.tool),
    args,
    scope: mkScope(over.scope),
    deps,
    ...(over.override !== undefined ? { teamSidOverride: over.override } : {}),
  };
}

function nextRecorder(): { next: (ctx: DispatchContext) => Promise<ToolResult>; seen: DispatchContext[] } {
  const seen: DispatchContext[] = [];
  return {
    seen,
    next: async (ctx) => {
      seen.push(ctx);
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  };
}

function exchangeOk(token = 'jwt-sibling', expiresIn = 3600) {
  return vi.fn(async () => new Response(JSON.stringify({ access_token: token, expires_in: expiresIn, team_sid: TEAM_B }), { status: 200 }));
}

beforeEach(() => clearSiblingTokenCache());
afterEach(() => vi.unstubAllGlobals());

describe('makeTeamScope', () => {
  it('passes through untouched when no override or header is present', async () => {
    const fetchSpy = exchangeOk();
    vi.stubGlobal('fetch', fetchSpy);
    const { next, seen } = nextRecorder();

    await makeTeamScope(deps)(mkCtx({ page_size: 5 }), next);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(seen[0].args).toEqual({ page_size: 5 });
    expect(seen[0].scope.token).toBe('jwt-original');
  });

  it('treats an override equal to the token team as a no-op', async () => {
    const fetchSpy = exchangeOk();
    vi.stubGlobal('fetch', fetchSpy);
    const { next, seen } = nextRecorder();

    await makeTeamScope(deps)(mkCtx({ page_size: 5 }, { override: TEAM_A }), next);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(seen[0].scope.teamSid).toBe(TEAM_A);
    expect(seen[0].scope.token).toBe('jwt-original');
  });

  it('exchanges the bearer and dispatches with the sibling scope, args untouched', async () => {
    const fetchSpy = exchangeOk();
    vi.stubGlobal('fetch', fetchSpy);
    const { next, seen } = nextRecorder();

    const result = await makeTeamScope(deps)(mkCtx({ page_size: 5 }, { override: TEAM_B }), next);

    expect(result.isError).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://id.test/oauth/token');
    const body = JSON.parse(String(init.body));
    expect(body.grant_type).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
    expect(body.subject_token).toBe('jwt-original');
    expect(body.subject_token_type).toBe('urn:ietf:params:oauth:token-type:access_token');
    expect(body.target_team_sid).toBe(TEAM_B);

    expect(seen[0].args).toEqual({ page_size: 5 });
    expect(seen[0].scope.token).toBe('jwt-sibling');
    expect(seen[0].scope.teamSid).toBe(TEAM_B);
    expect(seen[0].scope.tokenTeamSid).toBe(TEAM_B);
  });

  it('caches the sibling token per (bearer, team)', async () => {
    const fetchSpy = exchangeOk();
    vi.stubGlobal('fetch', fetchSpy);
    const mw = makeTeamScope(deps);

    await mw(mkCtx({}, { override: TEAM_B }), nextRecorder().next);
    await mw(mkCtx({}, { override: TEAM_B }), nextRecorder().next);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('honors a divergent Team-SID header as the target', async () => {
    const fetchSpy = exchangeOk();
    vi.stubGlobal('fetch', fetchSpy);
    const { next, seen } = nextRecorder();

    await makeTeamScope(deps)(mkCtx({}, { scope: { teamSid: TEAM_B } }), next);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(seen[0].scope.token).toBe('jwt-sibling');
    expect(seen[0].scope.teamSid).toBe(TEAM_B);
  });

  it('skips the exchange for local tools', async () => {
    const fetchSpy = exchangeOk();
    vi.stubGlobal('fetch', fetchSpy);
    const { next, seen } = nextRecorder();

    await makeTeamScope(deps)(
      mkCtx({}, { override: TEAM_B, tool: { localHandler: async () => ({}) } as Partial<ToolDefinition> }),
      next,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(seen[0].scope.token).toBe('jwt-original');
  });

  it('maps an exchange denial to a forbidden envelope and never dispatches', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_target', error_description: 'not in scope' }), { status: 400 })),
    );
    const { next, seen } = nextRecorder();

    const result = await makeTeamScope(deps)(mkCtx({}, { override: TEAM_B }), next);

    expect(seen).toHaveLength(0);
    expect(result.isError).toBe(true);
    const err = (result.structuredContent as { error: { code: string; message: string } }).error;
    expect(err.code).toBe('forbidden');
    expect(err.message).toContain('not in scope');
  });

  it('refuses a team override on an api-key scope without dialing', async () => {
    const fetchSpy = exchangeOk();
    vi.stubGlobal('fetch', fetchSpy);
    const { next, seen } = nextRecorder();

    const result = await makeTeamScope(deps)(
      mkCtx({}, { override: TEAM_B, scope: { actor: { type: 'api_key', sid: null }, tokenTeamSid: null } }),
      next,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0);
    expect(result.isError).toBe(true);
    expect((result.structuredContent as { error: { code: string } }).error.code).toBe('forbidden');
  });
});
