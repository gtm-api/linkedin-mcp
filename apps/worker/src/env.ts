import type { RuntimeConfig, ServiceId } from '@gtm/mcp-runtime';

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
  /** KV namespace for single-use commit tokens. */
  COMMIT_TOKENS?: KVNamespace;
  /** Workers AI binding - query-time embeddings for the support KB (prod env only). */
  AI?: Ai;
  /** Vectorize index with the embedded support KB (prod env only). */
  VECTORIZE_KB?: VectorizeIndex;
}

export function buildRuntimeConfig(env: Env): RuntimeConfig {
  // 'support' is absent by design: its tools run in-worker (localHandler) and
  // never resolve a base URL, so the cast covers it.
  const baseUrls = {
    linkedin: env.LINKEDIN_BASE_URL,
    id: env.ID_BASE_URL,
    orchestration: env.ORCHESTRATION_BASE_URL,
  } as Record<ServiceId, string>;

  return {
    envName: env.ENV_NAME ?? 'local',
    version: '0.0.0',
    baseUrls,
    backendTimeoutMs: Number(env.BACKEND_TIMEOUT_MS ?? '25000'),
    responseCharBudget: Number(env.RESPONSE_CHAR_BUDGET ?? '48000'),
    previewGate: {
      enabled: !!env.PREVIEW_TOKEN_SECRET,
      secret: env.PREVIEW_TOKEN_SECRET ?? null,
      ttlSeconds: 300,
    },
  };
}
