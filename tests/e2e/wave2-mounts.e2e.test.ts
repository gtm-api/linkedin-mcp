import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { McpErrorResponse } from '@gtm/mcp-shared';
import { mountToolCount, mountToolNames } from './registry';

// Live smoke for the wave-2 domain mounts (account-monitor / content / browsers
// / data / platform). Opt-in (RUN_E2E=1). Deterministic + side-effect-free:
// mount loads, tool counts, a read search, and (content) a stub_501 call.

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

// content carries no read tool: it is the stateless authoring surface (post /
// comment / react), so it is smoke-checked through its stub_501 alone.
// Tool counts come from the resolved mount (see ./registry) rather than a number
// typed here, for the reason the whole phase exists: this suite is skipped unless
// RUN_E2E=1, so a hand-kept copy of a registry fact rots between live runs.
const MOUNTS: { path: string; name: string; search?: string; stub?: string }[] = [
  { path: '/mcp/linkedin/account-monitor', name: 'gtm-linkedin-account-monitor', search: 'search_linkedin_account_snapshots' },
  { path: '/mcp/linkedin/content', name: 'gtm-linkedin-content', stub: 'create_linkedin_post' },
  { path: '/mcp/linkedin/browsers', name: 'gtm-linkedin-browsers', search: 'search_antidetect_browsers' },
  { path: '/mcp/linkedin/data', name: 'gtm-linkedin-data', search: 'search_data_requests' },
  // platform is down to the single custom-request escape hatch (dangerous, so
  // no read smoke here); the webhook surface moved to gtm.service.orchestration
  // and is smoke-checked on its own mount below.
  { path: '/mcp/linkedin/platform', name: 'gtm-linkedin-platform' },
  { path: '/mcp/orchestration/webhooks', name: 'gtm-orchestration-webhooks', search: 'search_webhooks' },
  // The mass-action plane: the parent tools and the item tools on one mount. The
  // read smoke goes through the parent search, since that is the entry point an
  // agent uses before it drills into items.
  { path: '/mcp/orchestration/mass-actions', name: 'gtm-orchestration-mass-actions', search: 'search_mass_actions' },
];

suite('e2e wave-2 domain mounts (live worker + backend)', () => {
  for (const m of MOUNTS) {
    it(`${m.path}: initialize + tools/list (${mountToolCount(m.path)})`, async () => {
      const init = await rpc(m.path, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
      expect(init.result.serverInfo.name).toBe(m.name);
      const list = await rpc(m.path, 'tools/list');
      const names = list.result.tools.map((t: { name: string }) => t.name).sort();
      expect(names).toEqual(mountToolNames(m.path));
    });

    if (m.search) {
      it(`${m.path}: ${m.search} dispatches to the live backend`, async () => {
        const r = await rpc(m.path, 'tools/call', { name: m.search, arguments: { page_size: 3, _meta: { user_goal: 'wave2 smoke' } } });
        expect(r.result).toBeDefined();
        expect(Array.isArray(r.result.content)).toBe(true);
        const sc = r.result.structuredContent;
        expect(sc?.operation === 'search' || r.result.isError === true).toBe(true);
      });
    }

    if (m.stub) {
      it(`${m.path}: ${m.stub} is gated & side-effect-free`, async () => {
        const r = await rpc(m.path, 'tools/call', { name: m.stub, arguments: { _meta: { user_goal: 'wave2 stub check' } } });
        expect(r.result.isError).toBe(true);
        const sc = r.result.structuredContent;
        if (sc) expect(['not_implemented', 'validation_failed']).toContain(McpErrorResponse.parse(sc).error.code);
        else expect(r.result.content[0].text).toMatch(/validation|Invalid|required/i);
      });
    }
  }
});
