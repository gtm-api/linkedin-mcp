// Zod -> OpenAPI 3.0 schema conversion for the public spec generator.
//
// The registry's schemas are ordinary zod objects: nothing in packages/mcp.*
// knows this generator exists, and nothing there should. So the conversion has
// to cope with whatever the entity authors wrote, which means three things:
//
//   1. `z.lazy()` (recursive shapes) has no OpenAPI equivalent, and
//      zod-to-openapi refuses it outright. `projectable()` unwraps a lazy node
//      ONCE so the real fields are documented, then replaces the recursive
//      reference one level down with an open object.
//   2. zod-to-openapi projects `.regex()` but not `.startsWith()` /
//      `.endsWith()`, and on this API a string check is usually the sid PREFIX
//      (`ln_ac_`, `id_ak_`), which an integrator needs. `projectable()` adds the
//      equivalent regex check so it survives as `pattern`.
//   3. Conversion runs one schema at a time, so an exotic node degrades that
//      ONE request or response body into an open object with a recorded reason
//      instead of failing the whole build silently.
//
// Both rewrites are structural and never mutate the registry's own schema
// objects: an unchanged subtree is returned by identity.

import { z } from 'zod';
import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
  OpenApiGeneratorV3,
} from '@asteasolutions/zod-to-openapi';

// Patches z.ZodType.prototype, so it applies to schemas already constructed by
// the entity packages. Must run before the first registry.register().
extendZodWithOpenApi(z);

export type JsonSchema = Record<string, unknown>;

const MAX_LAZY_UNWRAPS = 1;

const RECURSIVE_NODE = z.record(z.unknown()).describe(
  'Recursive node: the same object shape repeats here. A static OpenAPI document cannot express the cycle, so this level is documented as an open object.',
);

const OPEN_OBJECT_NOTE =
  'Schema could not be projected into OpenAPI from the Zod source of truth; the wire shape is the MCP envelope described in the operation description.';

interface ZodDef {
  typeName?: string;
  [key: string]: unknown;
}

const defOf = (schema: z.ZodTypeAny): ZodDef => (schema as unknown as { _def: ZodDef })._def;

const cloneWith = (schema: z.ZodTypeAny, def: ZodDef): z.ZodTypeAny => {
  const Ctor = (schema as unknown as { constructor: new (def: ZodDef) => z.ZodTypeAny }).constructor;
  return new Ctor(def);
};

// zod types that wrap exactly one nested schema, and the _def key holding it.
const SINGLE_CHILD: Record<string, string> = {
  ZodArray: 'type',
  ZodOptional: 'innerType',
  ZodNullable: 'innerType',
  ZodDefault: 'innerType',
  ZodCatch: 'innerType',
  ZodReadonly: 'innerType',
  ZodBranded: 'type',
  ZodPromise: 'type',
  ZodSet: 'valueType',
  ZodRecord: 'valueType',
  ZodEffects: 'schema',
};

// zod types holding a list of nested schemas.
const CHILD_LIST: Record<string, string> = {
  ZodUnion: 'options',
  ZodTuple: 'items',
};

interface StringCheck {
  kind: string;
  value?: string;
  regex?: RegExp;
}

const escapeRegex = (literal: string): string => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * zod-to-openapi only projects `.regex()`, so a `.startsWith()` / `.endsWith()`
 * check would vanish from the document. Add the equivalent regex check (used
 * for documentation only; this clone never validates a request).
 */
function withPatternCheck(schema: z.ZodTypeAny, def: ZodDef): z.ZodTypeAny {
  const checks = (def.checks as StringCheck[] | undefined) ?? [];
  if (checks.some((check) => check.kind === 'regex')) return schema;
  const prefix = checks.find((check) => check.kind === 'startsWith')?.value;
  const suffix = checks.find((check) => check.kind === 'endsWith')?.value;
  if (prefix === undefined && suffix === undefined) return schema;
  const pattern = `^${prefix === undefined ? '' : escapeRegex(prefix)}${
    suffix === undefined ? '' : `.*${escapeRegex(suffix)}$`
  }`;
  return cloneWith(schema, {
    ...def,
    checks: [...checks, { kind: 'regex', regex: new RegExp(pattern) }],
  });
}

/**
 * Return an equivalent schema that OpenAPI can express: every `z.lazy()`
 * resolved (unwrapped once, then cut off with an open object) and every string
 * prefix/suffix check restated as a regex. Returns the input untouched (by
 * identity) when nothing below it needs either rewrite, which is the norm.
 */
export function projectable(schema: z.ZodTypeAny, unwrapped = 0): z.ZodTypeAny {
  const def = defOf(schema);
  const typeName = def.typeName ?? '';

  if (typeName === 'ZodLazy') {
    if (unwrapped >= MAX_LAZY_UNWRAPS) return RECURSIVE_NODE;
    return projectable((def.getter as () => z.ZodTypeAny)(), unwrapped + 1);
  }

  if (typeName === 'ZodString') return withPatternCheck(schema, def);

  if (typeName === 'ZodObject') {
    const shape = (def.shape as () => Record<string, z.ZodTypeAny>)();
    const next: Record<string, z.ZodTypeAny> = {};
    let changed = false;
    for (const [key, value] of Object.entries(shape)) {
      const rebuilt = projectable(value, unwrapped);
      if (rebuilt !== value) changed = true;
      next[key] = rebuilt;
    }
    return changed ? cloneWith(schema, { ...def, shape: () => next }) : schema;
  }

  if (typeName === 'ZodIntersection') {
    const left = projectable(def.left as z.ZodTypeAny, unwrapped);
    const right = projectable(def.right as z.ZodTypeAny, unwrapped);
    return left === def.left && right === def.right
      ? schema
      : cloneWith(schema, { ...def, left, right });
  }

  const childKey = SINGLE_CHILD[typeName];
  if (childKey) {
    const child = def[childKey] as z.ZodTypeAny;
    const rebuilt = projectable(child, unwrapped);
    return rebuilt === child ? schema : cloneWith(schema, { ...def, [childKey]: rebuilt });
  }

  const listKey = CHILD_LIST[typeName];
  if (listKey) {
    const children = def[listKey] as z.ZodTypeAny[];
    let changed = false;
    const next = children.map((child) => {
      const rebuilt = projectable(child, unwrapped);
      if (rebuilt !== child) changed = true;
      return rebuilt;
    });
    return changed ? cloneWith(schema, { ...def, [listKey]: next }) : schema;
  }

  // Leaf, or a container this rebuild does not know. If a lazy node hides in
  // there, convertSchema() catches the throw and records the fallback.
  return schema;
}

/**
 * Drop `nullable: true` from a node that declares no type.
 *
 * `z.unknown()` projects to a bare `{ nullable: true }`, which is meaningless
 * in OpenAPI 3.0 (nullable only qualifies a declared type) and is exactly what
 * the shared validator's `nullable-type-sibling` rule rejects. A typeless
 * schema already accepts null, so removing the keyword changes nothing on the
 * wire and makes the document lint-clean. Nodes that declare a type, or
 * compose with anyOf/oneOf/allOf/$ref, are left alone.
 */
function pruneTypelessNullable(node: unknown): void {
  if (Array.isArray(node)) {
    for (const entry of node) pruneTypelessNullable(entry);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const record = node as JsonSchema;
  const composes = ['type', 'anyOf', 'oneOf', 'allOf', '$ref'].some((key) => key in record);
  if (record.nullable === true && !composes) delete record.nullable;
  for (const value of Object.values(record)) pruneTypelessNullable(value);
}

export interface ConvertedSchema {
  schema: JsonSchema;
  /** Set when the schema had to be degraded to an open object. */
  fallbackReason?: string;
}

/**
 * Convert ONE zod schema to an OpenAPI 3.0 schema object. Isolated per schema
 * on purpose: a failure costs one body, not the document.
 */
export function convertSchema(refId: string, schema: z.ZodTypeAny): ConvertedSchema {
  const registry = new OpenAPIRegistry();
  try {
    registry.register(refId, projectable(schema) as never);
    const generated = new OpenApiGeneratorV3(registry.definitions).generateComponents();
    const converted = generated.components?.schemas?.[refId] as JsonSchema | undefined;
    if (!converted) throw new Error('the converter produced no schema');
    pruneTypelessNullable(converted);
    return { schema: converted };
  } catch (error) {
    return {
      schema: { type: 'object', description: OPEN_OBJECT_NOTE, additionalProperties: true },
      fallbackReason: (error as Error).message.split('\n')[0],
    };
  }
}
