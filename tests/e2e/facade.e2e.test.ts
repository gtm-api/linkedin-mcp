import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { DOMAIN_TOOLSETS, enumArg, mountToolNames, toolsetIdFor } from './registry';

const MESSAGING = '/mcp/linkedin/messaging';
const MESSAGING_TOOLSET = toolsetIdFor(MESSAGING);
// Checked against the tool's live enum at collection time, so this suite can
// never go back to sending a value reset_linkedin_account_sync stopped taking.
const RESET_SYNC_TYPE = enumArg('reset_linkedin_account_sync', 'types', 'conversations');

// Live smoke for the unified facade endpoint /mcp (list_toolsets /
// get_toolset_tools / call_tool over the whole registry). Opt-in (RUN_E2E=1).

const RUN = process.env.RUN_E2E === '1';
const URL = `${process.env.MCP_URL ?? 'http://localhost:8788'}/mcp`;
const LINKEDIN_DIR = process.env.LINKEDIN_DIR ?? '/Users/eugene/sites/gtm.ai/product/backend/gtm.service.linkedin';
const TEAM = process.env.E2E_TEAM_SID ?? 'ts_tm_seeddev00001';

let token = '';
async function rpc(method: string, params?: unknown): Promise<any> {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return res.json();
}
const call = (name: string, args: Record<string, unknown> = {}) => rpc('tools/call', { name, arguments: args });

beforeAll(() => {
  if (!RUN) return;
  try {
    const out = execSync(`./dev artisan jwt:fake --team-sid=${TEAM} --ttl=3600`, { cwd: LINKEDIN_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/eyJ[A-Za-z0-9_.-]{40,}/g);
    token = m ? m[m.length - 1] : '';
  } catch { token = ''; }
});

const suite = RUN ? describe : describe.skip;

suite('e2e facade /mcp (live worker + backend)', () => {
  // A FIXED expectation, deliberately hard-coded: "3 meta-tools" is the facade's
  // contract, not a registry count. The whole point of this endpoint is that the
  // tool list stays constant no matter how many tools the registry grows, so a
  // fourth name appearing here is a product change and has to fail the test.
  it('exposes exactly the 3 meta-tools', async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
    expect(init.result.serverInfo.name).toBe('gtm-mcp');
    const list = await rpc('tools/list');
    const names = list.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(['call_tool', 'get_toolset_tools', 'list_toolsets']);
  });

  // Derived: the catalog is index.ts's DOMAIN_MOUNTS, so assert the ids AND each
  // advertised tool_count against the resolved mounts instead of a magic total.
  it(`list_toolsets returns the ${DOMAIN_TOOLSETS.length} domain toolsets`, async () => {
    const r = await call('list_toolsets');
    const toolsets: { toolset: string; tool_count: number }[] = r.result.structuredContent.toolsets;
    expect(toolsets.map((t) => t.toolset).sort()).toEqual(DOMAIN_TOOLSETS.map((t) => t.toolset).sort());
    const counts = Object.fromEntries(toolsets.map((t) => [t.toolset, t.tool_count]));
    expect(counts).toEqual(Object.fromEntries(DOMAIN_TOOLSETS.map((t) => [t.toolset, t.toolCount])));
  });

  it(`get_toolset_tools lists a toolset's tools (${MESSAGING_TOOLSET})`, async () => {
    const r = await call('get_toolset_tools', { toolset: MESSAGING_TOOLSET });
    const names = r.result.structuredContent.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(mountToolNames(MESSAGING));
  });

  it('call_tool runs a read tool through the same pipeline', async () => {
    const r = await call('call_tool', { name: 'search_linkedin_accounts', arguments: { page_size: 3 } });
    const sc = r.result.structuredContent;
    expect(sc?.operation === 'search' || r.result.isError === true).toBe(true);
  });

  it('call_tool honors the preview gate for dangerous tools', async () => {
    const r = await call('call_tool', { name: 'reset_linkedin_account_sync', arguments: { sid: 'ln_ac_000000000000', types: [RESET_SYNC_TYPE] } });
    expect(r.result.isError).toBeUndefined();
    expect(r.result.structuredContent.preview).toBe(true);
    expect(typeof r.result.structuredContent.commit_token).toBe('string');
    // The gate MINTED a token rather than echoing a shape: an unexpired TTL is
    // what separates a real preview from a validation error that happens to
    // carry the field.
    expect(r.result.structuredContent.expires_in_seconds).toBeGreaterThan(0);
  });

  it('call_tool rejects an unknown tool', async () => {
    const r = await call('call_tool', { name: 'no_such_tool', arguments: {} });
    expect(r.result.isError).toBe(true);
  });
});
