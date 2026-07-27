import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  canonicalArgsHash,
  mintCommitToken,
  verifyCommitToken,
  makePreviewGate,
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
    creditable: false,
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
      backendTimeoutMs: 1000, responseCharBudget: 1000,
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
