import { describe, expect, it } from 'vitest';
import { buildRegistry, resolveMounts } from '@gtm/mcp-runtime';
import { linkedinPackages } from '@gtm/mcp-linkedin';
import { idPackages } from '@gtm/mcp-id';
import { orchestrationPackages } from '@gtm/mcp-orchestration';
import { supportPackages } from '@gtm/mcp-support';
import { MOUNTS } from './mounts.config';
import { inspectConfig, requiredBaseUrlServices, type ConfigProblem } from './config';
import { buildRuntimeConfig, type Env } from './env';

// The config check, unit level. The HTTP behaviour it drives (503 vs degraded,
// the discovery document, the refusal) is index.test.ts.

const KV = { get: async () => null, put: async () => {} } as unknown as KVNamespace;
const LIMITER = { limit: async () => ({ success: true }) } as unknown as RateLimit;

const SERVICES = ['linkedin', 'id', 'orchestration'] as const;

/** A deployed worker with everything set. Every case below spoils one field. */
const healthy = (over: Partial<Env> = {}): Env => ({
  ENV_NAME: 'production',
  LINKEDIN_BASE_URL: 'https://linkedin.gtm-api.test',
  ID_BASE_URL: 'https://id.gtm-api.test',
  ORCHESTRATION_BASE_URL: 'https://orchestration.gtm-api.test',
  AUTH_MODE: 'jwt',
  AUTH_ISSUER: 'https://id.gtm-api.test',
  MCP_RESOURCE_URL: 'https://mcp.gtm-api.test/mcp',
  PREVIEW_TOKEN_SECRET: 'a-real-32-byte-looking-secret-value',
  COMMIT_TOKENS: KV,
  RATE_LIMIT_CALLS: LIMITER,
  RATE_LIMIT_WRITES: LIMITER,
  ...over,
});

const keys = (problems: ConfigProblem[], severity: ConfigProblem['severity']): string[] =>
  problems.filter((p) => p.severity === severity).map((p) => p.key).sort();

const check = (env: Env) => inspectConfig(env, SERVICES);

describe('required services are derived from the mounts, not listed', () => {
  const resolved = resolveMounts(
    buildRegistry([...linkedinPackages, ...idPackages, ...orchestrationPackages, ...supportPackages]),
    MOUNTS,
  );

  it('demands a base URL for every service the worker dispatches to, and only those', () => {
    // 'support' runs in-worker (localHandler), so it must NOT be demanded: if it
    // is, someone gave a support tool an HTTP route and the check says so.
    expect(requiredBaseUrlServices(resolved)).toEqual(['id', 'linkedin', 'orchestration']);
  });

  it('a service with no base URL variable mapped is fatal, not silently skipped', () => {
    const report = inspectConfig(healthy(), ['support']);
    expect(report.status).toBe('fail');
    expect(keys(report.problems, 'fatal')).toContain('support.base_url');
  });
});

describe('a fully configured worker', () => {
  it('is ok, with no problems and a jwt auth config', () => {
    const report = check(healthy());
    expect(report.status).toBe('ok');
    expect(report.problems).toEqual([]);
    expect(report.auth).toEqual({
      mode: 'jwt',
      issuer: 'https://id.gtm-api.test',
      resource: 'https://mcp.gtm-api.test/mcp',
    });
    expect(report.previewGate).toBe('armed');
    expect(report.commitTokens).toBe('bound');
    expect(report.discovery).toEqual({
      status: 'ok',
      resource: 'https://mcp.gtm-api.test/mcp',
      authorizationServers: ['https://id.gtm-api.test'],
    });
  });
});

describe('base URLs', () => {
  it('flags the wrangler.toml deploy placeholders as fatal, one problem per service', () => {
    // Verbatim from [env.production.vars] before someone fills them in.
    const report = check(
      healthy({
        LINKEDIN_BASE_URL: 'https://TODO-linkedin-prod-url',
        ID_BASE_URL: 'https://TODO-id-prod-url',
        ORCHESTRATION_BASE_URL: 'https://TODO-orchestration-prod-url',
      }),
    );
    expect(report.status).toBe('fail');
    expect(keys(report.problems, 'fatal')).toEqual(['ID_BASE_URL', 'LINKEDIN_BASE_URL', 'ORCHESTRATION_BASE_URL']);
    expect(report.problems[0].detail).toContain('placeholder');
  });

  it('flags a missing one and a non-http one', () => {
    expect(keys(check(healthy({ ID_BASE_URL: '' })).problems, 'fatal')).toEqual(['ID_BASE_URL']);
    expect(keys(check(healthy({ ID_BASE_URL: 'id.gtm-api.test' })).problems, 'fatal')).toEqual(['ID_BASE_URL']);
    expect(keys(check(healthy({ ID_BASE_URL: 'ftp://id.gtm-api.test' })).problems, 'fatal')).toEqual(['ID_BASE_URL']);
  });

  it('keeps a placeholder out of the runtime config instead of dispatching to it', () => {
    const config = buildRuntimeConfig(healthy({ LINKEDIN_BASE_URL: 'https://linkedin.gtm-api.test/' }));
    expect(config.baseUrls.linkedin).toBe('https://linkedin.gtm-api.test/');
    expect(config.baseUrls.support).toBe('');
  });
});

describe('AUTH_MODE', () => {
  // The audit case: AUTH_MODE=jwt with neither var set made verifier.ts skip the
  // iss and aud checks, so any token from any issuer passed the edge.
  it('jwt with no issuer and no resource is fatal and yields NO auth config', () => {
    const report = check(healthy({ AUTH_ISSUER: undefined, MCP_RESOURCE_URL: undefined }));
    expect(report.status).toBe('fail');
    expect(report.auth).toBeNull();
    expect(keys(report.problems, 'fatal')).toEqual(['AUTH_ISSUER', 'MCP_RESOURCE_URL']);
    for (const problem of report.problems.filter((p) => p.severity === 'fatal')) {
      expect(problem.detail).toMatch(/refuses to serve/);
    }
  });

  it('jwt with a placeholder issuer is fatal too', () => {
    const report = check(healthy({ AUTH_ISSUER: 'https://TODO-issuer' }));
    expect(report.status).toBe('fail');
    expect(report.auth).toBeNull();
  });

  it('an unset or unknown AUTH_MODE is fatal rather than silently meaning "not dev"', () => {
    for (const mode of [undefined, '', 'oauth', 'DEV']) {
      const report = check(healthy({ AUTH_MODE: mode }));
      expect(report.status, `AUTH_MODE=${String(mode)}`).toBe('fail');
      expect(report.auth).toBeNull();
      expect(keys(report.problems, 'fatal')).toContain('AUTH_MODE');
    }
  });

  it('dev is refused outside a local ENV_NAME, and accepted inside one', () => {
    const deployed = check(healthy({ AUTH_MODE: 'dev', DEV_BEARER: 'header.body.sig' }));
    expect(deployed.status).toBe('fail');
    expect(deployed.auth).toBeNull();
    expect(keys(deployed.problems, 'fatal')).toEqual(['AUTH_MODE']);

    const local = check(healthy({ ENV_NAME: 'local', AUTH_MODE: 'dev', DEV_BEARER: 'header.body.sig' }));
    expect(local.status).toBe('ok');
    expect(local.auth).toEqual({
      mode: 'dev',
      devBearer: 'header.body.sig',
      resource: 'https://mcp.gtm-api.test/mcp',
    });
  });
});

describe('the preview gate degrades, it does not kill the worker', () => {
  it('no secret is a warning: dangerous tools refuse, reads keep working', () => {
    const report = check(healthy({ PREVIEW_TOKEN_SECRET: undefined }));
    expect(report.status).toBe('degraded');
    expect(report.previewGate).toBe('off');
    expect(keys(report.problems, 'warning')).toEqual(['PREVIEW_TOKEN_SECRET']);
    expect(keys(report.problems, 'fatal')).toEqual([]);
  });

  it('a placeholder secret does not arm the gate', () => {
    const env = healthy({ PREVIEW_TOKEN_SECRET: 'TODO-set-a-real-secret' });
    expect(check(env).previewGate).toBe('off');
    expect(buildRuntimeConfig(env).previewGate).toEqual({ enabled: false, secret: null, ttlSeconds: 300 });
  });

  it('an unresolved COMMIT_TOKENS binding is a warning', () => {
    const report = check(healthy({ COMMIT_TOKENS: undefined }));
    expect(report.status).toBe('degraded');
    expect(report.commitTokens).toBe('missing');
    expect(keys(report.problems, 'warning')).toEqual(['COMMIT_TOKENS']);
  });
});

describe('numeric knobs', () => {
  it('a non-numeric backend timeout is fatal (setTimeout would abort every call at 0ms)', () => {
    const report = check(healthy({ BACKEND_TIMEOUT_MS: 'twenty seconds' }));
    expect(report.status).toBe('fail');
    expect(keys(report.problems, 'fatal')).toEqual(['BACKEND_TIMEOUT_MS']);
    expect(buildRuntimeConfig(healthy()).backendTimeoutMs).toBe(25000);
  });

  it('a bad response budget is only a warning, and unset is not a problem at all', () => {
    expect(keys(check(healthy({ RESPONSE_CHAR_BUDGET: '-1' })).problems, 'warning')).toEqual([
      'RESPONSE_CHAR_BUDGET',
    ]);
    expect(check(healthy({ RESPONSE_CHAR_BUDGET: undefined, BACKEND_TIMEOUT_MS: undefined })).status).toBe('ok');
  });
});

describe('discovery', () => {
  it('names what is missing instead of producing an empty document', () => {
    const report = check(healthy({ ENV_NAME: 'local', AUTH_MODE: 'dev', MCP_RESOURCE_URL: undefined }));
    expect(report.discovery).toEqual({ status: 'unconfigured', missing: ['MCP_RESOURCE_URL'] });
    // Unusable discovery in dev is a warning, not a dead worker.
    expect(report.status).toBe('degraded');
  });
});
