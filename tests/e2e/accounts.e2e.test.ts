import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { linkedinPackages } from '@gtm/mcp-linkedin';
import { McpErrorResponse } from '@gtm/mcp-shared';
import { enumArg, mountToolCount, mountToolNames } from './registry';

// Live e2e: drives the RUNNING worker over HTTP against the live local backend,
// and Zod-parses the envelopes against each tool's outputSchema. Opt-in
// (RUN_E2E=1) so plain `pnpm test` (CI, no live stack) stays green.
//
//   pnpm dev            # start the worker + backend first
//   pnpm test:e2e       # from the repo root
//
// Only side-effect-free paths are exercised (reads, 501 stub, and the preview
// STEP of a destructive tool, never the commit step).

const RUN = process.env.RUN_E2E === '1';
const MOUNT_PATH = '/mcp/linkedin/accounts';
const MOUNT = `${process.env.MCP_URL ?? 'http://localhost:8788'}${MOUNT_PATH}`;
const LINKEDIN_DIR = process.env.LINKEDIN_DIR ?? '/Users/eugene/sites/gtm.ai/product/backend/gtm.service.linkedin';
const TEAM = process.env.E2E_TEAM_SID ?? 'ts_tm_seeddev00001';

const tools = linkedinPackages.flatMap((p) => p.tools);
const outSchema = (name: string) => tools.find((t) => t.name === name)!.outputSchema;

// Checked against the tool's live enum at collection time. This argument used to
// read types:['messaging'], which the enum stopped accepting when the sync tracks
// were split per entity, and the two preview-gate tests below quietly turned into
// input-validation tests instead. enumArg() makes that drift fail collection.
const RESET_SYNC_TYPE = enumArg('reset_linkedin_account_sync', 'types', 'conversations');

let token = '';

async function rpc(method: string, params?: unknown): Promise<any> {
  const res = await fetch(MOUNT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return res.json();
}

beforeAll(() => {
  if (!RUN) return;
  try {
    const out = execSync(`./dev artisan jwt:fake --team-sid=${TEAM} --ttl=3600`, {
      cwd: LINKEDIN_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = out.match(/eyJ[A-Za-z0-9_.-]{40,}/g);
    token = m ? m[m.length - 1] : '';
  } catch {
    token = '';
  }
});

const suite = RUN ? describe : describe.skip;

suite('e2e /mcp/linkedin/accounts (live worker + backend)', () => {
  it('initialize', async () => {
    const r = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
    expect(r.result.serverInfo.name).toContain('gtm-linkedin');
  });

  it(`tools/list exposes the accounts mount (${mountToolCount(MOUNT_PATH)} tools)`, async () => {
    const r = await rpc('tools/list');
    const names = r.result.tools.map((t: { name: string }) => t.name);
    // A FIXED expectation kept on purpose: the mount is built from TWO selectors
    // (linkedin_accounts + linkedin_account_smart_limits) and one name from each
    // proves both resolved. A total alone would not say which package went missing.
    expect(names).toContain('search_linkedin_accounts');
    expect(names).toContain('update_linkedin_account_smart_limit');
    // Derived: the exact set this build resolves for the mount. Was a hard-coded
    // 20 that the registry had already left behind.
    expect([...names].sort()).toEqual(mountToolNames(MOUNT_PATH));
  });

  it('search returns a live envelope matching the Zod contract', async () => {
    const r = await rpc('tools/call', { name: 'search_linkedin_accounts', arguments: { page_size: 5 } });
    const sc = r.result.structuredContent;
    expect(sc.operation).toBe('search');
    expect(() => outSchema('search_linkedin_accounts').parse(sc)).not.toThrow();
  });

  it('501 stub renders a not_implemented error envelope', async () => {
    const r = await rpc('tools/call', { name: 'get_linkedin_account_my_ssi', arguments: { sid: 'ln_ac_000000000000' } });
    expect(r.result.isError).toBe(true);
    const parsed = McpErrorResponse.parse(r.result.structuredContent);
    expect(parsed.error.code).toBe('not_implemented');
  });

  it('preview gate returns a commit token without executing', async () => {
    const r = await rpc('tools/call', { name: 'reset_linkedin_account_sync', arguments: { sid: 'ln_ac_000000000000', types: [RESET_SYNC_TYPE] } });
    expect(r.result.isError).toBeUndefined();
    expect(r.result.structuredContent.preview).toBe(true);
    expect(typeof r.result.structuredContent.commit_token).toBe('string');
    // Proof the gate MINTED a token (an unexpired TTL) rather than the response
    // merely carrying the field.
    expect(r.result.structuredContent.expires_in_seconds).toBeGreaterThan(0);
  });

  it('preview gate rejects a forged commit token', async () => {
    const r = await rpc('tools/call', { name: 'reset_linkedin_account_sync', arguments: { sid: 'ln_ac_000000000000', types: [RESET_SYNC_TYPE], commit_token: 'forged.token' } });
    expect(r.result.isError).toBe(true);
    // The forged token must be rejected BY THE GATE, not by input validation:
    // that distinction is exactly what the stale enum value used to hide.
    expect(r.result.content[0].text).toMatch(/commit_token/i);
  });
});
