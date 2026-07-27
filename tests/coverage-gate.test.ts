import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildRegistry } from '@gtm/mcp-runtime/registry';
import type { ToolDefinition, ToolPackage } from '@gtm/mcp-runtime/types';
import { linkedinPackages } from '@gtm/mcp-linkedin';
import { idPackages } from '@gtm/mcp-id';
import { orchestrationPackages } from '@gtm/mcp-orchestration';

// Coverage gate: the registry and the live backend surface must agree.
//
// The source of truth is fixtures/contract-oracle/{service}.contract.json,
// machine-generated from the running backend by `pnpm oracle:refresh`. The
// public MCP surface is every route under `api/` that is not #[InternalMethod].
//
// This gate is deliberately strict: it reports the raw disagreement, with no
// allowance for accepted debt. The ledger-aware view of the same two facts (the
// debt we have written down, route by route, and which must only shrink) lives
// in oracle-freshness.test.ts.
//
// A service with NO MCP package is carried here with an empty package set rather
// than left out. gtm.service.email is that case: skipping it would have made its
// 44 uncovered routes count as zero, which is not the same statement as "44
// uncovered, all of them written down". An empty set measures the debt exactly
// the way every other service is measured, and the ratchet then holds it from
// growing while the coverage is missing.

type ContractRoute = { method: string; uri: string; operation: string | null; internal: boolean };
type Contract = { service: string; entities: Record<string, unknown>; routes: ContractRoute[] };
type OracleRoute = { method: string; uri: string };

const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

const ratchet = readJson('../fixtures/contract-oracle/ratchet.json');

// The public MCP surface: `api/` routes the backend actually serves. Internal
// routes are excluded because no MCP tool can reach them.
const publicRoutes = (service: string): ContractRoute[] => {
  const contract: Contract = readJson(`../fixtures/contract-oracle/${service}.contract.json`);
  return contract.routes.filter((r) => r.uri.startsWith('api/') && !r.internal);
};

const routeKey = (r: OracleRoute) => `${r.method} ${r.uri}`;
const toolKey = (t: ToolDefinition) => `${t.route.method} ${t.route.pathTemplate.replace(/^\//, '')}`;

const SERVICES: { name: 'linkedin' | 'id' | 'orchestration' | 'email'; packages: ToolPackage[]; oracle: ContractRoute[]; baseline: number }[] = [
  { name: 'linkedin', packages: linkedinPackages, oracle: publicRoutes('linkedin'), baseline: ratchet.linkedin.baseline },
  { name: 'id', packages: idPackages, oracle: publicRoutes('id'), baseline: ratchet.id.baseline },
  { name: 'orchestration', packages: orchestrationPackages, oracle: publicRoutes('orchestration'), baseline: ratchet.orchestration.baseline },
  // No @gtm/mcp-email package exists. The empty set is the honest input, not a
  // placeholder: replace it with `emailPackages` the day one is authored.
  { name: 'email', packages: [], oracle: publicRoutes('email'), baseline: ratchet.email.baseline },
];

it('registry builds: all v2 invariants hold across every service', () => {
  expect(() => buildRegistry([...linkedinPackages, ...idPackages, ...orchestrationPackages])).not.toThrow();
});

for (const svc of SERVICES) {
  describe(`coverage gate: ${svc.name}`, () => {
    const tools = svc.packages.flatMap((p) => p.tools);
    const oracleKeys = new Set(svc.oracle.map(routeKey));

    it('is measured against a fixture that actually carries a public surface', () => {
      // Guard the guard. Both assertions below read green on an empty oracle, and
      // the tool count is printed so a package set that silently resolved to
      // nothing is visible in the log rather than passing as "everything maps".
      // eslint-disable-next-line no-console
      console.log(`${svc.name}: ${tools.length} registered tools against ${svc.oracle.length} public backend routes.`);
      expect(
        svc.oracle.length,
        `${svc.name}.contract.json holds no public api/ routes, so this gate checked nothing (stale or truncated fixture: run \`pnpm oracle:refresh\`)`,
      ).toBeGreaterThan(0);
    });

    it('every registered tool maps to a real backend route', () => {
      const missing = tools.filter((t) => !oracleKeys.has(toolKey(t))).map((t) => `${t.name} -> ${toolKey(t)}`);
      expect(
        missing,
        `${svc.name}: these tools point at routes the backend does not serve. Retire or repoint the tool (run \`pnpm oracle:refresh\` first if the fixture may be behind).`,
      ).toEqual([]);
    });

    it('uncovered routes stay within the ratchet baseline (must only decrease)', () => {
      const covered = new Set(tools.map(toolKey));
      // A null operation means the controller method carries no #[ApiMethod]:
      // it is deliberately not an MCP surface, so it can never be "covered" and
      // must not sit in the ratchet forever.
      const uncovered = svc.oracle.filter((r) => r.operation !== null && !covered.has(routeKey(r)));
      if (uncovered.length < svc.baseline) {
        // eslint-disable-next-line no-console
        console.log(
          `${svc.name}: ${uncovered.length} uncovered < baseline ${svc.baseline}, lower ratchet.${svc.name}.baseline to ${uncovered.length}.`,
        );
      }
      expect(
        uncovered.length,
        `${svc.name} uncovered:\n${uncovered.map(routeKey).sort().join('\n')}`,
      ).toBeLessThanOrEqual(svc.baseline);
    });
  });
}
