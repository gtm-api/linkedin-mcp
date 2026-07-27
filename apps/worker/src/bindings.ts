import type { CommitTokenStore } from '@gtm/mcp-runtime';

// Adapt a Workers KV namespace to the runtime's CommitTokenStore interface.
export function kvCommitTokenStore(kv: KVNamespace): CommitTokenStore {
  return {
    get: (jti) => kv.get(jti),
    put: (jti, value, ttlSeconds) => kv.put(jti, value, { expirationTtl: ttlSeconds }),
  };
}
