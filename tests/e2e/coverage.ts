import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRegistry } from '@gtm/mcp-runtime';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import { linkedinPackages } from '@gtm/mcp-linkedin';
import { idPackages } from '@gtm/mcp-id';
import { orchestrationPackages } from '@gtm/mcp-orchestration';
import { supportPackages } from '@gtm/mcp-support';
import { ALL_SMOKE_MOUNTS, SMOKE_CALLED_TOOLS } from './smoke-mounts';
import { DOMAIN_MOUNT_PATHS } from './registry';

// What the live run actually covered, as a number a human can act on.
//
// The live arm reported one thing before this: "N passed". That answers whether
// the calls it happened to make succeeded, and says nothing about the question
// anyone actually has, which is how much of a 250-tool surface a green run
// stands behind. A pass count also cannot distinguish a tool whose live
// response parsed against its outputSchema (the only thing this arm exists to
// prove) from one that answered "you did not give me an account filter" and was
// counted as a pass for being a well-formed error.
//
// So the report separates them: contract-checked, needs-args, no-data,
// other-error, and then everything NOT called, with the reason. Nothing here is
// hand-maintained; the denominators come from the registry and the mount
// resolution, the same way the rest of tests/e2e does it.

const REGISTRY = buildRegistry([
  ...linkedinPackages,
  ...idPackages,
  ...orchestrationPackages,
  ...supportPackages,
]);
const ALL_TOOLS: ToolDefinition[] = [...REGISTRY.byName.values()].map((e) => e.tool);

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OUT = process.env.E2E_COVERAGE_OUT
  ? resolve(process.env.E2E_COVERAGE_OUT)
  : resolve(ROOT, 'tests/.e2e-coverage.json');

export type ContractBuckets = {
  /** Live SUCCESS envelope parsed against the tool's own outputSchema. */
  contractChecked: number;
  /** Clean error envelope, code validation_failed / nothing_to_update. */
  needsArgs: number;
  /** Nothing in the seeded tenant to read, or not_found. */
  noData: number;
  /** A mapped error that is neither of the above. */
  otherError: number;
};

export type CoverageReport = ReturnType<typeof buildReport>;

function countBy<T extends string>(tools: ToolDefinition[], key: (t: ToolDefinition) => T): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of tools) out[key(t)] = (out[key(t)] ?? 0) + 1;
  return out;
}

export function buildReport(readToolNames: string[], buckets: ContractBuckets) {
  const readSet = new Set(readToolNames);
  const smokeSet = new Set(SMOKE_CALLED_TOOLS);
  const calledSet = new Set([...readSet, ...smokeSet]);

  const uncalled = ALL_TOOLS.filter((t) => !calledSet.has(t.name));
  // Support runs on a bundled index (localHandler), so its two tools have no
  // backend response to hold an outputSchema against. They are still CALLED
  // (the knowledge mount has a smoke row), just not contract-checked here.
  const localTools = ALL_TOOLS.filter((t) => t.service === 'support');

  return {
    generated_at: new Date().toISOString(),
    registered: {
      total: ALL_TOOLS.length,
      by_service: countBy(ALL_TOOLS, (t) => t.service),
    },
    mounts: {
      domain: DOMAIN_MOUNT_PATHS.length,
      smoked: ALL_SMOKE_MOUNTS.length,
      // Guarded to equality at collection time in smoke-mounts.ts; carried here
      // so the printed report is self-contained rather than "trust the gate".
      unsmoked: DOMAIN_MOUNT_PATHS.filter((p) => !ALL_SMOKE_MOUNTS.some((m) => m.path === p)),
    },
    exercised: {
      total: calledSet.size,
      read_surface: readSet.size,
      smoke_only: [...smokeSet].filter((n) => !readSet.has(n)).sort(),
    },
    contract: {
      ...buckets,
      // The read surface, split by what the live response actually proved.
      total: readSet.size,
      // Read tools that reached no bucket at all, which on a red run is the
      // count that matters: a case that threw (transport error, a failed
      // expect) never got to say what it found. The report is written BEFORE
      // the suite asserts the buckets add up, precisely so a failing run still
      // shows where the surface went.
      unaccounted:
        readSet.size -
        (buckets.contractChecked + buckets.needsArgs + buckets.noData + buckets.otherError),
    },
    not_exercised: {
      total: uncalled.length,
      by_operation: countBy(uncalled, (t) => t.operation),
      stubs: uncalled.filter((t) => t.availability === 'stub_501').map((t) => t.name).sort(),
      creditable: uncalled.filter((t) => t.creditable).length,
      dangerous: uncalled.filter((t) => t.dangerous).length,
    },
    local_handler_tools: localTools.map((t) => t.name).sort(),
  };
}

const pct = (n: number, of: number): string => (of === 0 ? '  0%' : `${String(Math.round((n / of) * 100)).padStart(3)}%`);
const row = (label: string, value: string | number): string => `  ${label.padEnd(34)}${String(value)}`;

export function formatReport(r: CoverageReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('LIVE E2E COVERAGE');
  lines.push(
    row('registered tools', `${r.registered.total}  (${Object.entries(r.registered.by_service).map(([s, n]) => `${s} ${n}`).join(', ')})`),
  );
  lines.push(row('domain mounts smoked', `${r.mounts.smoked} / ${r.mounts.domain}`));
  lines.push(
    row('tools called live', `${r.exercised.total} / ${r.registered.total}   ${pct(r.exercised.total, r.registered.total)}`),
  );
  lines.push('');
  lines.push(`  read surface (contract arm): ${r.contract.total}`);
  lines.push(row('    outputSchema parsed', `${r.contract.contractChecked}   ${pct(r.contract.contractChecked, r.contract.total)}`));
  lines.push(row('    needs-args', `${r.contract.needsArgs}   ${pct(r.contract.needsArgs, r.contract.total)}   (required filter, clean error envelope)`));
  lines.push(row('    no-data', `${r.contract.noData}   ${pct(r.contract.noData, r.contract.total)}   (nothing seeded to read)`));
  lines.push(row('    other-error', `${r.contract.otherError}   ${pct(r.contract.otherError, r.contract.total)}`));
  if (r.contract.unaccounted !== 0) {
    lines.push(row('    UNACCOUNTED', `${r.contract.unaccounted}   (cases that failed before they could report)`));
  }
  lines.push('');
  lines.push(`  called by smoke only (not contract-checked): ${r.exercised.smoke_only.length}`);
  lines.push(`  NOT called: ${r.not_exercised.total}  ` +
    `(${Object.entries(r.not_exercised.by_operation).map(([o, n]) => `${o} ${n}`).join(', ')})`);
  lines.push(row('    of which creditable', r.not_exercised.creditable));
  lines.push(row('    of which dangerous', r.not_exercised.dangerous));
  lines.push(row('    of which stub_501', r.not_exercised.stubs.length));
  lines.push('');
  lines.push('  A tool is NOT called on purpose when it mutates, debits credits or acts');
  lines.push('  outward on LinkedIn. This arm never runs those against a live tenant; the');
  lines.push('  preview STEP of one dangerous tool is smoked, the commit step never is.');
  lines.push('');
  return lines.join('\n');
}

/** Writes the machine-readable report bin/e2e.sh prints, and returns it. */
export function writeReport(readToolNames: string[], buckets: ContractBuckets): CoverageReport {
  const report = buildReport(readToolNames, buckets);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export const COVERAGE_OUT = OUT;
