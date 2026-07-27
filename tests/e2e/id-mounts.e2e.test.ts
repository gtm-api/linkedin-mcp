import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mountToolCount, mountToolNames } from './registry';

// Live smoke for the id-service mounts. Opt-in (RUN_E2E=1). The dev jwt:fake
// token is platform-wide (id is the issuer; shared HS256 secret) and carries
// wildcard permissions, so it authorizes id reads too. Side-effect-free:
// mount loads, tool counts, and a read search per mount.

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

// Tool counts come from the resolved mount (see ./registry), never from a number
// typed here: this suite only runs under RUN_E2E=1, so a hand-kept copy of a
// registry fact goes stale between live runs and nobody sees it.
const MOUNTS = [
  { path: '/mcp/id/identity', name: 'gtm-id-identity', search: 'search_teams' },
  { path: '/mcp/id/access', name: 'gtm-id-access', search: 'search_api_keys' },
  { path: '/mcp/id/billing', name: 'gtm-id-billing', search: 'search_billing_products' },
  { path: '/mcp/id/credits', name: 'gtm-id-credits', search: 'search_credit_transactions' },
  { path: '/mcp/id/platform', name: 'gtm-id-platform', search: 'search_notifications' },
];

suite('e2e id-service mounts (live worker + id backend)', () => {
  for (const m of MOUNTS) {
    it(`${m.path}: initialize + tools/list (${mountToolCount(m.path)})`, async () => {
      const init = await rpc(m.path, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
      expect(init.result.serverInfo.name).toBe(m.name);
      const list = await rpc(m.path, 'tools/list');
      const names = list.result.tools.map((t: { name: string }) => t.name).sort();
      expect(names).toEqual(mountToolNames(m.path));
    });

    it(`${m.path}: ${m.search} dispatches to the live id backend`, async () => {
      const r = await rpc(m.path, 'tools/call', { name: m.search, arguments: { page_size: 3, _meta: { user_goal: 'id smoke' } } });
      expect(r.result).toBeDefined();
      expect(Array.isArray(r.result.content)).toBe(true);
      const sc = r.result.structuredContent;
      expect(sc?.operation === 'search' || r.result.isError === true).toBe(true);
    });
  }
});
