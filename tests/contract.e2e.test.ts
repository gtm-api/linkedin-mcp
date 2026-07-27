import { describe, it, expect, beforeAll } from 'vitest';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import { McpErrorResponse } from '@gtm/mcp-shared';
import { linkedinPackages } from '@gtm/mcp-linkedin';
import { idPackages } from '@gtm/mcp-id';
import { orchestrationPackages } from '@gtm/mcp-orchestration';
import { mintDevToken } from './e2e/token';
import { COVERAGE_OUT, formatReport, writeReport } from './e2e/coverage';

// Registry-driven CONTRACT test: for every SAFE READ tool (search / get / metrics)
// call it live through the facade and Zod-parse the response against the tool's
// own `outputSchema`. This is what validates the Zod contracts against real
// backend JSON across the whole read surface (not a hand-picked subset).
//
// Never invokes mutating / creditable / outward tools (action/create/update/delete).
// Opt-in (RUN_E2E=1); needs the running worker + live backends. A read that needs
// a required filter (e.g. account-scoped / period) comes back as a clean error
// envelope (still contract-valid) and is reported as "needs-args", not a failure.

const RUN = process.env.RUN_E2E === '1';
const FACADE = `${process.env.MCP_URL ?? 'http://localhost:8788'}/mcp`;

const READ_OPS = new Set(['search', 'get', 'metrics']);
const allTools: ToolDefinition[] = [...linkedinPackages, ...idPackages, ...orchestrationPackages]
  .flatMap((p) => p.tools);
const readTools = allTools.filter((t) => READ_OPS.has(t.operation));
const searchNameByEntity = new Map<string, string>();
for (const t of allTools) if (t.operation === 'search') searchNameByEntity.set(t.entity, t.name);

let token = '';
async function callTool(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; sc: unknown }> {
  const res = await fetch(FACADE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'call_tool', arguments: { name, arguments: args } } }),
  });
  const j = (await res.json()) as { result?: { isError?: boolean; structuredContent?: unknown } };
  const r = j.result ?? {};
  return { isError: r.isError === true, sc: r.structuredContent };
}

// A narrow window - the backend caps metrics periods (≤ 90d).
const period = { from: new Date(Date.now() - 30 * 86_400_000).toISOString(), to: new Date().toISOString() };
function argsFor(tool: ToolDefinition, sid?: string): Record<string, unknown> {
  if (tool.operation === 'search') return { page_size: 1 };
  if (tool.operation === 'metrics') return { period };
  if (tool.operation === 'get') return { sid };
  return {};
}

const stats = { ok: 0, needsArgs: 0, noData: 0, otherError: 0 };

beforeAll(() => {
  if (!RUN) return;
  token = mintDevToken();
});

const suite = RUN ? describe : describe.skip;

suite('contract - every read tool parses against its Zod outputSchema (live)', () => {
  for (const tool of readTools) {
    it(`${tool.name} (${tool.operation})`, async () => {
      let sid: string | undefined;
      if (tool.operation === 'get') {
        const searchName = searchNameByEntity.get(tool.entity);
        if (searchName) {
          const s = await callTool(searchName, { page_size: 1 });
          const items = (s.sc as { items?: { item?: { sid?: string } }[] })?.items;
          sid = items?.[0]?.item?.sid;
        }
        if (!sid) { stats.noData++; return; } // no row to fetch - nothing to contract-check
      }

      const { isError, sc } = await callTool(tool.name, argsFor(tool, sid));
      expect(sc, `${tool.name}: no structuredContent (transport error?)`).toBeDefined();

      if (isError) {
        const parsed = McpErrorResponse.safeParse(sc);
        expect(parsed.success, `${tool.name}: error envelope violates McpErrorResponse: ${JSON.stringify(parsed.error?.issues?.slice(0, 2))}`).toBe(true);
        const code = parsed.success ? parsed.data.error.code : 'unknown';
        if (code === 'validation_failed' || code === 'nothing_to_update') stats.needsArgs++;
        else if (code === 'not_found') stats.noData++;
        else stats.otherError++;
        return;
      }

      // Success → the real contract assertion: the live envelope matches the tool's Zod outputSchema.
      const parsed = tool.outputSchema.safeParse(sc);
      expect(parsed.success, `${tool.name}: SUCCESS envelope failed its outputSchema: ${JSON.stringify(parsed.error?.issues?.slice(0, 4))}`).toBe(true);
      stats.ok++;
    });
  }

  // Runs last (vitest keeps declaration order inside a describe), so every read
  // tool above has landed in exactly one bucket by the time this writes the
  // report bin/e2e.sh prints.
  //
  // Write and print BEFORE asserting, deliberately. The equality below is a real
  // guard (a case that threw never reached a bucket, so the sum comes up short),
  // but making it the first statement meant a red run produced NO report at all,
  // which is the run where the buckets are most worth seeing: "9 failures and
  // the read surface fell from 59 parsed to 12" and "9 failures, coverage
  // unchanged" are different problems. The shortfall is reported as
  // `unaccounted` instead of being hidden by a thrown assertion.
  it('coverage report', () => {
    const report = writeReport(readTools.map((t) => t.name), {
      contractChecked: stats.ok,
      needsArgs: stats.needsArgs,
      noData: stats.noData,
      otherError: stats.otherError,
    });
    // eslint-disable-next-line no-console
    console.log(`${formatReport(report)}  written to ${COVERAGE_OUT}\n`);
    expect(
      report.contract.unaccounted,
      `${report.contract.unaccounted} read tool(s) reached no bucket: their case failed before it could classify the response.`,
    ).toBe(0);
  });
});
