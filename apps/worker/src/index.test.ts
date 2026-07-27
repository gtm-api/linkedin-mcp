import { describe, expect, it } from 'vitest';
import worker from './index';
import { MOUNTS } from './mounts.config';
import type { Env } from './env';

// What the edge ACTUALLY answers, per config. The unit level is config.test.ts;
// this file is the contract an uptime monitor and an MCP client see.

const KV = { get: async () => null, put: async () => {} } as unknown as KVNamespace;
const LIMITER = { limit: async () => ({ success: true }) } as unknown as RateLimit;
const ORIGIN = 'https://mcp.gtm-api.test';
const ISSUER = 'https://id.gtm-api.test';
const RESOURCE = `${ORIGIN}/mcp`;
const MOUNT = MOUNTS.find((m) => m.facade !== 'toolsets')!.path;

const healthy = (over: Partial<Env> = {}): Env => ({
  ENV_NAME: 'production',
  LINKEDIN_BASE_URL: 'https://linkedin.gtm-api.test',
  ID_BASE_URL: ISSUER,
  ORCHESTRATION_BASE_URL: 'https://orchestration.gtm-api.test',
  AUTH_MODE: 'jwt',
  AUTH_ISSUER: ISSUER,
  MCP_RESOURCE_URL: RESOURCE,
  PREVIEW_TOKEN_SECRET: 'a-real-32-byte-looking-secret-value',
  COMMIT_TOKENS: KV,
  RATE_LIMIT_CALLS: LIMITER,
  RATE_LIMIT_WRITES: LIMITER,
  ...over,
});

// [env.production.vars] of wrangler.toml as it ships, before anyone fills the
// TODOs in: this is the deploy the audit caught answering 200 with 250 tools.
const asShipped = (): Env => ({
  ENV_NAME: 'production',
  LINKEDIN_BASE_URL: 'https://TODO-linkedin-prod-url',
  ID_BASE_URL: 'https://TODO-id-prod-url',
  ORCHESTRATION_BASE_URL: 'https://TODO-orchestration-prod-url',
  AUTH_MODE: 'jwt',
});

const seg = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
/** A structurally valid HS256 JWT. The edge never checks the signature (the backend guard does). */
const jwt = (payload: Record<string, unknown>): string =>
  `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg(payload)}.signature-checked-by-the-backend`;

const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;
const anHourAgo = () => Math.floor(Date.now() / 1000) - 3600;

const get = (env: Env, path: string) => worker.fetch(new Request(`${ORIGIN}${path}`), env);

const listTools = (env: Env, token?: string) =>
  worker.fetch(
    new Request(`${ORIGIN}${MOUNT}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    }),
    env,
  );

const body = async (res: Response) => (await res.json()) as Record<string, never>;

describe('/health', () => {
  it('is 200 and ok when the worker is fully operational', async () => {
    const res = await get(healthy(), '/health');
    const json = await body(res);
    expect(res.status).toBe(200);
    expect(json.status).toBe('ok');
    expect(json.problems).toEqual([]);
    expect(Number(json.tools)).toBeGreaterThan(0);
  });

  it('is 503 and fail on the worker as wrangler.toml ships it, and says which vars', async () => {
    const res = await get(asShipped(), '/health');
    const json = await body(res);
    // A Cloudflare health check with the default expected code alerts on this
    // without anyone configuring body matching. That is the point of the code.
    expect(res.status).toBe(503);
    expect(json.status).toBe('fail');
    const problemKeys = (json.problems as unknown as { key: string }[]).map((p) => p.key);
    expect(problemKeys).toEqual(
      expect.arrayContaining([
        'LINKEDIN_BASE_URL',
        'ID_BASE_URL',
        'ORCHESTRATION_BASE_URL',
        'AUTH_ISSUER',
        'MCP_RESOURCE_URL',
      ]),
    );
    // Still reports the catalog: the tools exist, they are just unreachable.
    expect(Number(json.tools)).toBeGreaterThan(0);
  });

  it('is 200 and degraded when it serves with the preview gate off', async () => {
    // Deliberately NOT a 503: reads all work, dangerous tools refuse fail-closed,
    // and a monitor that pages on this would page for a working worker. The
    // `status` field is what a body-matching monitor alerts on.
    const res = await get(healthy({ PREVIEW_TOKEN_SECRET: undefined, COMMIT_TOKENS: undefined }), '/health');
    const json = await body(res);
    expect(res.status).toBe(200);
    expect(json.status).toBe('degraded');
    expect(json.gate).toBe('off');
    expect(json.commit_tokens).toBe('missing');
  });

  it('is never cached', async () => {
    const res = await get(healthy(), '/health');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('OAuth discovery', () => {
  it('serves the protected-resource document when it is configured', async () => {
    const res = await get(healthy(), '/.well-known/oauth-protected-resource');
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({
      resource: RESOURCE,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ['header'],
    });
  });

  it('fails like the health check instead of answering an empty document', async () => {
    const res = await get(asShipped(), '/.well-known/oauth-protected-resource');
    const json = await body(res);
    expect(res.status).toBe(503);
    expect(json.error).toBe('configuration_error');
    expect(json.missing).toEqual(['MCP_RESOURCE_URL', 'AUTH_ISSUER']);
    // The old answer, which no MCP client can bootstrap from.
    expect(json).not.toHaveProperty('authorization_servers');
    expect(json).not.toHaveProperty('resource');
  });

  it('reports what is missing even in dev, where the worker still serves', async () => {
    const env = healthy({ ENV_NAME: 'local', AUTH_MODE: 'dev', AUTH_ISSUER: undefined });
    expect((await get(env, '/health')).status).toBe(200);
    expect((await get(env, '/.well-known/oauth-protected-resource')).status).toBe(503);
  });
});

describe('a non-dev AUTH_MODE without an issuer cannot serve', () => {
  // The audit's sharpest case. Before this change the worker answered
  // tools/list for this exact request: AUTH_ISSUER and MCP_RESOURCE_URL were
  // absent, so verifier.ts guarded both claim checks on truthiness and skipped
  // them, and an expired token minted by a stranger passed the edge.
  const foreignExpired = jwt({ iss: 'https://attacker.example', exp: anHourAgo() });

  it('refuses the MCP request with 503 rather than serving with the checks off', async () => {
    const res = await listTools(healthy({ AUTH_ISSUER: undefined, MCP_RESOURCE_URL: undefined }), foreignExpired);
    const json = await body(res);
    expect(res.status).toBe(503);
    expect(json.error).toBe('configuration_error');
    expect(json).not.toHaveProperty('result');
    expect((json.problems as unknown as { key: string }[]).map((p) => p.key)).toEqual([
      'AUTH_ISSUER',
      'MCP_RESOURCE_URL',
    ]);
  });

  it('refuses every mount, not just the one that was called', async () => {
    const env = healthy({ AUTH_MODE: 'jwt', AUTH_ISSUER: undefined, MCP_RESOURCE_URL: undefined });
    for (const mount of MOUNTS) {
      const res = await worker.fetch(
        new Request(`${ORIGIN}${mount.path}`, { method: 'POST', body: '{}' }),
        env,
      );
      expect(res.status, mount.path).toBe(503);
    }
  });

  it('refuses AUTH_MODE=dev in a deployed ENV_NAME', async () => {
    const env = healthy({ AUTH_MODE: 'dev', DEV_BEARER: jwt({ iss: ISSUER, exp: inAnHour() }) });
    expect((await listTools(env)).status).toBe(503);
  });
});

describe('the healthy path still serves', () => {
  it('answers tools/list for a token from the configured issuer', async () => {
    const res = await listTools(
      healthy(),
      jwt({ iss: ISSUER, exp: inAnHour(), access_identity: { actor_type: 'user', actor_sid: 'us_mb_1' } }),
    );
    const json = await body(res);
    expect(res.status).toBe(200);
    expect((json.result as unknown as { tools: unknown[] }).tools.length).toBeGreaterThan(0);
  });

  it('enforces iss, aud and exp now that they cannot be switched off', async () => {
    const cases: [string, string][] = [
      ['foreign issuer', jwt({ iss: 'https://attacker.example', exp: inAnHour() })],
      ['expired', jwt({ iss: ISSUER, exp: anHourAgo() })],
      ['wrong audience', jwt({ iss: ISSUER, exp: inAnHour(), aud: 'https://someone-elses-mcp.test/mcp' })],
      ['no iss claim at all', jwt({ exp: inAnHour() })],
    ];
    for (const [label, token] of cases) {
      const res = await listTools(healthy(), token);
      expect(res.status, label).toBe(401);
      expect((await body(res)).error, label).toBe('invalid_token');
    }
  });

  it('401s a request with no bearer, pointing at the discovery document', async () => {
    const res = await listTools(healthy());
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain(`${ORIGIN}/.well-known/oauth-protected-resource`);
  });

  it('keeps the local bare-URL connector working (AUTH_MODE=dev + DEV_BEARER)', async () => {
    const env = healthy({
      ENV_NAME: 'local',
      AUTH_MODE: 'dev',
      // jwt:fake carries an artisan-context iss, which dev mode does not check.
      DEV_BEARER: jwt({ iss: 'artisan', exp: inAnHour(), access_identity: { actor_type: 'user' } }),
    });
    const json = await body(await listTools(env));
    expect((json.result as unknown as { tools: unknown[] }).tools.length).toBeGreaterThan(0);
  });

  it('still routes: an unknown path is a 404, not a config refusal', async () => {
    const res = await worker.fetch(new Request(`${ORIGIN}/mcp/nope`, { method: 'POST', body: '{}' }), healthy());
    expect(res.status).toBe(404);
    expect((await body(res)).error).toBe('not_found');
  });

  it('still answers the CORS preflight', async () => {
    const res = await worker.fetch(new Request(`${ORIGIN}${MOUNT}`, { method: 'OPTIONS' }), asShipped());
    expect(res.status).toBe(204);
  });
});
