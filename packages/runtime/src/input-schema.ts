import { z } from 'zod';
import type { ToolDefinition, ToolResult } from './types';

// The ONE definition of "what this tool accepts", used by both entry points.
//
// A domain mount hands `registeredShape()` to the SDK, which builds a z.object
// from it and parses every call before the handler runs. The unified /mcp facade
// takes `arguments` as an opaque object, so nothing on that path parses anything
// unless it does it here: without this module the facade would forward whatever
// the client sent, and every bound the inputSchema states (page_size caps, sid
// prefixes, sort-column enums) would hold on the per-domain URLs and mean
// nothing on the one URL a production client actually mounts. An off-contract
// sort column would then reach the backend and come back a 500 instead of the
// 422 the same call earns on a domain mount.
//
// Both entry points therefore read the shape from here rather than assembling
// their own, so the two surfaces cannot drift apart again.

const COMMIT_TOKEN = z
  .string()
  .optional()
  .describe(
    'Confirmation token from the preview step. Omit on the first call to get a preview; pass the returned token (with identical args) to execute.',
  );

/**
 * The team-scope override, advertised in exactly ONE contract: the facade's
 * `call_tool` (top level, next to `name`/`arguments`). Deliberately NOT
 * injected into per-tool schemas - the platform doctrine is that a tool's
 * team comes from the token, never from its arguments, and the advertised
 * contracts must keep saying so. Domain mounts switch teams via the
 * `Team-SID` header instead (per connection).
 */
export const TeamSidOverride = z
  .string()
  .length(18)
  .startsWith('ts_tm_')
  .describe(
    'Run this call in another of your teams. The edge exchanges the request token for a sibling installation token (RFC 8693); the OAuth grant must cover that team and you must be a live member. Omit to act in the token team (see meta.team_sid on any response).',
  );

/**
 * Whether the tool's OWN contract has a `team_sid` body field (e.g.
 * create_api_key keys a new api-key to a team). The facade never lifts the
 * field out of those tools' arguments - it is entity data and reaches the
 * backend as declared.
 */
export function toolOwnsTeamSid(tool: ToolDefinition): boolean {
  return 'team_sid' in tool.inputSchema.shape;
}

/**
 * The tool's own inputSchema shape, plus `commit_token` on dangerous tools.
 * Added here rather than in the entity files so the preview-gate field stays
 * consistent and the entity files stay clean.
 */
export function registeredShape(tool: ToolDefinition): z.ZodRawShape {
  return tool.dangerous
    ? { ...tool.inputSchema.shape, commit_token: COMMIT_TOKEN }
    : tool.inputSchema.shape;
}

/**
 * The same contract as a parseable object, for callers that hold the args:
 * STRICT at every level. Zod objects strip unknown keys by default, so until
 * 2026-09-16 both entry points dropped a misspelled or mis-shaped key in
 * silence: `filter: {"linkedin_account_sid.eq": "..."}` (the dotted shorthand
 * an older description showed) parsed to an EMPTY filter, a top-level `q`
 * vanished, and the call succeeded against the whole team's rows with
 * applied_filters {} (the MCP audit report, items 1 and 2). An unknown key is
 * now the 422 the backend itself would answer, with a hint naming the shape.
 * Objects declared `.passthrough()` keep it: those are the free-form bodies
 * (custom request payloads, step args) whose keys are the caller's to choose.
 */
export function callableSchema(tool: ToolDefinition): z.AnyZodObject {
  return deepStrict(z.object(registeredShape(tool))) as z.AnyZodObject;
}

/** Rebuild a schema so every strip-mode object under it refuses unknown keys. */
export function deepStrict<T extends z.ZodTypeAny>(schema: T): T {
  const def = schema._def as unknown as { typeName?: string } & Record<string, unknown>;
  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const object = schema as unknown as z.AnyZodObject;
      if (object._def.unknownKeys === 'passthrough') return schema;
      const shape: z.ZodRawShape = {};
      for (const [key, value] of Object.entries(object.shape as z.ZodRawShape)) shape[key] = deepStrict(value);
      return new z.ZodObject({ ...object._def, shape: () => shape, unknownKeys: 'strict' }) as unknown as T;
    }
    case z.ZodFirstPartyTypeKind.ZodOptional:
    case z.ZodFirstPartyTypeKind.ZodNullable:
      return new (schema.constructor as new (d: unknown) => T)({ ...def, innerType: deepStrict(def.innerType as z.ZodTypeAny) });
    case z.ZodFirstPartyTypeKind.ZodDefault:
      return new z.ZodDefault({ ...(def as unknown as z.ZodDefaultDef), innerType: deepStrict(def.innerType as z.ZodTypeAny) }) as unknown as T;
    case z.ZodFirstPartyTypeKind.ZodEffects:
      return new z.ZodEffects({ ...(def as unknown as z.ZodEffectsDef), schema: deepStrict(def.schema as z.ZodTypeAny) }) as unknown as T;
    case z.ZodFirstPartyTypeKind.ZodArray:
      return new z.ZodArray({ ...(def as unknown as z.ZodArrayDef), type: deepStrict(def.type as z.ZodTypeAny) }) as unknown as T;
    case z.ZodFirstPartyTypeKind.ZodUnion:
      return new z.ZodUnion({ ...(def as unknown as z.ZodUnionDef), options: (def.options as z.ZodTypeAny[]).map(deepStrict) as never }) as unknown as T;
    case z.ZodFirstPartyTypeKind.ZodDiscriminatedUnion: {
      const d = def as unknown as z.ZodDiscriminatedUnionDef<string>;
      return z.discriminatedUnion(d.discriminator, d.options.map((o) => deepStrict(o)) as never) as unknown as T;
    }
    case z.ZodFirstPartyTypeKind.ZodIntersection:
      return new z.ZodIntersection({ ...(def as unknown as z.ZodIntersectionDef), left: deepStrict(def.left as z.ZodTypeAny), right: deepStrict(def.right as z.ZodTypeAny) }) as unknown as T;
    case z.ZodFirstPartyTypeKind.ZodRecord:
      return new z.ZodRecord({ ...(def as unknown as z.ZodRecordDef), valueType: deepStrict(def.valueType as z.ZodTypeAny) }) as unknown as T;
    default:
      return schema;
  }
}

// What an unknown key most likely meant, so the 422 repairs itself in one
// turn. Dotted `field.op` keys are the shorthand older descriptions used to
// print; a top-level `q` is the full-text filter placed one level too high.
const TOOL_KEY_HINTS: Record<string, Record<string, string>> = {
  update_linkedin_account_smart_limit: {
    smart_limits_enabled: 'the account-wide switch is not a limit-row field: call set_linkedin_account_smart_limits with {"enabled": true|false}',
  },
};

export function unknownKeyHint(tool: ToolDefinition, path: PropertyKey[], key: string): string {
  const specific = TOOL_KEY_HINTS[tool.name]?.[key];
  if (specific) return `unknown key "${key}": ${specific}`;
  const dotted = /^([A-Za-z0-9_]+)\.([a-z_]+)$/.exec(key);
  if (dotted) {
    const [, field, op] = dotted;
    const where = path.length === 0 ? 'filter' : path.join('.');
    return `unknown key "${key}": filters are nested objects, not dotted keys; write ${where}: {"${field}": {"${op}": <value>}}`;
  }
  if (path.length === 0 && key === 'q') {
    return 'unknown key "q": the text search is a filter field, write filter: {"q": "<text>"}';
  }
  const where = path.length === 0 ? 'a parameter' : `a field of ${path.join('.')}`;
  return `unknown key "${key}": not ${where} of ${tool.name}; read the schema (get_toolset_tools with verbose:true) and drop or rename it`;
}

/**
 * A Zod failure rendered as the backend's own validation_failed envelope
 * (McpException::render). Same code, same field_errors shape and the same
 * prose as the `validation_failed` branch of error-map.ts, so an agent cannot
 * tell a locally rejected call from a backend-rejected one and needs no second
 * recovery strategy. `context.source` is the one field that differs, so a
 * caller CAN tell them apart without parsing prose.
 */
export function validationFailedResult(tool: ToolDefinition, error: z.ZodError): ToolResult {
  const fieldErrors: Record<string, Array<{ rule: string; message: string }>> = {};
  const lines = [`Validation failed for ${tool.name}:`];

  for (const issue of error.issues) {
    const field = issue.path.length ? issue.path.join('.') : '(root)';
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        const message = unknownKeyHint(tool, issue.path, key);
        (fieldErrors[field] ??= []).push({ rule: 'unknown_key', message });
        lines.push(`  • ${field}: ${message} [unknown_key]`);
      }
      continue;
    }
    (fieldErrors[field] ??= []).push({ rule: issue.code, message: issue.message });
    lines.push(`  • ${field}: ${issue.message} [${issue.code}]`);
  }
  lines.push('Fix the arguments against the tool schema and call again. Nothing was sent to the backend.');

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    isError: true,
    structuredContent: {
      success: false,
      error: {
        code: 'validation_failed',
        message: `The arguments do not match the schema of ${tool.name}.`,
        recoverable: true,
        suggestion: 'Read the tool schema (get_toolset_tools with verbose:true) and correct the arguments.',
        field_errors: fieldErrors,
        context: { source: 'mcp_runtime', tool: tool.name },
      },
    },
  };
}
