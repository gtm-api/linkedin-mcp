import { buildRegistry, callableSchema, resolveMounts, type ResolvedMount } from '@gtm/mcp-runtime';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
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

/** Every domain mount path the worker serves (the facade excluded). */
export const DOMAIN_MOUNT_PATHS: string[] = RESOLVED
  .filter((m) => m.config.facade !== 'toolsets')
  .map((m) => m.config.path);

/**
 * `name`, checked to be a tool the worker really serves on `path`.
 *
 * A smoke row names one tool per mount. When that tool is renamed or moves
 * mounts, the row goes on calling a name the mount no longer has, the worker
 * answers "unknown tool", and the assertion the row makes ("either a search
 * envelope or a mapped backend error") accepts the failure as a pass. Resolving
 * the name here turns that into a collection error instead.
 */
export function toolOnMount(path: string, name: string): ToolDefinition {
  const found = mount(path).tools.find((t) => t.name === name);
  if (!found) {
    throw new Error(
      `e2e: '${name}' is not served on '${path}'. Tools there: ${mountToolNames(path).join(', ')}. ` +
        'It was renamed, moved to another mount, or dropped; point the smoke row at a tool the mount still has.',
    );
  }
  return found;
}

/**
 * `name` on `path`, checked to be a stub AND to be callable with `args`.
 *
 * Both halves earned their place the hard way. The wave-1 rows named
 * `scrape_linkedin_similar_profiles` and `enrich_linkedin_person_contact_info`
 * as the mount's "stub", and neither has been `stub_501` for a long time: those
 * two tests were dispatching CREDITABLE tools at the live backend and passing
 * because a missing required argument happened to be rejected first. And every
 * stub row called its tool with `_meta` alone, so on any stub that has a
 * required field (`create_linkedin_post` needs an account and a text) the SDK
 * rejected the arguments and the stub gate was never reached at all. The test
 * titled "the stub is gated and side-effect-free" was, in three of four cases,
 * proving that input validation works.
 *
 * So: availability has to say `stub_501`, and `args` has to satisfy the same
 * schema the SDK parses against (`callableSchema`, commit_token included), or
 * this fails at collection with the reason.
 */
export function stubOnMount(path: string, name: string, args: Record<string, unknown>): ToolDefinition {
  const tool = toolOnMount(path, name);
  if (tool.availability !== 'stub_501') {
    const stubs = mount(path).tools.filter((t) => t.availability === 'stub_501').map((t) => t.name);
    throw new Error(
      `e2e: '${name}' is availability '${tool.availability}', not 'stub_501', so calling it does NOT exercise the stub gate. ` +
        (stubs.length
          ? `Stubs on '${path}': ${stubs.join(', ')}.`
          : `'${path}' has no stub tool left; drop the stub row.`),
    );
  }
  const parsed = callableSchema(tool).safeParse(args);
  if (!parsed.success) {
    throw new Error(
      `e2e: the arguments for the stub '${name}' do not satisfy its own inputSchema, so the SDK rejects the call ` +
        `before the stub gate runs and the test proves nothing: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
    );
  }
  return tool;
}

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
