import { DEFAULT_MAX_BATCH_SIZE, type RateLimitConfig, type ResolvedMount, type ServiceId } from '@gtm/mcp-runtime';
import type { Env } from './env';

// One config check for the whole worker.
//
// The gap this closes: nothing validated the environment at boot, so a worker
// with three TODO base URLs and no AUTH_ISSUER answered /health with 200 and a
// catalog of 250 tools while every single call failed. The catalog is built
// from the registry, which is env-independent, so it looks identical on a
// worker that cannot serve one request.
//
// Severity is the whole design, and it splits on ONE question: does the
// misconfiguration make the worker WRONG, or only SMALLER?
//
//   fatal   - the worker cannot serve correctly, or would serve unsafely.
//             /health answers 503 and every MCP mount answers 503 without
//             touching the registry. A missing base URL is fatal because every
//             tool of that service throws "no base URL configured" at dispatch;
//             a missing issuer in a non-dev AUTH_MODE is fatal because the edge
//             would then accept a token from any issuer (see §auth below).
//   warning - the worker serves, with a named piece of the surface refusing in
//             a fail-closed way. The preview gate is the whole category: with
//             no secret or no KV store, dangerous tools refuse to run
//             (preview-gate.ts), which is safe. Taking the edge offline over it
//             would turn a partial outage into a total one.
//
// Why 503 for fatal and a 200 + `"status":"degraded"` body for warnings, rather
// than one or the other: a Cloudflare Health Check (and any uptime monitor)
// acts on the STATUS CODE out of the box and only matches the body when someone
// configures it to. So the case where the worker is not serving has to be a
// code, or the monitor stays green through a total outage; and the case where
// it IS serving must not be a code, or a monitor pages the on-call for a worker
// that answers every read tool. Both cases carry the same JSON body with a
// `status` field and the itemised `problems`, so a body-matching monitor can
// alert on `degraded` too, and whoever opens /health sees WHY without a deploy.

export type ConfigSeverity = 'fatal' | 'warning';

export interface ConfigProblem {
  /** The env var, binding or service the problem is about. */
  key: string;
  severity: ConfigSeverity;
  /** What is wrong, and what stops working because of it. */
  detail: string;
}

/**
 * The verified auth configuration. This union is the point of the file: in
 * `jwt` mode `issuer` and `resource` are non-optional strings, so a verifier
 * that skips the iss/aud checks because a var was missing is not a state the
 * code can reach. `makeVerifier` takes this, never the raw Env.
 */
export type AuthConfig =
  | { mode: 'dev'; devBearer: string | null; resource: string | null }
  | { mode: 'jwt'; issuer: string; resource: string };

/** The OAuth protected-resource document, or the reason it cannot be produced. */
export type DiscoveryConfig =
  | { status: 'ok'; resource: string; authorizationServers: string[] }
  | { status: 'unconfigured'; missing: string[] };

export interface ConfigReport {
  status: 'ok' | 'degraded' | 'fail';
  problems: ConfigProblem[];
  /**
   * null when a FATAL auth problem was found. `auth === null` therefore implies
   * `status === 'fail'`; the converse does not hold (a bad base URL is fatal
   * with the auth config intact).
   */
  auth: AuthConfig | null;
  discovery: DiscoveryConfig;
  previewGate: 'armed' | 'off';
  commitTokens: 'bound' | 'missing';
  /**
   * Whether the abuse controls are on, and which of the two enforcers is
   * actually counting. Without this on /health there is no way to tell a
   * deployment that is rate limited at the edge from one falling back to the
   * per-isolate counter, and the two are not the same guarantee.
   */
  rateLimit: {
    status: 'edge' | 'isolate_local' | 'off';
    callsPerWindow: number;
    writesPerWindow: number;
    windowSeconds: number;
  };
  maxBatchSize: number;
}

/** ENV_NAME values where AUTH_MODE=dev (bearer bypass, no issuer check) is allowed. */
const DEV_ENV_NAMES = new Set(['local', 'dev', 'development', 'test']);

export const BACKEND_TIMEOUT_DEFAULT_MS = 25000;
export const RESPONSE_CHAR_BUDGET_DEFAULT = 48000;
// Rate-limit defaults. The reasoning for each number is in env.ts, next to the
// read; the reasoning for the AXIS and the mechanism is in the middleware.
export const RATE_LIMIT_WINDOW_DEFAULT_S = 60;
export const RATE_LIMIT_CALLS_DEFAULT = 600;
export const RATE_LIMIT_WRITES_DEFAULT = 120;

/**
 * An unfilled deploy placeholder. wrangler.toml ships the production vars as
 * `https://TODO-linkedin-prod-url` and `TODO_kv_namespace_id`, and a value that
 * still says TODO is not a value: treating it as one is how a worker boots with
 * 250 tools that all fail at dispatch.
 */
const isPlaceholder = (value: string): boolean => /todo/i.test(value);

/**
 * Where each service's backend base URL comes from: the var name (for the error
 * message) and the read (for the value). ONE structure, so the health check and
 * the runtime config can never disagree about which var backs which service.
 *
 * `support` is null by design: its tools run in-worker (localHandler) and never
 * resolve a base URL. A service that grows an HTTP-dispatched tool without an
 * entry here is caught by the config check rather than at dispatch time.
 */
const BASE_URL_BINDINGS: Record<
  ServiceId,
  { varName: string; read: (env: Env) => string | undefined } | null
> = {
  linkedin: { varName: 'LINKEDIN_BASE_URL', read: (env) => env.LINKEDIN_BASE_URL },
  id: { varName: 'ID_BASE_URL', read: (env) => env.ID_BASE_URL },
  orchestration: { varName: 'ORCHESTRATION_BASE_URL', read: (env) => env.ORCHESTRATION_BASE_URL },
  support: null,
};

/** The base URL map the runtime dispatches on. Blank for anything unusable. */
export function baseUrlsOf(env: Env): Record<ServiceId, string> {
  const services = Object.keys(BASE_URL_BINDINGS) as ServiceId[];
  return Object.fromEntries(
    services.map((service) => [service, BASE_URL_BINDINGS[service]?.read(env)?.trim() ?? '']),
  ) as Record<ServiceId, string>;
}

/**
 * The preview-gate secret, or null when unset, blank or still a placeholder.
 * A placeholder must NOT arm the gate: signing commit tokens with the literal
 * `TODO...` is strictly worse than the gate's fail-closed refusal, because the
 * secret would then be public knowledge while the tools look protected.
 */
export function previewSecret(env: Env): string | null {
  const value = (env.PREVIEW_TOKEN_SECRET ?? '').trim();
  if (!value || isPlaceholder(value)) return null;
  return value;
}

/** A numeric knob, or null when it is set to something that is not a positive number. */
function positiveNumber(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

// Both fall back to the default on a value the config check has already flagged,
// so a worker that is serving is never running on a garbage number.
export const backendTimeoutMs = (env: Env): number =>
  positiveNumber(env.BACKEND_TIMEOUT_MS, BACKEND_TIMEOUT_DEFAULT_MS) ?? BACKEND_TIMEOUT_DEFAULT_MS;
export const responseCharBudget = (env: Env): number =>
  positiveNumber(env.RESPONSE_CHAR_BUDGET, RESPONSE_CHAR_BUDGET_DEFAULT) ?? RESPONSE_CHAR_BUDGET_DEFAULT;
export const maxBatchSize = (env: Env): number =>
  positiveNumber(env.MAX_BATCH_SIZE, DEFAULT_MAX_BATCH_SIZE) ?? DEFAULT_MAX_BATCH_SIZE;

/**
 * The rate-limit window, clamped to what the platform binding accepts. A
 * binding configured with `period = 60` cannot be told to use 45 at runtime, so
 * a var that says 45 would make the error message quote a window the enforcer
 * has never heard of. Anything that is not 10 falls back to 60, and the config
 * check below flags the value that was thrown away.
 */
export const rateLimitWindowSeconds = (env: Env): number =>
  Number(env.RATE_LIMIT_WINDOW_SECONDS) === 10 ? 10 : RATE_LIMIT_WINDOW_DEFAULT_S;

/**
 * A bucket ceiling. 0 is meaningful here (it switches one bucket off) so this
 * cannot reuse positiveNumber: only a negative or non-numeric value is bad.
 */
function bucketLimit(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

export function rateLimitOf(env: Env): RateLimitConfig {
  return {
    enabled: (env.RATE_LIMIT_ENABLED ?? '').trim() !== '0',
    windowSeconds: rateLimitWindowSeconds(env),
    callsPerWindow: bucketLimit(env.RATE_LIMIT_CALLS_PER_WINDOW, RATE_LIMIT_CALLS_DEFAULT) ?? RATE_LIMIT_CALLS_DEFAULT,
    writesPerWindow:
      bucketLimit(env.RATE_LIMIT_WRITES_PER_WINDOW, RATE_LIMIT_WRITES_DEFAULT) ?? RATE_LIMIT_WRITES_DEFAULT,
  };
}

/** Which buckets the platform binding enforces, for /health and the config check. */
export const rateLimitBindings = (env: Env): { calls: boolean; writes: boolean } => ({
  calls: typeof env.RATE_LIMIT_CALLS?.limit === 'function',
  writes: typeof env.RATE_LIMIT_WRITES?.limit === 'function',
});

type UrlVerdict = 'ok' | 'missing' | 'placeholder' | 'invalid';

const URL_VERDICT_REASON: Record<Exclude<UrlVerdict, 'ok'>, string> = {
  missing: 'is not set',
  placeholder: 'is still an unfilled deploy placeholder',
  invalid: 'is not an absolute http(s) URL',
};

function checkUrl(raw: string | undefined): UrlVerdict {
  const value = (raw ?? '').trim();
  if (!value) return 'missing';
  if (isPlaceholder(value)) return 'placeholder';
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return 'invalid';
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? 'ok' : 'invalid';
}

/**
 * Services whose tools reach a backend over HTTP, derived from the mounts the
 * worker actually resolved. Derived rather than listed, so adding a service to
 * mounts.config.ts without adding its base URL var is a red /health instead of
 * a runtime throw on the first call.
 */
export function requiredBaseUrlServices(mounts: readonly ResolvedMount[]): ServiceId[] {
  const services = new Set<ServiceId>();
  for (const mount of mounts) {
    for (const tool of mount.tools) {
      if (!tool.localHandler) services.add(tool.route.service);
    }
  }
  return [...services].sort();
}

export function inspectConfig(env: Env, requiredServices: readonly ServiceId[]): ConfigReport {
  const problems: ConfigProblem[] = [];

  // ── backend base URLs ─────────────────────────────────────────────────────
  for (const service of requiredServices) {
    const binding = BASE_URL_BINDINGS[service];
    if (!binding) {
      problems.push({
        key: `${service}.base_url`,
        severity: 'fatal',
        detail:
          `Service '${service}' has tools that dispatch over HTTP, but env.ts maps no base URL variable to it. ` +
          'Add one to Env and to BASE_URL_BINDINGS.',
      });
      continue;
    }
    const verdict = checkUrl(binding.read(env));
    if (verdict === 'ok') continue;
    problems.push({
      key: binding.varName,
      severity: 'fatal',
      detail:
        `${binding.varName} ${URL_VERDICT_REASON[verdict]}. ` +
        `Every '${service}' tool would fail at dispatch with "no base URL configured for service '${service}'".`,
    });
  }

  // ── auth ──────────────────────────────────────────────────────────────────
  //
  // The hole this closes, verbatim from the audit: with AUTH_MODE=jwt and no
  // AUTH_ISSUER / MCP_RESOURCE_URL, verifier.ts guarded the iss and aud checks
  // on truthiness, so both silently became no-ops and a token from any issuer
  // passed the edge. Refusing to serve is the only honest answer: an auth check
  // that disables itself when its config is missing is worse than no auth at
  // all, because the deploy looks armed.
  const mode = (env.AUTH_MODE ?? '').trim();
  const envName = (env.ENV_NAME ?? 'local').trim();
  const issuer = (env.AUTH_ISSUER ?? '').trim();
  const resource = (env.MCP_RESOURCE_URL ?? '').trim();
  const issuerVerdict = checkUrl(issuer);
  const resourceVerdict = checkUrl(resource);
  let auth: AuthConfig | null = null;

  if (mode === 'dev') {
    if (DEV_ENV_NAMES.has(envName)) {
      auth = { mode: 'dev', devBearer: (env.DEV_BEARER ?? '').trim() || null, resource: resource || null };
    } else {
      problems.push({
        key: 'AUTH_MODE',
        severity: 'fatal',
        detail:
          `AUTH_MODE=dev accepts the server-side DEV_BEARER in place of a client token and skips the issuer check, ` +
          `so it is refused with ENV_NAME='${envName}'. It is allowed only for ENV_NAME in ` +
          `${[...DEV_ENV_NAMES].join(', ')}. Deployed environments use AUTH_MODE=jwt.`,
      });
    }
  } else if (mode === 'jwt') {
    if (issuerVerdict !== 'ok') {
      problems.push({
        key: 'AUTH_ISSUER',
        severity: 'fatal',
        detail:
          `AUTH_ISSUER ${URL_VERDICT_REASON[issuerVerdict]}, and AUTH_MODE=jwt. The worker refuses to serve rather ` +
          'than run with the iss check disabled, which would let a token from any issuer through the edge.',
      });
    }
    if (resourceVerdict !== 'ok') {
      problems.push({
        key: 'MCP_RESOURCE_URL',
        severity: 'fatal',
        detail:
          `MCP_RESOURCE_URL ${URL_VERDICT_REASON[resourceVerdict]}, and AUTH_MODE=jwt. The worker refuses to serve ` +
          'rather than run with the aud check disabled, and the OAuth discovery document has no resource to name.',
      });
    }
    if (issuerVerdict === 'ok' && resourceVerdict === 'ok') {
      auth = { mode: 'jwt', issuer, resource };
    }
  } else {
    problems.push({
      key: 'AUTH_MODE',
      severity: 'fatal',
      detail:
        `AUTH_MODE is ${mode ? `'${mode}'` : 'unset'}; it must be 'jwt' (deployed) or 'dev' (local only). ` +
        'Anything else used to mean "not dev", so a typo silently selected the mode whose checks it also failed to configure.',
    });
  }

  // ── OAuth discovery ───────────────────────────────────────────────────────
  //
  // Same rule as /health, for the same reason: answering
  // {resource: undefined, authorization_servers: []} with a 200 is a document
  // no MCP client can bootstrap from, and it reads as "this server has no OAuth"
  // rather than "this server is misconfigured".
  const missingDiscovery: string[] = [];
  if (resourceVerdict !== 'ok') missingDiscovery.push('MCP_RESOURCE_URL');
  if (issuerVerdict !== 'ok') missingDiscovery.push('AUTH_ISSUER');
  const discovery: DiscoveryConfig = missingDiscovery.length
    ? { status: 'unconfigured', missing: missingDiscovery }
    : { status: 'ok', resource, authorizationServers: [issuer] };
  // In jwt mode the same two vars are already fatal above. In dev they are not
  // fatal (the local connector never runs the OAuth flow), but the discovery
  // endpoint still has nothing to serve, so say so once.
  if (discovery.status === 'unconfigured' && mode === 'dev') {
    problems.push({
      key: 'MCP_RESOURCE_URL',
      severity: 'warning',
      detail:
        `OAuth discovery is unavailable (${missingDiscovery.join(', ')} unset or unusable): ` +
        '/.well-known/oauth-protected-resource answers 503, so an MCP client cannot bootstrap OAuth against this worker.',
    });
  }

  // ── preview gate (fail-closed, so both halves are warnings) ───────────────
  const previewGate: 'armed' | 'off' = previewSecret(env) ? 'armed' : 'off';
  if (previewGate === 'off') {
    problems.push({
      key: 'PREVIEW_TOKEN_SECRET',
      severity: 'warning',
      detail:
        'PREVIEW_TOKEN_SECRET is unset, blank or a placeholder, so the preview gate is off and every dangerous tool ' +
        'refuses to execute (fail-closed). Read tools are unaffected.',
    });
  }
  const commitTokens: 'bound' | 'missing' =
    typeof env.COMMIT_TOKENS?.get === 'function' && typeof env.COMMIT_TOKENS?.put === 'function'
      ? 'bound'
      : 'missing';
  if (commitTokens === 'missing') {
    problems.push({
      key: 'COMMIT_TOKENS',
      severity: 'warning',
      detail:
        'The COMMIT_TOKENS KV binding does not resolve, so a commit token cannot be recorded as used and every ' +
        'dangerous tool refuses at the confirm step (fail-closed). Check the kv_namespaces id for this env.',
    });
  }

  // ── numeric knobs ─────────────────────────────────────────────────────────
  if (positiveNumber(env.BACKEND_TIMEOUT_MS, BACKEND_TIMEOUT_DEFAULT_MS) === null) {
    problems.push({
      key: 'BACKEND_TIMEOUT_MS',
      severity: 'fatal',
      detail:
        `BACKEND_TIMEOUT_MS='${env.BACKEND_TIMEOUT_MS}' is not a positive number. It is passed straight to ` +
        'setTimeout(), which coerces it to 0 and aborts every backend call before it leaves the edge.',
    });
  }
  if (positiveNumber(env.RESPONSE_CHAR_BUDGET, RESPONSE_CHAR_BUDGET_DEFAULT) === null) {
    problems.push({
      key: 'RESPONSE_CHAR_BUDGET',
      severity: 'warning',
      detail:
        `RESPONSE_CHAR_BUDGET='${env.RESPONSE_CHAR_BUDGET}' is not a positive number, so the response budget falls ` +
        `back to ${RESPONSE_CHAR_BUDGET_DEFAULT} instead of the value someone meant to set.`,
    });
  }
  if (positiveNumber(env.MAX_BATCH_SIZE, DEFAULT_MAX_BATCH_SIZE) === null) {
    problems.push({
      key: 'MAX_BATCH_SIZE',
      severity: 'warning',
      detail:
        `MAX_BATCH_SIZE='${env.MAX_BATCH_SIZE}' is not a positive number, so the JSON-RPC batch cap falls back to ` +
        `${DEFAULT_MAX_BATCH_SIZE}. A batch is one backend call per element, so an unfilled cap is a fan-out.`,
    });
  }

  // ── abuse controls ────────────────────────────────────────────────────────
  const rateLimitConfig = rateLimitOf(env);
  const bindings = rateLimitBindings(env);
  if (
    env.RATE_LIMIT_WINDOW_SECONDS !== undefined &&
    env.RATE_LIMIT_WINDOW_SECONDS.trim() !== '' &&
    Number(env.RATE_LIMIT_WINDOW_SECONDS) !== rateLimitConfig.windowSeconds
  ) {
    problems.push({
      key: 'RATE_LIMIT_WINDOW_SECONDS',
      severity: 'warning',
      detail:
        `RATE_LIMIT_WINDOW_SECONDS='${env.RATE_LIMIT_WINDOW_SECONDS}' is not one of the two periods the platform ` +
        `rate-limit binding accepts (10 or 60), so the window is ${rateLimitConfig.windowSeconds}s.`,
    });
  }
  for (const [key, raw, fallback] of [
    ['RATE_LIMIT_CALLS_PER_WINDOW', env.RATE_LIMIT_CALLS_PER_WINDOW, RATE_LIMIT_CALLS_DEFAULT],
    ['RATE_LIMIT_WRITES_PER_WINDOW', env.RATE_LIMIT_WRITES_PER_WINDOW, RATE_LIMIT_WRITES_DEFAULT],
  ] as const) {
    if (bucketLimit(raw, fallback) === null) {
      problems.push({
        key,
        severity: 'warning',
        detail: `${key}='${raw}' is not a number >= 0, so that bucket falls back to ${fallback} per window.`,
      });
    }
  }
  let rateLimitStatus: ConfigReport['rateLimit']['status'];
  if (!rateLimitConfig.enabled) {
    rateLimitStatus = 'off';
    problems.push({
      key: 'RATE_LIMIT_ENABLED',
      severity: 'warning',
      detail:
        'RATE_LIMIT_ENABLED=0, so every tool call passes ungated. One caller can then fan out into the backends ' +
        'as fast as the edge will carry it.',
    });
  } else if (bindings.calls && bindings.writes) {
    rateLimitStatus = 'edge';
  } else {
    rateLimitStatus = 'isolate_local';
    problems.push({
      key: 'RATE_LIMIT_CALLS',
      severity: 'warning',
      detail:
        'The platform rate-limit bindings ([[ratelimits]]) do not both resolve, so the gate is counting in the ' +
        'isolate. That still stops a retry loop from one client, but it is per isolate, not per account: a ' +
        'distributed caller is not capped. Expected under `wrangler dev`; on a deployed env it means the bindings ' +
        'are missing from wrangler.toml for this environment.',
    });
  }

  const fatal = problems.some((problem) => problem.severity === 'fatal');
  return {
    status: fatal ? 'fail' : problems.length ? 'degraded' : 'ok',
    problems,
    auth,
    discovery,
    previewGate,
    commitTokens,
    rateLimit: {
      status: rateLimitStatus,
      callsPerWindow: rateLimitConfig.callsPerWindow,
      writesPerWindow: rateLimitConfig.writesPerWindow,
      windowSeconds: rateLimitConfig.windowSeconds,
    },
    maxBatchSize: maxBatchSize(env),
  };
}

/** The fatal subset, for the refusal bodies. */
export const fatalProblems = (report: ConfigReport): ConfigProblem[] =>
  report.problems.filter((problem) => problem.severity === 'fatal');
