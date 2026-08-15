import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { isolateCounter, makeRateLimitGate, rateLimitSubject } from './rate-limit';
import { stubGate } from './stub-gate';
import { composeChain } from '../chain';
import type {
  AuthScope,
  DispatchContext,
  EdgeRateLimiter,
  RateLimitConfig,
  RuntimeDeps,
  ToolDefinition,
  ToolResult,
} from '../types';

const NOW = 1_700_000_000_000;

const LIMITS: RateLimitConfig = {
  enabled: true,
  windowSeconds: 60,
  callsPerWindow: 5,
  writesPerWindow: 2,
};

function mkTool(readOnly: boolean, over: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: readOnly ? 'search_linkedin_accounts' : 'send_linkedin_message',
    description: 'd',
    service: 'linkedin',
    entity: 'e',
    mount: 'm',
    route: { service: 'linkedin', method: readOnly ? 'GET' : 'POST', pathTemplate: '/api/x' },
    operation: readOnly ? 'search' : 'action',
    envelope: readOnly ? 'search' : 'action',
    availability: 'ga',
    dangerous: false,
    inputSchema: z.object({ _meta: z.any().optional() }),
    outputSchema: z.any(),
    annotations: {
      title: 't',
      readOnlyHint: readOnly,
      destructiveHint: !readOnly,
      idempotentHint: readOnly,
      openWorldHint: false,
    },
    ...over,
  };
}

function mkDeps(
  over: { rateLimit?: Partial<RateLimitConfig>; rateLimiters?: RuntimeDeps['rateLimiters'] } = {},
  logs: Record<string, unknown>[] = [],
): RuntimeDeps {
  return {
    config: {
      envName: 'test',
      version: '0',
      baseUrls: { linkedin: '', id: '', orchestration: '', support: '' },
      backendTimeoutMs: 1000,
      responseCharBudget: 0,
      maxBatchSize: 16,
      rateLimit: { ...LIMITS, ...over.rateLimit },
      previewGate: { enabled: false, secret: null, ttlSeconds: 300 },
    },
    logger: { info: (e) => void logs.push(e), error: () => {} },
    rateLimiters: over.rateLimiters,
    now: () => NOW,
  };
}

const SCOPE: AuthScope = {
  token: 'header.payload.signature',
  teamSid: 'ts_tm_seeddev00001',
  actor: { type: 'user', sid: 'us_mb_seeddev00001' },
  permissions: [],
  traceId: 'trace-1',
  mountPath: '/mcp/linkedin/accounts',
};

function mkCtx(tool: ToolDefinition, deps: RuntimeDeps, scope: AuthScope = SCOPE): DispatchContext {
  return { tool, args: {}, scope, deps };
}

const EXECUTED = async (): Promise<ToolResult> => ({ content: [{ type: 'text', text: 'EXECUTED' }] });

describe('rate-limit subject (the axis)', () => {
  it('keys on the team when the Team-SID header set one', async () => {
    expect(await rateLimitSubject(SCOPE)).toEqual({ key: 'team:ts_tm_seeddev00001', axis: 'team' });
  });

  it('falls back to the team CLAIM, which is the ordinary case (no Team-SID header)', async () => {
    const subject = await rateLimitSubject({ ...SCOPE, teamSid: null, tokenTeamSid: 'ts_tm_fromclaim01' });
    expect(subject).toEqual({ key: 'team:ts_tm_fromclaim01', axis: 'team' });
  });

  it('falls back to the actor when the token carries no team at all', async () => {
    const subject = await rateLimitSubject({ ...SCOPE, teamSid: null, tokenTeamSid: null });
    expect(subject).toEqual({ key: 'actor:user:us_mb_seeddev00001', axis: 'actor' });
  });

  it('last resort is a token FINGERPRINT, never the bearer itself', async () => {
    const scope: AuthScope = { ...SCOPE, teamSid: null, tokenTeamSid: null, actor: { type: 'system', sid: null } };
    const subject = await rateLimitSubject(scope);
    expect(subject.axis).toBe('token');
    expect(subject.key).toMatch(/^token:[0-9a-f]{16}$/);
    expect(subject.key).not.toContain(SCOPE.token);
    // Stable, or the bucket resets on every call and limits nothing.
    expect((await rateLimitSubject(scope)).key).toBe(subject.key);
  });

  it('gives two teams two buckets', async () => {
    const a = await rateLimitSubject(SCOPE);
    const b = await rateLimitSubject({ ...SCOPE, teamSid: 'ts_tm_other000001' });
    expect(a.key).not.toBe(b.key);
  });
});

describe('rate-limit gate', () => {
  it('passes calls under the limit through to the next link', async () => {
    const deps = mkDeps();
    const gate = makeRateLimitGate(deps, isolateCounter());
    for (let i = 0; i < LIMITS.callsPerWindow; i += 1) {
      const res = await gate(mkCtx(mkTool(true), deps), EXECUTED);
      expect(res.content[0].text).toBe('EXECUTED');
    }
  });

  it('short-circuits the call over the limit: next is never reached', async () => {
    const deps = mkDeps();
    const gate = makeRateLimitGate(deps, isolateCounter());
    let calls = 0;
    const next = async (): Promise<ToolResult> => {
      calls += 1;
      return { content: [{ type: 'text', text: 'EXECUTED' }] };
    };
    for (let i = 0; i < LIMITS.callsPerWindow + 3; i += 1) {
      await gate(mkCtx(mkTool(true), deps), next);
    }
    expect(calls).toBe(LIMITS.callsPerWindow);
  });

  it('returns the backend rate_limited envelope, with a retry hint the agent can act on', async () => {
    const deps = mkDeps();
    const gate = makeRateLimitGate(deps, isolateCounter());
    let res: ToolResult = { content: [] };
    for (let i = 0; i < LIMITS.callsPerWindow + 1; i += 1) {
      res = await gate(mkCtx(mkTool(true), deps), EXECUTED);
    }
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({
      success: false,
      error: {
        code: 'rate_limited',
        recoverable: true,
        context: {
          source: 'mcp_runtime',
          bucket: 'calls',
          limit: LIMITS.callsPerWindow,
          window_seconds: 60,
          enforcement: 'isolate_local',
          subject_axis: 'team',
        },
      },
    });
    const retryAfter = (res.structuredContent as { error: { context: { retry_after: number } } }).error.context
      .retry_after;
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
    // Rendered through error-map, so it reads exactly like a backend 429 and a
    // client that only reads content[] still learns the wait and what to do.
    expect(res.content[0].text).toContain(`Retryable: retry after ${retryAfter}s.`);
    expect(res.content[0].text).toContain('Nothing was sent to the backend');
  });

  it('holds a write to the tighter bucket while reads still flow', async () => {
    const deps = mkDeps();
    const counter = isolateCounter();
    const gate = makeRateLimitGate(deps, counter);

    for (let i = 0; i < LIMITS.writesPerWindow; i += 1) {
      expect((await gate(mkCtx(mkTool(false), deps), EXECUTED)).isError).toBeUndefined();
    }
    const blocked = await gate(mkCtx(mkTool(false), deps), EXECUTED);
    expect(blocked.isError).toBe(true);
    expect(blocked.structuredContent).toMatchObject({ error: { context: { bucket: 'writes' } } });

    // The calls bucket is 5 and the writes above spent 3 of it, so a read is
    // still served. The two buckets are genuinely separate ceilings.
    const read = await gate(mkCtx(mkTool(true), deps), EXECUTED);
    expect(read.content[0].text).toBe('EXECUTED');
  });

  it('never charges a read to the write bucket', async () => {
    const deps = mkDeps({ rateLimit: { callsPerWindow: 100 } });
    const gate = makeRateLimitGate(deps, isolateCounter());
    for (let i = 0; i < 20; i += 1) await gate(mkCtx(mkTool(true), deps), EXECUTED);
    // 20 reads in; the write bucket (2) must still be untouched.
    expect((await gate(mkCtx(mkTool(false), deps), EXECUTED)).content[0].text).toBe('EXECUTED');
  });

  it('one tenant hitting its limit does not touch another tenant', async () => {
    const deps = mkDeps();
    const gate = makeRateLimitGate(deps, isolateCounter());
    for (let i = 0; i < LIMITS.callsPerWindow + 2; i += 1) {
      await gate(mkCtx(mkTool(true), deps), EXECUTED);
    }
    const other = mkCtx(mkTool(true), deps, { ...SCOPE, teamSid: 'ts_tm_other000001' });
    expect((await gate(other, EXECUTED)).content[0].text).toBe('EXECUTED');
  });

  it('uses the platform binding when one is bound, and says so in the error', async () => {
    const seen: string[] = [];
    let allow = true;
    const binding: EdgeRateLimiter = {
      limit: async ({ key }) => {
        seen.push(key);
        return { success: allow };
      },
    };
    const deps = mkDeps({ rateLimiters: { calls: binding } });
    // The isolate counter is passed too, and must go unused for the bound bucket.
    const gate = makeRateLimitGate(deps, isolateCounter());

    expect((await gate(mkCtx(mkTool(true), deps), EXECUTED)).content[0].text).toBe('EXECUTED');
    expect(seen).toEqual(['calls:team:ts_tm_seeddev00001']);

    allow = false;
    const blocked = await gate(mkCtx(mkTool(true), deps), EXECUTED);
    expect(blocked.structuredContent).toMatchObject({
      error: { context: { enforcement: 'edge_binding', retry_after: 60 } },
    });
  });

  it('is a no-op when the gate is switched off', async () => {
    const deps = mkDeps({ rateLimit: { enabled: false, callsPerWindow: 1 } });
    const gate = makeRateLimitGate(deps, isolateCounter());
    for (let i = 0; i < 50; i += 1) {
      expect((await gate(mkCtx(mkTool(false), deps), EXECUTED)).content[0].text).toBe('EXECUTED');
    }
  });

  it('a bucket limit of 0 disables that bucket instead of blocking everything', async () => {
    const deps = mkDeps({ rateLimit: { writesPerWindow: 0 } });
    const gate = makeRateLimitGate(deps, isolateCounter());
    for (let i = 0; i < LIMITS.callsPerWindow; i += 1) {
      expect((await gate(mkCtx(mkTool(false), deps), EXECUTED)).content[0].text).toBe('EXECUTED');
    }
  });

  it('logs the breach without ever logging the subject key', async () => {
    const logs: Record<string, unknown>[] = [];
    const deps = mkDeps({}, logs);
    const gate = makeRateLimitGate(deps, isolateCounter());
    for (let i = 0; i < LIMITS.callsPerWindow + 1; i += 1) {
      await gate(mkCtx(mkTool(true), deps), EXECUTED);
    }
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ event: 'rate_limited', bucket: 'calls', subject_axis: 'team' });
    const line = JSON.stringify(logs[0]);
    expect(line).not.toContain(SCOPE.teamSid!);
    expect(line).not.toContain(SCOPE.token);
  });

  // Chain position: the gate has to run AHEAD of stub-gate, or a caller can
  // storm the 15 stub tools for free and never be counted.
  it('counts a stub_501 call, which stub-gate would otherwise answer for free', async () => {
    const deps = mkDeps({ rateLimit: { callsPerWindow: 2 } });
    const stub = mkTool(true, { availability: 'stub_501' });
    const run = composeChain([makeRateLimitGate(deps, isolateCounter()), stubGate], EXECUTED);

    expect((await run(mkCtx(stub, deps))).structuredContent).toMatchObject({
      error: { code: 'not_implemented' },
    });
    await run(mkCtx(stub, deps));
    expect((await run(mkCtx(stub, deps))).structuredContent).toMatchObject({
      error: { code: 'rate_limited' },
    });
  });
});

describe('isolate-local counter', () => {
  it('rolls the window over: a new window starts a fresh count', () => {
    const counter = isolateCounter();
    for (let i = 0; i < 3; i += 1) {
      expect(counter.hit('k', 3, 60, NOW).allowed).toBe(true);
    }
    expect(counter.hit('k', 3, 60, NOW).allowed).toBe(false);
    expect(counter.hit('k', 3, 60, NOW + 60_000).allowed).toBe(true);
  });

  it('reports the exact seconds left in the window, never 0', () => {
    const counter = isolateCounter();
    const windowStart = Math.floor(NOW / 60_000) * 60_000;
    expect(counter.hit('k', 10, 60, windowStart).retryAfterSeconds).toBe(60);
    expect(counter.hit('k', 10, 60, windowStart + 59_500).retryAfterSeconds).toBe(1);
  });

  it('stays bounded: a flood of distinct subjects does not grow the map forever', () => {
    const counter = isolateCounter(4);
    for (let i = 0; i < 500; i += 1) counter.hit(`subject-${i}`, 10, 60, NOW);
    // The tenant that is actually hammering keeps its count: it has the highest
    // count, so it is the last thing shedding would drop.
    for (let i = 0; i < 10; i += 1) counter.hit('hammer', 10, 60, NOW);
    expect(counter.hit('hammer', 10, 60, NOW).allowed).toBe(false);
  });
});
