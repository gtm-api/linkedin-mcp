import type { RouteMeta, ToolDefinition, ToolPackage } from './types';
import { RESERVED_HEADERS } from './url';

export interface Registry {
  packages: ToolPackage[];
  byName: Map<string, { tool: ToolDefinition; pkg: ToolPackage }>;
}

const READ_ONLY_OPS = new Set(['search', 'get', 'metrics', 'group_by']);
const NAME_RE = /^[a-z][a-z0-9_]{3,63}$/;

// CLAUDE.md bans the em dash and the en dash as punctuation in everything we
// publish. This registry is the last gate before a string reaches an MCP client
// (tools/list) or the generated public OpenAPI, so the ban is enforced here
// instead of being left to review.
const DASH_RE = /[–—]/;

function assertNoDash(toolName: string, label: string, text: string): void {
  if (DASH_RE.test(text)) {
    throw new Error(
      `tool '${toolName}': ${label} contains an em/en dash (banned by CLAUDE.md); ` +
        'use a plain hyphen, a comma, a colon, parentheses, or split the sentence',
    );
  }
}

// Field-level .describe() text IS reachable from here: every published field
// description hangs off the tool's input or output schema, so walk the Zod tree
// and check each one. `seen` makes every node a single visit (which also
// terminates the recursive z.lazy shapes, since the resolved node references
// the same ZodLazy instance) and the depth cap is a belt-and-braces stop.
const MAX_SCHEMA_DEPTH = 24;
const CHILD_KEYS = ['innerType', 'type', 'schema', 'element', 'valueType', 'keyType', 'left', 'right', 'in', 'out'];
const CHILD_LIST_KEYS = ['options', 'items'];

function assertSchemaTextClean(toolName: string, schema: unknown, seen: Set<unknown>, depth = 0): void {
  if (!schema || typeof schema !== 'object' || depth > MAX_SCHEMA_DEPTH || seen.has(schema)) return;
  seen.add(schema);
  const def = (schema as { _def?: Record<string, unknown> })._def;
  if (!def) return;
  if (typeof def.description === 'string') {
    assertNoDash(toolName, 'field description', def.description);
  }
  const child = (node: unknown) => assertSchemaTextClean(toolName, node, seen, depth + 1);
  if (def.typeName === 'ZodObject') {
    const shape = typeof def.shape === 'function' ? (def.shape as () => Record<string, unknown>)() : def.shape;
    if (shape && typeof shape === 'object') {
      for (const key of Object.keys(shape as Record<string, unknown>)) child((shape as Record<string, unknown>)[key]);
    }
    return;
  }
  if (def.typeName === 'ZodLazy') {
    if (typeof def.getter === 'function') child((def.getter as () => unknown)());
    return;
  }
  for (const key of CHILD_KEYS) child(def[key]);
  for (const key of CHILD_LIST_KEYS) {
    const list = def[key];
    if (Array.isArray(list)) for (const node of list) child(node);
  }
}

// A header binding (route.headerParams) names a well-formed header this runtime
// does not set itself (url.ts RESERVED_HEADERS says why), and an input the tool
// really has.
const HEADER_NAME_RE = /^[A-Za-z][A-Za-z0-9-]*$/;

function assertHeaderParams(tool: ToolDefinition, route: RouteMeta, label: string): void {
  if (!route.headerParams) return;
  // The input keys the path template consumes, by the same rule as url.ts.
  const pathBound = new Set<string>();
  for (const match of route.pathTemplate.matchAll(/\{(\w+)\}/g)) {
    pathBound.add(match[1] === 'sid' ? route.sidParam ?? 'sid' : route.pathParams?.[match[1]] ?? match[1]);
  }
  for (const [header, key] of Object.entries(route.headerParams)) {
    if (!HEADER_NAME_RE.test(header)) {
      throw new Error(`tool '${tool.name}': ${label} binds '${header}', which is not a header name`);
    }
    if (RESERVED_HEADERS.has(header.toLowerCase())) {
      throw new Error(`tool '${tool.name}': ${label} binds the ${header} header, which the runtime sets itself`);
    }
    if (!(key in tool.inputSchema.shape)) {
      throw new Error(`tool '${tool.name}': ${label} binds ${header} to '${key}', which the inputSchema does not declare`);
    }
    if (key === '_meta' || key === 'commit_token' || pathBound.has(key)) {
      throw new Error(`tool '${tool.name}': ${label} binds ${header} to '${key}', which already travels elsewhere`);
    }
  }
}

// Assert the registry invariants that keep the server data-driven and safe.
// Throws at module load (and in CI) on any violation.
function assertInvariants(tool: ToolDefinition): void {
  if (!NAME_RE.test(tool.name)) {
    throw new Error(`tool '${tool.name}': name must match ${NAME_RE}`);
  }
  if (READ_ONLY_OPS.has(tool.operation)) {
    if (!tool.annotations.readOnlyHint) {
      throw new Error(`tool '${tool.name}': ${tool.operation} must set readOnlyHint`);
    }
    if (tool.dangerous) {
      throw new Error(`tool '${tool.name}': read-only op cannot be dangerous`);
    }
  }
  if (tool.dangerous && !tool.annotations.destructiveHint) {
    throw new Error(`tool '${tool.name}': dangerous tool must set destructiveHint`);
  }
  // Bulk dispatch mirrors the backend #[ApiMethod(massAction:, stepEligible:,
  // scheduleRequired:)]. massAction and stepEligible are two INDEPENDENT facts
  // (§R4): the first says this verb's own surface takes a filter/targets[] set,
  // the second says orchestration may run it as a mass-action plan step. Both are
  // ACTION-only and neither implies the other; pacing rides on either one.
  if (tool.massAction && tool.operation !== 'action') {
    throw new Error(`tool '${tool.name}': massAction requires operation 'action', got '${tool.operation}'`);
  }
  if (tool.stepEligible && tool.operation !== 'action') {
    throw new Error(`tool '${tool.name}': stepEligible requires operation 'action', got '${tool.operation}'`);
  }
  if (tool.scheduleRequired && !tool.massAction && !tool.stepEligible) {
    throw new Error(`tool '${tool.name}': scheduleRequired implies massAction or stepEligible`);
  }
  if (tool.massAction && tool.annotations.readOnlyHint) {
    throw new Error(`tool '${tool.name}': read-only tool cannot be massAction`);
  }
  if (tool.stepEligible && tool.annotations.readOnlyHint) {
    throw new Error(`tool '${tool.name}': read-only tool cannot be stepEligible`);
  }
  // Every {var} in the path must be bound (sid via sidParam, others via pathParams).
  const vars = [...tool.route.pathTemplate.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  for (const v of vars) {
    if (v === 'sid') continue;
    if (!tool.route.pathParams || !(v in tool.route.pathParams)) {
      throw new Error(`tool '${tool.name}': unbound path param {${v}}`);
    }
  }
  if (!('_meta' in tool.inputSchema.shape)) {
    throw new Error(`tool '${tool.name}': inputSchema must include _meta`);
  }
  assertHeaderParams(tool, tool.route, 'route.headerParams');
  if (tool.previewRoute) assertHeaderParams(tool, tool.previewRoute, 'previewRoute.headerParams');
  // A REST-only input is a field the tool can live without: it exists on the
  // schema (the REST reference documents it) and is optional (a call without
  // it is a valid call). A route that needs it every time is surface api.
  for (const key of tool.restOnlyInputs ?? []) {
    const field = tool.inputSchema.shape[key] as { isOptional?: () => boolean } | undefined;
    if (!field) {
      throw new Error(`tool '${tool.name}': restOnlyInputs names '${key}', which the inputSchema does not declare`);
    }
    if (key === '_meta' || !field.isOptional?.()) {
      throw new Error(`tool '${tool.name}': restOnlyInputs names '${key}', which the tool cannot be called without; make the route surface api instead`);
    }
  }
  assertNoDash(tool.name, 'description', tool.description);
  assertNoDash(tool.name, 'annotations.title', tool.annotations.title);
  const seen = new Set<unknown>();
  assertSchemaTextClean(tool.name, tool.inputSchema, seen);
  assertSchemaTextClean(tool.name, tool.outputSchema, seen);
}

export function buildRegistry(packages: ToolPackage[]): Registry {
  const byName = new Map<string, { tool: ToolDefinition; pkg: ToolPackage }>();
  for (const pkg of packages) {
    for (const tool of pkg.tools) {
      if (byName.has(tool.name)) {
        throw new Error(`duplicate tool name '${tool.name}' (in ${pkg.id})`);
      }
      assertInvariants(tool);
      byName.set(tool.name, { tool, pkg });
    }
  }
  return { packages, byName };
}
