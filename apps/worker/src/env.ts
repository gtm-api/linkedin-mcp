import type { RuntimeConfig } from '@gtm/mcp-runtime';
import {
  backendTimeoutMs,
  baseUrlsOf,
  maxBatchSize,
  previewSecret,
  rateLimitOf,
  responseCharBudget,
} from './config';

export interface Env {
  ENV_NAME?: string;
  LINKEDIN_BASE_URL: string;
  ID_BASE_URL: string;
  /** gtm.service.orchestration - webhooks, webhook delivery log, mass actions. */
  ORCHESTRATION_BASE_URL: string;
  AUTH_ISSUER?: string;
  MCP_RESOURCE_URL?: string;
  AUTH_MODE?: string;
  /** Dev-only fallback bearer (minted by bin/mcp-dev.sh) so the local connector
   *  needs no Authorization header. Ignored unless AUTH_MODE=dev. */
  DEV_BEARER?: string;
  /** HMAC secret for the preview gate. When absent, dangerous tools refuse. */
  PREVIEW_TOKEN_SECRET?: string;
  BACKEND_TIMEOUT_MS?: string;
  RESPONSE_CHAR_BUDGET?: string;
  /** Max JSON-RPC messages per POST. See middleware/batch-cap.ts for the 16. */
  MAX_BATCH_SIZE?: string;
  /** '0' turns the rate-limit gate off entirely. Anything else leaves it armed. */
  RATE_LIMIT_ENABLED?: string;
  /** 10 or 60: the only periods the platform binding accepts. */
  RATE_LIMIT_WINDOW_SECONDS?: string;
  RATE_LIMIT_CALLS_PER_WINDOW?: string;
  RATE_LIMIT_WRITES_PER_WINDOW?: string;
  /**
   * Cloudflare rate-limit bindings ([[ratelimits]]). Present in production
   * only: their absence under `wrangler dev` is
   * what keeps local dev fully offline, and the gate falls back to an
   * isolate-local counter that says so in the error it returns.
   */
  RATE_LIMIT_CALLS?: RateLimit;
  RATE_LIMIT_WRITES?: RateLimit;
  /** KV namespace for single-use commit tokens. */
  COMMIT_TOKENS?: KVNamespace;
  /**
   * Mintlify assistant API key (secret). The ONLY retrieval backend of the two
   * KB tools; when it is absent or the API is down they error clearly instead
   * of serving a stale local index (decision 2026-08-14, no silent fallback).
   */
  MINTLIFY_ASSISTANT_KEY?: string;
  /** Docs domain the discovery index serves; defaults to docs.gtm-api.com. */
  MINTLIFY_DOCS_DOMAIN?: string;
}

// Every value below is read through config.ts, which is also what /health
// reports on: a var that is missing, blank or still a TODO placeholder must not
// reach the runtime as if it were configured. config.ts imports nothing from
// here but the `Env` type, so the pair is a type-only cycle at most.
export function buildRuntimeConfig(env: Env): RuntimeConfig {
  const secret = previewSecret(env);

  return {
    envName: env.ENV_NAME ?? 'local',
    version: '0.0.0',
    baseUrls: baseUrlsOf(env),
    backendTimeoutMs: backendTimeoutMs(env),
    responseCharBudget: responseCharBudget(env),
    maxBatchSize: maxBatchSize(env),
    // The numbers, and why they are these numbers. 600 calls a minute is 10 a
    // second sustained for one tenant: a real agent working a fan-out research
    // task runs 5 to 20 a minute, so this is thirty times the working rate and
    // no honest caller will ever see it, while a retry loop with no backoff
    // runs thousands a minute and trips in about six seconds. The write bucket
    // is a fifth of that, because a write spends credits or touches a LinkedIn
    // account, and neither is undone by noticing the storm afterwards.
    rateLimit: rateLimitOf(env),
    previewGate: {
      enabled: secret !== null,
      secret,
      ttlSeconds: 300,
    },
  };
}
