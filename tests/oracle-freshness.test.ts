import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { ToolDefinition, ToolPackage } from '@gtm/mcp-runtime/types';
import { linkedinPackages } from '@gtm/mcp-linkedin';
import { idPackages } from '@gtm/mcp-id';
import { orchestrationPackages } from '@gtm/mcp-orchestration';

// Ledger gate: keeps the debt the oracle fixtures expose written down, route by
// route, and shrinking.
//
// It does NOT check that the fixtures are fresh, and the file name is older than
// that split. Freshness means "the committed dump still equals what the live
// backend emits", and nothing in this file can know that: it reads the committed
// JSON and the in-process registry, so a fixture that went stale months ago
// reads exactly like one dumped a minute ago. That half is `pnpm oracle:check`
// (bin/oracle-refresh.sh --check), which re-runs the generator against the
// running backends into a temp dir and fails on any byte of difference. Run it
// whenever a backend contract may have moved; this gate cannot stand in for it.
//
// What this file does own, all of it offline:
//   1. the fixture is structurally sound, which catches a truncated or
//      half-booted dump that a refresh let through;
//   2. every disagreement between the fixture and the registry is listed in
//      drift-ledger.json;
//   3. a ledger entry that stopped drifting is deleted, so the debt can only
//      shrink.
// The coverage gate (coverage-gate.test.ts) reports the same raw disagreement
// with no ledger allowance, and caps it with ratchet.json.
//
// A service with no MCP package is carried here with an empty package set, not
// skipped: gtm.service.email has no @gtm/mcp-email, and leaving it out would
// have meant its 44 uncovered routes were never written down anywhere.
//
// Cheap and offline by construction: committed JSON plus the in-process
// registry, no backend calls.

type OracleRoute = { method: string; uri: string };
type ContractRoute = OracleRoute & { operation: string | null; internal: boolean };
type Contract = { service: string; entities: Record<string, unknown>; routes: ContractRoute[] };
type LedgerEntry = { stale_routes: string[]; uncovered_routes: string[] };

const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

// The ratchet (fixtures/contract-oracle/ratchet.json) belongs to the coverage
// gate: it caps how many routes may be uncovered. This gate owns the ledger,
// which says which ones they are.
const ledger = readJson('../fixtures/contract-oracle/drift-ledger.json');

const routeKey = (r: OracleRoute) => `${r.method} ${r.uri}`;
const toolKey = (t: ToolDefinition) => `${t.route.method} ${t.route.pathTemplate.replace(/^\//, '')}`;

const SERVICES: { name: 'linkedin' | 'id' | 'orchestration' | 'email'; packages: ToolPackage[] }[] = [
  { name: 'linkedin', packages: linkedinPackages },
  { name: 'id', packages: idPackages },
  { name: 'orchestration', packages: orchestrationPackages },
  // No @gtm/mcp-email package exists; the empty set is the honest input.
  { name: 'email', packages: [] },
];

const REFRESH = 'run `pnpm oracle:check` to prove the fixture is current, `pnpm oracle:refresh` to update it, then reconcile';

for (const svc of SERVICES) {
  describe(`oracle ledger: ${svc.name}`, () => {
    const contract: Contract = readJson(`../fixtures/contract-oracle/${svc.name}.contract.json`);
    const entry: LedgerEntry = ledger[svc.name];

    const tools = svc.packages.flatMap((p) => p.tools);
    const covered = new Set(tools.map(toolKey));

    // The public MCP surface: /api routes the backend actually serves.
    const publicRoutes = contract.routes.filter((r) => r.uri.startsWith('api/') && !r.internal);
    const backendKeys = new Set(publicRoutes.map(routeKey));

    it('contract oracle fixture is structurally sound', () => {
      expect(contract.service).toBe(svc.name);
      expect(Object.keys(contract.entities).length).toBeGreaterThan(0);
      expect(publicRoutes.length).toBeGreaterThan(0);
      const malformed = contract.routes.filter((r) => !r.method || !r.uri);
      expect(malformed).toEqual([]);
    });

    // Every route the registry claims the backend serves.
    const stale = [...covered].filter((k) => !backendKeys.has(k)).sort();
    // Routes the backend serves as an MCP operation and no tool covers. A null
    // operation means the controller method carries no #[ApiMethod], i.e. it is
    // deliberately not part of the MCP surface.
    const uncovered = publicRoutes
      .filter((r) => r.operation !== null && !covered.has(routeKey(r)))
      .map(routeKey)
      .sort();

    it('the registry references no route the backend has dropped', () => {
      const unlisted = stale.filter((k) => !entry.stale_routes.includes(k));
      expect(
        unlisted,
        `${svc.name}: registered tools point at routes the backend no longer serves. ${REFRESH} (retire or repoint the tool, or list it in drift-ledger.json)`,
      ).toEqual([]);
    });

    it('every uncovered backend route is written down in the ledger', () => {
      const unlisted = uncovered.filter((k) => !entry.uncovered_routes.includes(k));
      expect(
        unlisted,
        `${svc.name}: backend routes with no MCP tool and no ledger entry. ${REFRESH} (ship the tools, or list them in drift-ledger.json). The ratchet in fixtures/contract-oracle/ratchet.json caps how many of these there may be; this list is who they are.`,
      ).toEqual([]);
    });

    it('drift ledger only shrinks (no entry that stopped drifting)', () => {
      const staleSet = new Set(stale);
      const uncoveredSet = new Set(uncovered);
      const resolved = [
        ...entry.stale_routes.filter((k) => !staleSet.has(k)).map((k) => `stale_routes: ${k}`),
        ...entry.uncovered_routes.filter((k) => !uncoveredSet.has(k)).map((k) => `uncovered_routes: ${k}`),
      ];
      expect(
        resolved,
        `${svc.name}: these no longer drift, delete them from fixtures/contract-oracle/drift-ledger.json`,
      ).toEqual([]);
    });
  });
}
