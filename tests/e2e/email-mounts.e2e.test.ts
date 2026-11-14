import { describe, it, expect, beforeAll } from 'vitest';
import { mountToolCount, mountToolNames } from './registry';
import { EMAIL_MOUNTS, searchArgsOf } from './smoke-mounts';
import { mintDevToken } from './token';

// Live smoke for the email-service mounts. Opt-in (RUN_E2E=1). The dev jwt:fake
// token is platform-wide (id is the issuer; shared HS256 secret) and carries
// wildcard permissions, so it authorizes email reads too. Side-effect-free:
// mount loads, tool counts, and a read search per mount, each a read of the
// email server's own store (no mailbox provider is dialled).

const RUN = process.env.RUN_E2E === '1';
const BASE = process.env.MCP_URL ?? 'http://localhost:8788';

let token = '';
async function rpc(path: string, method: string, params?: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return res.json();
}

beforeAll(() => {
  if (!RUN) return;
  token = mintDevToken();
});

const suite = RUN ? describe : describe.skip;

// The mount table lives in ./smoke-mounts; tool counts come from the resolved
// mount (see ./registry), never from a number typed here. This suite only runs
// under RUN_E2E=1, so a hand-kept copy of a registry fact goes stale between
// live runs and nobody sees it.

suite('e2e email-service mounts (live worker + email backend)', () => {
  for (const m of EMAIL_MOUNTS) {
    it(`${m.path}: initialize + tools/list (${mountToolCount(m.path)})`, async () => {
      const init = await rpc(m.path, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
      expect(init.result.serverInfo.name).toBe(m.name);
      const list = await rpc(m.path, 'tools/list');
      const names = list.result.tools.map((t: { name: string }) => t.name).sort();
      expect(names).toEqual(mountToolNames(m.path));
    });

    // Every email mount has a read tool today; the guard is what keeps this
    // file honest if one ever does not.
    if (m.search) {
      it(`${m.path}: ${m.search} dispatches to the live email backend`, async () => {
        const r = await rpc(m.path, 'tools/call', { name: m.search, arguments: { ...searchArgsOf(m), _meta: { user_goal: 'email smoke' } } });
        expect(r.result).toBeDefined();
        expect(Array.isArray(r.result.content)).toBe(true);
        const sc = r.result.structuredContent;
        expect(sc?.operation === 'search' || r.result.isError === true).toBe(true);
      });
    }
  }
});
