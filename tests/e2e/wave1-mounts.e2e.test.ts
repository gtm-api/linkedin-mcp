import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { McpErrorResponse } from '@gtm/mcp-shared';
import { mountToolCount, mountToolNames } from './registry';

// Live smoke for the wave-1 domain mounts (messaging / network / scraping /
// enrichment). Opt-in (RUN_E2E=1), needs a running worker + backend.
// Deterministic + side-effect-free: mount loads (initialize), tool counts
// (tools/list), a read search where safe, and a stub_501 call (returns
// not_implemented BEFORE any credit/plugin work). GA scraping/enrichment pulls
// are NOT called (they debit credits / need the node automation).

const RUN = process.env.RUN_E2E === '1';
const BASE = process.env.MCP_URL ?? 'http://localhost:8788';
const LINKEDIN_DIR = process.env.LINKEDIN_DIR ?? '/Users/eugene/sites/gtm.ai/product/backend/gtm.service.linkedin';
const TEAM = process.env.E2E_TEAM_SID ?? 'ts_tm_seeddev00001';

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
  try {
    const out = execSync(`./dev artisan jwt:fake --team-sid=${TEAM} --ttl=3600`, { cwd: LINKEDIN_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/eyJ[A-Za-z0-9_.-]{40,}/g);
    token = m ? m[m.length - 1] : '';
  } catch { token = ''; }
});

const suite = RUN ? describe : describe.skip;

// Tool counts are NOT written here: they come from the resolved mount (see
// ./registry). The count each mount serves is the registry's fact, and a copy of
// it in this file only rots, because this suite is skipped unless RUN_E2E=1.
const MOUNTS = [
  { path: '/mcp/linkedin/messaging', name: 'gtm-linkedin-messaging', search: 'search_linkedin_conversations' },
  { path: '/mcp/linkedin/network', name: 'gtm-linkedin-network', search: 'search_linkedin_connections' },
  { path: '/mcp/linkedin/scraping', name: 'gtm-linkedin-scraping', stub: 'scrape_linkedin_similar_profiles' },
  { path: '/mcp/linkedin/enrichment', name: 'gtm-linkedin-enrichment', stub: 'enrich_linkedin_person_contact_info' },
];

suite('e2e wave-1 domain mounts (live worker + backend)', () => {
  for (const m of MOUNTS) {
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
        const r = await rpc(m.path, 'tools/call', { name: m.search, arguments: { page_size: 3, _meta: { user_goal: 'wave1 smoke' } } });
        // Either a valid search envelope, or a cleanly-mapped backend error
        // (e.g. a required account filter): both prove end-to-end dispatch.
        expect(r.result).toBeDefined();
        expect(Array.isArray(r.result.content)).toBe(true);
        const sc = r.result.structuredContent;
        expect(sc?.operation === 'search' || r.result.isError === true).toBe(true);
      });
    }

    if (m.stub) {
      it(`${m.path}: ${m.stub} is gated & side-effect-free (no credits)`, async () => {
        const r = await rpc(m.path, 'tools/call', { name: m.stub, arguments: { _meta: { user_goal: 'wave1 stub check' } } });
        expect(r.result.isError).toBe(true);
        // Called with minimal args, so the tool short-circuits BEFORE any work /
        // credit debit: either the § 5.9 not_implemented stub guard fires, or
        // the backend/SDK rejects the missing required args (validation_failed).
        // All three prove the tool is reachable and non-executing.
        const sc = r.result.structuredContent;
        if (sc) expect(['not_implemented', 'validation_failed']).toContain(McpErrorResponse.parse(sc).error.code);
        else expect(r.result.content[0].text).toMatch(/validation|Invalid|required/i);
      });
    }
  }
});
