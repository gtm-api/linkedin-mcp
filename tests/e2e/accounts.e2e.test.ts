import { describe, it, expect, beforeAll } from 'vitest';
import { linkedinPackages } from '@gtm/mcp-linkedin';
import { McpErrorResponse } from '@gtm/mcp-shared';
import { enumArg, mountToolCount, mountToolNames } from './registry';
import { ACCOUNTS_MOUNT, PREVIEW_SMOKE_TOOL, searchArgsOf, stubArgsOf } from './smoke-mounts';
import { mintDevToken } from './token';

// Live e2e: drives the RUNNING worker over HTTP against the live local backend,
// and Zod-parses the envelopes against each tool's outputSchema. Opt-in
// (RUN_E2E=1) so plain `pnpm test` (CI, no live stack) stays green.
//
//   pnpm e2e            # the whole dance: backends, worker, token, run, teardown
//   pnpm test:e2e       # just the suites, against a stack you started yourself
//
// Only side-effect-free paths are exercised (reads, a stub, and the preview
// STEP of a destructive tool, never the commit step).

const RUN = process.env.RUN_E2E === '1';
const MOUNT_PATH = ACCOUNTS_MOUNT.path;
const MOUNT = `${process.env.MCP_URL ?? 'http://localhost:8788'}${MOUNT_PATH}`;

const tools = linkedinPackages.flatMap((p) => p.tools);
const outSchema = (name: string) => tools.find((t) => t.name === name)!.outputSchema;

// Checked against the tool's live enum at collection time. This argument used to
// read types:['messaging'], which the enum stopped accepting when the sync tracks
// were split per entity, and the two preview-gate tests below quietly turned into
// input-validation tests instead. enumArg() makes that drift fail collection.
const RESET_SYNC_TYPE = enumArg(PREVIEW_SMOKE_TOOL, 'types', 'conversations');

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
  token = mintDevToken();
});

const suite = RUN ? describe : describe.skip;

suite('e2e /mcp/linkedin/accounts (live worker + backend)', () => {
  it('initialize', async () => {
    const r = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
    expect(r.result.serverInfo.name).toBe(ACCOUNTS_MOUNT.name);
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
    const r = await rpc('tools/call', { name: ACCOUNTS_MOUNT.search, arguments: searchArgsOf(ACCOUNTS_MOUNT) });
    const sc = r.result.structuredContent;
    expect(sc.operation).toBe('search');
    expect(() => outSchema(ACCOUNTS_MOUNT.search!).parse(sc)).not.toThrow();
  });

  // This used to be titled "501 stub" and asserted the code alone. Both were
  // stale as of the stub gate: the answer no longer comes from the backend's
  // §5.9 501 at all, it is produced by the FIRST middleware in the chain, before
  // any fetch and before the preview gate. Asserting `not_implemented` on its
  // own could not tell the two apart, which is the whole point of the change (a
  // stub call used to cost a preview round trip, a KV write and a second round
  // trip to be told a fixed answer). `context.source` is the field that settles
  // it without parsing prose.
  //
  // Guarded like `search` above: ACCOUNTS_MOUNT deliberately declares no `stub`
  // since 2026-07-30 (the mount's last §5.9 stub went GA), and smoke-mounts.ts
  // promises "every use site guards on it" - calling with an undefined name
  // just produced a protocol-level -32602 that asserted nothing about the gate.
  if (ACCOUNTS_MOUNT.stub) {
    it('a stub is answered in-worker, with no backend hop', async () => {
      const r = await rpc('tools/call', { name: ACCOUNTS_MOUNT.stub, arguments: stubArgsOf(ACCOUNTS_MOUNT) });
      expect(r.result.isError).toBe(true);
      const parsed = McpErrorResponse.parse(r.result.structuredContent);
      expect(parsed.error.code).toBe('not_implemented');
      expect(parsed.error.recoverable).toBe(false);
      expect(parsed.error.context?.['source']).toBe('mcp_runtime');
      expect(parsed.error.context?.['availability']).toBe('stub_501');
    });
  }

  it('preview gate returns a commit token without executing', async () => {
    const r = await rpc('tools/call', { name: PREVIEW_SMOKE_TOOL, arguments: { sid: 'ln_ac_000000000000', types: [RESET_SYNC_TYPE] } });
    expect(r.result.isError).toBeUndefined();
    expect(r.result.structuredContent.preview).toBe(true);
    expect(typeof r.result.structuredContent.commit_token).toBe('string');
    // Proof the gate MINTED a token (an unexpired TTL) rather than the response
    // merely carrying the field.
    expect(r.result.structuredContent.expires_in_seconds).toBeGreaterThan(0);
  });

  it('preview gate rejects a forged commit token', async () => {
    const r = await rpc('tools/call', { name: PREVIEW_SMOKE_TOOL, arguments: { sid: 'ln_ac_000000000000', types: [RESET_SYNC_TYPE], commit_token: 'forged.token' } });
    expect(r.result.isError).toBe(true);
    // The forged token must be rejected BY THE GATE, not by input validation:
    // that distinction is exactly what the stale enum value used to hide.
    expect(r.result.content[0].text).toMatch(/commit_token/i);
  });
});
