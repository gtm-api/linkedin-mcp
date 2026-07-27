import { describe, it, expect, beforeAll } from 'vitest';
import { McpErrorResponse } from '@gtm/mcp-shared';
import { mountToolCount, mountToolNames } from './registry';
import { WAVE2_MOUNTS, searchArgsOf, stubArgsOf } from './smoke-mounts';
import { mintDevToken } from './token';

// Live smoke for the wave-2 domain mounts (account-monitor / content /
// auto-scrapes / browsers / data / platform / orchestration / support-kb).
// Opt-in (RUN_E2E=1). Deterministic + side-effect-free: mount loads, tool
// counts, a read search, and (content) a stub call.

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

// The mount table lives in ./smoke-mounts (shared, and checked against the
// resolved mounts as it loads); tool counts come from the resolved mount (see
// ./registry) rather than a number typed here, for the reason the whole phase
// exists: these suites are skipped unless RUN_E2E=1, so a hand-kept copy of a
// registry fact rots between live runs.

suite('e2e wave-2 domain mounts (live worker + backend)', () => {
  for (const m of WAVE2_MOUNTS) {
    it(`${m.path}: initialize + tools/list (${mountToolCount(m.path)})`, async () => {
      const init = await rpc(m.path, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
      expect(init.result.serverInfo.name).toBe(m.name);
      const list = await rpc(m.path, 'tools/list');
      const names = list.result.tools.map((t: { name: string }) => t.name).sort();
      expect(names).toEqual(mountToolNames(m.path));
    });

    if (m.search) {
      it(`${m.path}: ${m.search} dispatches to the live backend`, async () => {
        const r = await rpc(m.path, 'tools/call', { name: m.search, arguments: { ...searchArgsOf(m), _meta: { user_goal: 'wave2 smoke' } } });
        expect(r.result).toBeDefined();
        expect(Array.isArray(r.result.content)).toBe(true);
        const sc = r.result.structuredContent;
        expect(sc?.operation === 'search' || r.result.isError === true).toBe(true);
      });
    }

    if (m.stub) {
      it(`${m.path}: ${m.stub} short-circuits before the preview gate`, async () => {
        const r = await rpc(m.path, 'tools/call', { name: m.stub, arguments: { ...stubArgsOf(m), _meta: { user_goal: 'wave2 stub check' } } });
        expect(r.result.isError).toBe(true);
        const parsed = McpErrorResponse.parse(r.result.structuredContent);
        expect(parsed.error.code).toBe('not_implemented');
        // create_linkedin_post is `dangerous`, so without the stub gate this
        // call would come back as a PREVIEW with a minted commit token and a KV
        // write behind it. `source: 'mcp_runtime'` plus the absence of a
        // preview is what says the gate ran first.
        expect(parsed.error.context?.['source']).toBe('mcp_runtime');
        expect(r.result.structuredContent.preview).toBeUndefined();
      });
    }
  }
});
