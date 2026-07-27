import { buildRegistry, resolveMounts, type ResolvedMount } from '@gtm/mcp-runtime';
import { linkedinPackages } from '@gtm/mcp-linkedin';
import { idPackages } from '@gtm/mcp-id';
import { orchestrationPackages } from '@gtm/mcp-orchestration';
import { supportPackages } from '@gtm/mcp-support';
import { MOUNTS } from '@gtm/mcp-worker/src/mounts.config';

// What the e2e suites expect the live worker to serve, derived from the SAME
// registry + mount resolution apps/worker/src/index.ts performs at module scope.
//
// Why derive instead of hard-code: a per-mount tool count written into an e2e
// file is a second copy of a fact this build already owns, and the e2e arm only
// runs under RUN_E2E=1, so that copy rots unseen. Every one of those numbers was
// months behind the registry by the time anyone ran the live arm again. Deriving
// also makes the assertion stronger, not weaker: the suites compare the exact
// tool NAMES the mount resolves, which catches a swap that keeps the total.
//
// The rot guard: everything here is evaluated when vitest COLLECTS an e2e file,
// and collection happens on the plain offline run too (the suites are
// describe.skip'd, not unloaded). So a mount path that disappears, or an
// argument value that leaves a tool's enum, fails `pnpm test` right away instead
// of waiting for whoever next remembers to run the live arm.

const REGISTRY = buildRegistry([
  ...linkedinPackages,
  ...idPackages,
  ...orchestrationPackages,
  ...supportPackages,
]);
const RESOLVED = resolveMounts(REGISTRY, MOUNTS);
const BY_PATH = new Map<string, ResolvedMount>(RESOLVED.map((m) => [m.config.path, m]));

function mount(path: string): ResolvedMount {
  const found = BY_PATH.get(path);
  if (!found) {
    throw new Error(
      `e2e: no mount at '${path}'. Live mount paths: ${[...BY_PATH.keys()].join(', ')}. ` +
        'It was renamed or removed in apps/worker/src/mounts.config.ts; point the e2e suite at the new path.',
    );
  }
  return found;
}

/** Sorted tool names the worker serves on `path` (tools/list order is not a contract). */
export const mountToolNames = (path: string): string[] => mount(path).tools.map((t) => t.name).sort();

/** Tool count on `path`. For test titles, so the number in the report stays true. */
export const mountToolCount = (path: string): number => mount(path).tools.length;

// The facade's toolset catalog: every non-facade mount, keyed the way
// registerFacadeTools() keys it (the `toolsetId` mapping in
// packages/runtime/src/facade.ts). index.ts feeds the facade exactly this set as
// DOMAIN_MOUNTS, so list_toolsets is a projection of it and nothing else.
export const DOMAIN_TOOLSETS: { toolset: string; path: string; toolCount: number }[] = RESOLVED
  .filter((m) => m.config.facade !== 'toolsets')
  .map((m) => ({
    toolset: m.config.path.replace(/^\/mcp\//, '').replace(/\//g, '.'),
    path: m.config.path,
    toolCount: m.tools.length,
  }));

/** The facade's toolset id for a mount path, so a suite never spells both out. */
export function toolsetIdFor(path: string): string {
  const found = DOMAIN_TOOLSETS.find((t) => t.path === path);
  if (!found) {
    throw new Error(
      `e2e: '${path}' is not a domain mount, so the facade serves no toolset for it. Domain mounts: ${DOMAIN_TOOLSETS.map((t) => t.path).join(', ')}.`,
    );
  }
  return found.toolset;
}

// Walk a Zod node down to the string enum underneath it (array element, optional
// wrapper, or the enum itself). ZodUnion also carries `.options`, so the string
// check is what tells a real enum from a union of schemas.
function enumOptions(node: unknown): string[] | undefined {
  let cur: unknown = node;
  for (let depth = 0; cur != null && depth < 6; depth += 1) {
    const zod = cur as { options?: unknown; element?: unknown; unwrap?: unknown };
    if (Array.isArray(zod.options) && zod.options.every((o): o is string => typeof o === 'string')) {
      return [...zod.options];
    }
    cur =
      zod.element ??
      (typeof zod.unwrap === 'function' ? (zod.unwrap as () => unknown).call(cur) : undefined);
  }
  return undefined;
}

/**
 * `preferred`, checked against the live enum of `toolName`.`field`.
 *
 * Argument literals rot exactly like counts do, and worse: reset_linkedin_account_sync
 * used to take types:['messaging'], the enum was reshaped into per-track values,
 * and the skipped test went on sending a value that now dies in input validation
 * long before the preview gate it means to exercise. An e2e call should still say
 * out loud what it sends, so the literal stays; checking it here means the drift
 * fails collection instead of quietly changing what the test proves.
 */
export function enumArg(toolName: string, field: string, preferred: string): string {
  const entry = REGISTRY.byName.get(toolName);
  if (!entry) {
    throw new Error(`e2e: unknown tool '${toolName}'. It was renamed or dropped from the registry.`);
  }
  const options = enumOptions(entry.tool.inputSchema.shape[field]);
  if (!options) {
    throw new Error(
      `e2e: '${toolName}.${field}' is no longer a string enum (or an array of one), so the e2e argument cannot be checked against it. Re-read the tool's inputSchema and pick the argument by hand.`,
    );
  }
  if (!options.includes(preferred)) {
    throw new Error(
      `e2e: '${toolName}.${field}' no longer accepts '${preferred}'. Live values: ${options.join(' | ')}. ` +
        'Pick one the tool still takes, otherwise the call dies in input validation before it reaches what the test means to exercise.',
    );
  }
  return preferred;
}
