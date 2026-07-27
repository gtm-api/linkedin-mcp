import { describe, it, expect, beforeAll } from 'vitest';
import { McpErrorResponse } from '@gtm/mcp-shared';
import { mountToolCount, mountToolNames } from './registry';
import { WAVE1_MOUNTS, searchArgsOf, stubArgsOf } from './smoke-mounts';
import { mintDevToken } from './token';

// Live smoke for the wave-1 domain mounts (messaging / network / scraping /
// enrichment). Opt-in (RUN_E2E=1), needs a running worker + backend.
// Deterministic + side-effect-free: mount loads (initialize), tool counts
// (tools/list), a read search where safe, and a stub call (answered in-worker,
// before any credit / plugin / backend work). GA scraping/enrichment pulls are
// NOT called: they debit credits and need the node automation.

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

// The mount table lives in ./smoke-mounts, shared with the other live suites and
// checked against the resolved mounts at collection time. Tool counts are NOT
// written here either: they come from the resolved mount (see ./registry). Both
// are registry facts, and a copy of a registry fact in a file that only runs
// under RUN_E2E=1 rots unseen.

suite('e2e wave-1 domain mounts (live worker + backend)', () => {
  for (const m of WAVE1_MOUNTS) {
    it(`${m.path}: initialize + tools/list (${mountToolCount(m.path)})`, async () => {
      const init = await rpc(m.path, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
      expect(init.result.serverInfo.name).toBe(m.name);
      const list = await rpc(m.path, 'tools/list');
      // Names, not just the total: the running worker must serve exactly what
      // this build resolves for the mount, so a swap that keeps the count fails too.
      const names = list.result.tools.map((t: { name: string }) => t.name).sort();
      expect(names).toEqual(mountToolNames(m.path));
    });

    if (m.search) {
      it(`${m.path}: ${m.search} dispatches to the live backend`, async () => {
        const r = await rpc(m.path, 'tools/call', { name: m.search, arguments: { ...searchArgsOf(m), _meta: { user_goal: 'wave1 smoke' } } });
        // Either a valid search envelope, or a cleanly-mapped backend error
        // (e.g. a required account filter): both prove end-to-end dispatch.
        expect(r.result).toBeDefined();
        expect(Array.isArray(r.result.content)).toBe(true);
        const sc = r.result.structuredContent;
        expect(sc?.operation === 'search' || r.result.isError === true).toBe(true);
      });
    }

    if (m.stub) {
      it(`${m.path}: ${m.stub} short-circuits in the worker`, async () => {
        const r = await rpc(m.path, 'tools/call', { name: m.stub, arguments: { ...stubArgsOf(m), _meta: { user_goal: 'wave1 stub check' } } });
        expect(r.result.isError).toBe(true);
        // The arguments are VALID (stubOnMount checks them against the tool's
        // own schema at collection), so this reaches the stub gate rather than
        // dying in input validation. The gate is the first middleware in the
        // chain, so `source: 'mcp_runtime'` is the proof that nothing was sent
        // to the backend: no credit debit, no plugin work, no round trip.
        const parsed = McpErrorResponse.parse(r.result.structuredContent);
        expect(parsed.error.code).toBe('not_implemented');
        expect(parsed.error.context?.['source']).toBe('mcp_runtime');
      });
    }
  }
});
