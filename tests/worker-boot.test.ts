import { describe, it, expect } from 'vitest';
import { buildRegistry, resolveMounts, type MountConfig, type ResolvedMount } from '@gtm/mcp-runtime';
import { linkedinPackages } from '@gtm/mcp-linkedin';
import { idPackages } from '@gtm/mcp-id';
import { orchestrationPackages } from '@gtm/mcp-orchestration';
import { supportPackages } from '@gtm/mcp-support';
import { MOUNTS } from '@gtm/mcp-worker/src/mounts.config';

// Worker boot gate: everything apps/worker/src/index.ts does at MODULE scope.
//
// The worker builds the registry and resolves the mounts outside `fetch`, on
// purpose - a bad registry or an over-budget mount is supposed to fail fast.
// The cost of that choice is that the failure lands in the isolate, not in CI:
// resolveMounts() throws before the first request, so ONE tool too many on a
// mount does not degrade that mount, it kills the whole worker. Nothing else in
// this suite calls resolveMounts, and the per-service coverage gate builds its
// registry WITHOUT the support packages, so the exact package set the worker
// boots with was untested until this file.
//
// The invariants, in the order index.ts establishes them:
//   1. buildRegistry over linkedin + id + orchestration + support (all four,
//      the worker's set) holds every registry invariant;
//   2. resolveMounts over the real MOUNTS resolves every selector and keeps
//      every non-facade mount inside its tool budget;
//   3. mount paths are unique, because index.ts keys `MOUNT_BY_PATH` by path
//      and a duplicate would silently shadow an endpoint rather than throw;
//   4. at least one domain mount survives the facade filter, since
//      `DOMAIN_MOUNTS` is the toolset catalog the /mcp facade serves.
//
// This gate NEVER raises a budget and never splits a mount. A mount sitting at
// its cap passes (25 <= 25 is legal); the headroom table below is how the next
// person sees the cap coming before they author the tool that trips it.
//
// In-process and offline: no backend calls, no fixtures.

const WORKER_PACKAGES = [
  ...linkedinPackages,
  ...idPackages,
  ...orchestrationPackages,
  ...supportPackages,
];

// Exactly the two module-scope calls from index.ts, in order. Everything after
// them in the worker (MOUNT_BY_PATH, DOMAIN_MOUNTS) is derived from the result.
const boot = (): ResolvedMount[] => resolveMounts(buildRegistry(WORKER_PACKAGES), MOUNTS);

// The same resolution with the budget lifted, so the headroom table can be
// printed even on the run where a mount has just gone over. It reuses the real
// resolver (selectors, dedupe, excludes) rather than recounting by hand - a
// hand-rolled count would drift from resolveMounts the moment either changes.
const UNCAPPED = Number.MAX_SAFE_INTEGER;
const resolveUncapped = (): ResolvedMount[] => {
  const registry = buildRegistry(WORKER_PACKAGES);
  const lifted: MountConfig[] = MOUNTS.map((config) => ({ ...config, maxTools: UNCAPPED }));
  // Report against the DECLARED budget, not the lifted one.
  return resolveMounts(registry, lifted).map((m, i) => ({ ...m, config: MOUNTS[i] }));
};

const budgetOf = (config: MountConfig) => config.maxTools ?? 25;
const isFacade = (config: MountConfig) => config.facade === 'toolsets';

describe('worker boot', () => {
  it('prints mount headroom (tools / max), tightest first', () => {
    const rows = resolveUncapped()
      .map((m) => ({
        path: m.config.path,
        tools: m.tools.length,
        max: budgetOf(m.config),
        facade: isFacade(m.config),
      }))
      .sort((a, b) => {
        if (a.facade !== b.facade) return a.facade ? 1 : -1;
        return a.max - a.tools - (b.max - b.tools);
      });

    const pathPad = Math.max(...rows.map((r) => r.path.length));
    const toolPad = Math.max(...rows.map((r) => String(r.tools).length));
    const lines = rows.map((r) => {
      const path = r.path.padEnd(pathPad);
      const tools = String(r.tools).padStart(toolPad);
      if (r.facade) return `  ${path}  ${tools} tools   exempt (facade)`;
      const free = r.max - r.tools;
      const note =
        free < 0
          ? `OVER BUDGET by ${-free}`
          : free === 0
            ? 'AT CAP - the next tool on this mount breaks worker boot'
            : `${free} free`;
      return `  ${path}  ${tools} / ${r.max}   ${note}`;
    });

    // process.stdout.write, not console.log: vitest's default reporter (what
    // `turbo test` runs) swallows console output from a PASSING test, and this
    // table has to be visible on the green run - that is the whole point of it.
    process.stdout.write(
      `\nworker mount headroom (tools / max), tightest first:\n${lines.join('\n')}\n` +
        'A mount at its cap is legal and stays legal. Do NOT raise maxTools or split a mount to\n' +
        'make room as a reflex - the cap is what keeps a mount usable by a client, so growing\n' +
        'past it is a product decision, not a test fix.\n\n',
    );

    expect(rows.length).toBe(MOUNTS.length);
  });

  it('registry builds over the full worker package set (linkedin + id + orchestration + support)', () => {
    expect(() => buildRegistry(WORKER_PACKAGES)).not.toThrow();
  });

  it('resolveMounts succeeds over the real mounts.config: every mount resolves and fits its budget', () => {
    // A throw here is a dead worker, not a degraded endpoint.
    expect(() => boot()).not.toThrow();
  });

  it('no mount exceeds its tool budget', () => {
    const over = resolveUncapped()
      .filter((m) => !isFacade(m.config) && m.tools.length > budgetOf(m.config))
      .map((m) => `${m.config.path}: ${m.tools.length} tools exceeds max ${budgetOf(m.config)}`);
    expect(
      over,
      `These mounts are over budget, so resolveMounts() throws at module scope and the worker isolate never boots:\n${over.join('\n')}\nFix the mount that grew (move the new tool to a mount with headroom, or give it its own), not the budget.`,
    ).toEqual([]);
  });

  it('mount paths are unique (index.ts keys MOUNT_BY_PATH by path)', () => {
    const seen = new Set<string>();
    const dupes = MOUNTS.map((m) => m.path).filter((p) => (seen.has(p) ? true : (seen.add(p), false)));
    expect(dupes, 'A duplicate mount path silently shadows an endpoint instead of throwing.').toEqual([]);
  });

  // The facade routes off the catalog + the whole registry, never off its own
  // selectors, so a selector list that is missing a service does not break a
  // call: it just makes the DECLARED surface (the /health tool count for /mcp,
  // and the total quoted in PACKAGES.md) under-report what call_tool serves.
  // That is exactly how support sat outside the declared 248 while being
  // callable, so assert the two are the same number.
  it('the facade declares the whole registry (/health and PACKAGES.md match what call_tool serves)', () => {
    const facade = boot().find((m) => isFacade(m.config));
    expect(facade, 'no facade mount in MOUNTS').toBeDefined();
    expect(facade!.tools.length).toBe(buildRegistry(WORKER_PACKAGES).byName.size);
  });

  it('the facade has a non-empty domain-mount catalog', () => {
    const domain = boot().filter((m) => !isFacade(m.config));
    expect(domain.length).toBeGreaterThan(0);
    for (const m of domain) {
      expect(m.tools.length, `mount ${m.config.path} resolved to zero tools`).toBeGreaterThan(0);
    }
  });
});
