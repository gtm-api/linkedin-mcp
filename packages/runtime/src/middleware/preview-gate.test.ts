import { afterEach, describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import {
  canonicalArgsHash,
  mintCommitToken,
  verifyCommitToken,
  makePreviewGate,
  VALIDATE_TWIN_TIMEOUT_MS,
} from './preview-gate';
import type { CommitTokenStore, DispatchContext, RuntimeDeps, ToolDefinition, ToolResult } from '../types';

const SECRET = 'unit-secret';
const NOW = 1_700_000_000_000;

function mkTool(dangerous: boolean): ToolDefinition {
  return {
    name: 'reset_linkedin_account_sync',
    description: 'd',
    service: 'linkedin',
    entity: 'linkedin_accounts',
    mount: 'linkedin.accounts',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-accounts/{sid}/reset-sync' },
    operation: 'action',
    envelope: 'action_async',
    availability: 'ga',
    dangerous,
    inputSchema: z.object({ _meta: z.any().optional() }),
    outputSchema: z.any(),
    annotations: { title: 't', readOnlyHint: false, destructiveHint: dangerous, idempotentHint: false, openWorldHint: false },
  };
}

function memStore(): { store: CommitTokenStore; map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    store: {
      get: async (k) => map.get(k) ?? null,
      put: async (k, v) => { map.set(k, v); },
    },
  };
}

function mkDeps(store: CommitTokenStore | undefined, secret: string | null): RuntimeDeps {
  return {
    config: {
      envName: 'test', version: '0', baseUrls: { linkedin: '', id: '', orchestration: '', support: '' },
      backendTimeoutMs: 1000, responseCharBudget: 1000, maxBatchSize: 16, rateLimit: { enabled: false, windowSeconds: 60, callsPerWindow: 0, writesPerWindow: 0 },
      previewGate: { enabled: !!secret, secret, ttlSeconds: 300 },
    },
    logger: { info() {}, error() {} },
    commitTokens: store,
    now: () => NOW,
  };
}

function mkCtx(args: Record<string, unknown>, deps: RuntimeDeps, tool = mkTool(true)): DispatchContext {
  return {
    tool,
    args,
    scope: { token: '', teamSid: null, actor: { type: 'user', sid: null }, permissions: [], traceId: 't', mountPath: 'm' },
    deps,
  };
}

describe('commit token mint/verify', () => {
  it('round-trips', async () => {
    const hash = await canonicalArgsHash({ sid: 'ln_ac_1', types: ['a'] });
    const { token } = await mintCommitToken('reset_linkedin_account_sync', hash, SECRET, 300, NOW, 'jti-1');
    const v = await verifyCommitToken(token, 'reset_linkedin_account_sync', hash, SECRET, NOW);
    expect(v).toEqual({ ok: true, jti: 'jti-1' });
  });

  it('rejects expired', async () => {
    const hash = await canonicalArgsHash({ sid: 'ln_ac_1' });
    const { token } = await mintCommitToken('t', hash, SECRET, 300, NOW, 'j');
    const v = await verifyCommitToken(token, 't', hash, SECRET, NOW + 301_000);
    expect(v).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects wrong tool and arg mismatch', async () => {
    const hash = await canonicalArgsHash({ sid: 'ln_ac_1' });
    const { token } = await mintCommitToken('tool_a', hash, SECRET, 300, NOW, 'j');
    expect(await verifyCommitToken(token, 'tool_b', hash, SECRET, NOW)).toMatchObject({ ok: false, reason: 'wrong_tool' });
    const other = await canonicalArgsHash({ sid: 'ln_ac_2' });
    expect(await verifyCommitToken(token, 'tool_a', other, SECRET, NOW)).toMatchObject({ ok: false, reason: 'args_mismatch' });
  });

  it('binds the resolved team: a preview for one team never commits into another', async () => {
    const hash = await canonicalArgsHash({ sid: 'ln_ac_1' });
    const { token } = await mintCommitToken('t', hash, SECRET, 300, NOW, 'j', 'ts_tm_aaaaaaaaaaaa');
    expect(await verifyCommitToken(token, 't', hash, SECRET, NOW, 'ts_tm_bbbbbbbbbbbb')).toMatchObject({ ok: false, reason: 'team_mismatch' });
    expect(await verifyCommitToken(token, 't', hash, SECRET, NOW, 'ts_tm_aaaaaaaaaaaa')).toMatchObject({ ok: true, jti: 'j' });
  });

  it('rejects tampered signature', async () => {
    const hash = await canonicalArgsHash({ sid: 'ln_ac_1' });
    const { token } = await mintCommitToken('t', hash, SECRET, 300, NOW, 'j');
    const tampered = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
    expect(await verifyCommitToken(tampered, 't', hash, SECRET, NOW)).toMatchObject({ ok: false, reason: 'bad_signature' });
  });

  it('hash ignores _meta / commit_token and key order', async () => {
    const a = await canonicalArgsHash({ sid: 'x', types: ['b', 'a'], _meta: { user_goal: 'g' } });
    const b = await canonicalArgsHash({ types: ['b', 'a'], sid: 'x', commit_token: 'zzz' });
    expect(a).toBe(b);
  });
});

describe('preview-gate middleware', () => {
  const passthrough = async (): Promise<ToolResult> => ({ content: [{ type: 'text', text: 'EXECUTED' }] });

  it('lets non-dangerous tools straight through', async () => {
    const gate = makePreviewGate(mkDeps(memStore().store, SECRET));
    const res = await gate(mkCtx({}, mkDeps(memStore().store, SECRET), mkTool(false)), passthrough);
    expect(res.content[0].text).toBe('EXECUTED');
  });

  it('refuses dangerous tools when no secret (fail-closed)', async () => {
    const deps = mkDeps(memStore().store, null);
    const gate = makePreviewGate(deps);
    const res = await gate(mkCtx({ sid: 'ln_ac_1' }, deps), passthrough);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not configured|fail-closed/i);
  });

  it('phase 1 returns a preview without executing', async () => {
    const deps = mkDeps(memStore().store, SECRET);
    const gate = makePreviewGate(deps);
    let executed = false;
    const res = await gate(mkCtx({ sid: 'ln_ac_1', types: ['messaging'] }, deps), async () => {
      executed = true;
      return passthrough();
    });
    expect(executed).toBe(false);
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent?.preview).toBe(true);
    expect(typeof res.structuredContent?.commit_token).toBe('string');
    // A structured-only reader sees what it is confirming, not just a token
    // (the audit report of 2026-09-16, T2): the arguments (commit_token left
    // out) and a one-line effect summary built from them, mirrored in the text.
    expect(res.structuredContent?.arguments).toEqual({ sid: 'ln_ac_1', types: ['messaging'] });
    const summary = res.structuredContent?.summary as string;
    expect(summary).toMatch(/will run/);
    expect(summary).toContain('sid="ln_ac_1"');
    expect(summary).toContain('types=[1 item]');
    expect(res.content[0].text).toContain(summary);
  });

  it('phase 2 executes with a valid token and enforces single-use', async () => {
    const { store } = memStore();
    const deps = mkDeps(store, SECRET);
    const gate = makePreviewGate(deps);
    const args = { sid: 'ln_ac_1', types: ['messaging'] };

    const preview = await gate(mkCtx({ ...args }, deps), async () => passthrough());
    const token = preview.structuredContent!.commit_token as string;

    let seenArgs: Record<string, unknown> | undefined;
    const res = await gate(mkCtx({ ...args, commit_token: token }, deps), async (c) => {
      seenArgs = c.args;
      return passthrough();
    });
    expect(res.content[0].text).toBe('EXECUTED');
    expect(seenArgs).not.toHaveProperty('commit_token');

    // reuse -> rejected
    const reuse = await gate(mkCtx({ ...args, commit_token: token }, deps), async () => passthrough());
    expect(reuse.isError).toBe(true);
    expect(reuse.content[0].text).toMatch(/already used/i);
  });

  it('phase 2 rejects a forged token', async () => {
    const deps = mkDeps(memStore().store, SECRET);
    const gate = makePreviewGate(deps);
    const res = await gate(mkCtx({ sid: 'ln_ac_1', commit_token: 'not.a.real.token' }, deps), passthrough);
    expect(res.isError).toBe(true);
  });
});

// The validate twin: before a token is minted, the gate asks the backend whether
// the real route would refuse these arguments. What is pinned here is the contract
// with a backend that may or may not have a twin: a refusal arrives AT the preview
// and mints nothing, and every non-answer leaves the preview exactly as it was.
describe('preview gate: backend validate twin', () => {
  afterEach(() => vi.unstubAllGlobals());

  function depsWithBackend(): RuntimeDeps {
    const deps = mkDeps(memStore().store, SECRET);
    deps.config.baseUrls.linkedin = 'https://backend.test/linkedin/v4';
    return deps;
  }

  function stubFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  const never = async (): Promise<ToolResult> => {
    throw new Error('the action must not run at preview');
  };

  it('asks the twin of the same route, with the sid in the path and no commit_token in the body', async () => {
    const fetchMock = stubFetch(200, { success: true, operation: 'validate', valid: true, validated_requests: ['ResetSyncRequest'], meta: {} });
    const gate = makePreviewGate(depsWithBackend());

    const result = await gate(mkCtx({ sid: 'ln_ac_1', types: ['connections'] }, depsWithBackend()), never);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://backend.test/linkedin/v4/api/_validate/linkedin-accounts/ln_ac_1/reset-sync');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ types: ['connections'] });

    const preview = result.structuredContent as { preview: boolean; validated: boolean; commit_token: string };
    expect(preview.preview).toBe(true);
    expect(preview.validated).toBe(true);
    expect(preview.commit_token).toBeTruthy();
    expect(result.content[0].text).toContain("passed the backend's own validation");
  });

  it('returns the refusal the commit would get, and mints no token for it', async () => {
    stubFetch(422, {
      success: false,
      error: { code: 'validation_failed', message: 'The types field is required.', field_errors: { types: [{ rule: 'required', message: 'The types field is required.' }] } },
      meta: { trace_id: 'trace' },
    });
    const deps = depsWithBackend();

    const result = await makePreviewGate(deps)(mkCtx({ sid: 'ln_ac_1' }, deps), never);

    // Rendered by the same mapper the real call goes through, so the agent reads
    // at preview exactly what it would have read at commit.
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Validation failed for reset_linkedin_account_sync');
    expect(result.content[0].text).toContain('types');
    expect(JSON.stringify(result)).not.toContain('commit_token');
  });

  it.each([
    ['a backend without the twin (404)', 404, { success: false, error: { code: 'not_found', message: 'Not found.' }, meta: {} }],
    ['a backend in trouble (503)', 503, { success: false, error: { code: 'service_unavailable', message: 'Maintenance.' }, meta: {} }],
    ['an answer that is not the platform envelope', 200, '<html>gateway</html>'],
  ])('previews as before on %s', async (_label, status, body) => {
    stubFetch(status, body);
    const deps = depsWithBackend();

    const result = await makePreviewGate(deps)(mkCtx({ sid: 'ln_ac_1' }, deps), never);

    const preview = result.structuredContent as { preview: boolean; validated: boolean; commit_token: string };
    expect(result.isError).toBeFalsy();
    expect(preview.preview).toBe(true);
    expect(preview.validated).toBe(false);
    expect(preview.commit_token).toBeTruthy();
    expect(result.content[0].text).not.toContain("passed the backend's own validation");
  });

  it('previews as before when the backend cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const deps = depsWithBackend();

    const result = await makePreviewGate(deps)(mkCtx({ sid: 'ln_ac_1' }, deps), never);

    expect((result.structuredContent as { validated: boolean }).validated).toBe(false);
  });

  // The twin keeps a short fuse of its own: the backend fuse is 55 s since
  // 2026-11-11, and a twin that hung would have held the preview that long for
  // a check the preview then goes without.
  it('cuts a twin that hangs at its own fuse, not the backend fuse, and previews as before', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
          }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const deps = depsWithBackend();
      deps.config.backendTimeoutMs = 55_000;
      let result: ToolResult | undefined;

      void makePreviewGate(deps)(mkCtx({ sid: 'ln_ac_1' }, deps), never).then((r) => (result = r));
      // The arguments are hashed by WebCrypto, off the timers, before the twin is
      // asked: the clock moves from the moment the twin's fetch is out.
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(VALIDATE_TWIN_TIMEOUT_MS);
      await vi.waitFor(() => expect(result).toBeDefined());

      expect(VALIDATE_TWIN_TIMEOUT_MS).toBeLessThan(55_000);
      const preview = result?.structuredContent as { preview: boolean; validated: boolean; commit_token: string };
      expect(preview.preview).toBe(true);
      expect(preview.validated).toBe(false);
      expect(preview.commit_token).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not ask the twin again at commit: the confirmed call goes straight to the action', async () => {
    const fetchMock = stubFetch(200, { success: true, operation: 'validate', valid: true, validated_requests: [], meta: {} });
    const deps = depsWithBackend();
    const gate = makePreviewGate(deps);
    const args = { sid: 'ln_ac_1', types: ['connections'] };

    const preview = (await gate(mkCtx(args, deps), never)).structuredContent as { commit_token: string };
    let ran = 0;
    await gate(mkCtx({ ...args, commit_token: preview.commit_token }, deps), async () => {
      ran++;
      return { content: [{ type: 'text', text: 'done' }] };
    });

    expect(ran).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// A tool with a previewRoute (ported from gs.mcp 2026-11-07: the money of
// change_billing_subscription) asks the backend what the confirm would do on the
// preview call, with the tool's own args, and shows the answer whole.
describe('preview gate: previewRoute', () => {
  afterEach(() => vi.unstubAllGlobals());

  const BASE = 'https://id.test';
  const VALIDATED = { success: true, operation: 'validate', valid: true, validated_requests: [], meta: {} };
  const QUOTE = { immediate_charge: '1200', next_billed_amount: '4900', currency: 'USD', proration_mode: 'prorated_immediately', crosses_bracket: false };

  function depsWithId(): RuntimeDeps {
    const deps = mkDeps(memStore().store, SECRET);
    deps.config.baseUrls.id = BASE;
    return deps;
  }

  const change: ToolDefinition = {
    ...mkTool(true),
    name: 'change_billing_subscription',
    service: 'id',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/billing-subscriptions/{sid}/change', sidParam: 'sid' },
    previewRoute: { service: 'id', method: 'POST', pathTemplate: '/api/billing-subscriptions/{sid}/preview-change', sidParam: 'sid' },
  };

  /** The twin answers `twin`, the dry run `dryRun`; every call is recorded. */
  function stubBackend(twin: [number, unknown], dryRun: [number, unknown] | Error): Array<{ url: string; body: unknown }> {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body ? JSON.parse(init.body as string) : undefined });
      const answer = url.includes('/api/_validate/') ? twin : dryRun;
      if (answer instanceof Error) throw answer;
      return new Response(JSON.stringify(answer[1]), { status: answer[0] });
    }));
    return calls;
  }

  const never = async (): Promise<ToolResult> => {
    throw new Error('the action must not run at preview');
  };

  it('calls the route with the args on the preview call, and its result rides the preview', async () => {
    const calls = stubBackend([200, VALIDATED], [200, { success: true, operation: 'action', action: 'preview-change', item: null, result: QUOTE }]);
    const deps = depsWithId();

    const res = await makePreviewGate(deps)(mkCtx({ sid: 'bl_sb_1', quantity: 9, _meta: { user_goal: 'g' } }, deps, change), never);

    const dryRun = calls.find((call) => call.url.endsWith('/preview-change'));
    expect(dryRun?.url).toBe(`${BASE}/api/billing-subscriptions/bl_sb_1/preview-change`);
    expect(dryRun?.body).toEqual({ quantity: 9 });
    const preview = res.structuredContent as { preview_result: { status: string; result?: typeof QUOTE }; commit_token: string; validated: boolean };
    expect(preview.preview_result.status).toBe('answered');
    expect(preview.preview_result.result?.immediate_charge).toBe('1200');
    expect(preview.validated).toBe(true);
    expect(typeof preview.commit_token).toBe('string');
    expect(res.content[0].text).toMatch(/immediate_charge/);
  });

  it('a route that refuses leaves the preview standing, unanswered', async () => {
    stubBackend([200, VALIDATED], [403, { success: false, error: { code: 'forbidden', message: 'no' } }]);
    const deps = depsWithId();

    const res = await makePreviewGate(deps)(mkCtx({ sid: 'bl_sb_1', quantity: 9 }, deps, change), never);

    const preview = res.structuredContent as { preview_result: { status: string; detail?: string; result?: unknown }; commit_token: string };
    expect(preview.preview_result.status).toBe('unanswered');
    expect(preview.preview_result.detail).toContain('forbidden');
    expect(preview.preview_result).not.toHaveProperty('result');
    expect(res.content[0].text).toMatch(/did not answer/);
    expect(typeof preview.commit_token).toBe('string');
  });

  it('a route that cannot be reached leaves the preview standing, unanswered', async () => {
    stubBackend([200, VALIDATED], new Error('ECONNREFUSED'));
    const deps = depsWithId();

    const res = await makePreviewGate(deps)(mkCtx({ sid: 'bl_sb_1', quantity: 9 }, deps, change), never);

    const preview = res.structuredContent as { preview_result: { status: string }; commit_token: string };
    expect(preview.preview_result.status).toBe('unanswered');
    expect(typeof preview.commit_token).toBe('string');
  });

  it('a refusal of the validate twin ends the preview there: no dry run, no token', async () => {
    const calls = stubBackend(
      [422, { success: false, error: { code: 'validation_failed', message: 'nothing_to_change', field_errors: { quantity: [{ rule: 'nothing_to_change', message: 'nothing_to_change' }] } }, meta: {} }],
      [200, { success: true, result: QUOTE }],
    );
    const deps = depsWithId();

    const res = await makePreviewGate(deps)(mkCtx({ sid: 'bl_sb_1' }, deps, change), never);

    expect(res.isError).toBe(true);
    expect(calls.map((call) => call.url)).toEqual([`${BASE}/api/_validate/billing-subscriptions/bl_sb_1/change`]);
    expect(JSON.stringify(res)).not.toContain('commit_token');
  });

  it('the confirmed call goes straight to the action: no dry run again', async () => {
    const calls = stubBackend([200, VALIDATED], [200, { success: true, result: QUOTE }]);
    const deps = depsWithId();
    const gate = makePreviewGate(deps);
    const args = { sid: 'bl_sb_1', quantity: 9 };

    const preview = (await gate(mkCtx(args, deps, change), never)).structuredContent as { commit_token: string };
    const callsAtPreview = calls.length;
    let ran = 0;
    await gate(mkCtx({ ...args, commit_token: preview.commit_token }, deps, change), async () => {
      ran++;
      return { content: [{ type: 'text', text: 'done' }] };
    });

    expect(ran).toBe(1);
    expect(calls).toHaveLength(callsAtPreview);
  });

  it('a tool without a previewRoute carries no preview_result', async () => {
    stubBackend([200, VALIDATED], [200, { success: true, result: QUOTE }]);
    const deps = depsWithId();
    const tool: ToolDefinition = { ...change, previewRoute: undefined };

    const res = await makePreviewGate(deps)(mkCtx({ sid: 'bl_sb_1', quantity: 9 }, deps, tool), never);

    expect(res.structuredContent?.preview_result).toBeUndefined();
    expect(typeof res.structuredContent?.commit_token).toBe('string');
  });
});

