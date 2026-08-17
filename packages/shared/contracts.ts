// Shared MCP contracts for gtm-api.com.
//
// Runtime Zod schemas referenced from every entity's `mcp-tools.ts`. They
// mirror the backend ground truth in gtm.lib.common/src/Core:
//   - Traits/McpResponds.php     (response envelopes)
//   - Http/McpFormRequest.php    (request params: page_size, filter, sort, ...)
//   - Enums/McpErrorCode.php     (16-code error taxonomy)
// When the backend contract evolves, update this file in lockstep and let the
// coverage/contract tests catch drift.

import { z } from 'zod';
import { UsageMetaSchema } from './usage-meta';

// ═══════════════════════════════════════════════════════════════════════
// 1. Observability meta - present on every SUCCESS envelope
// ═══════════════════════════════════════════════════════════════════════

export const McpEnvelopeMeta = z.object({
  trace_id: z.string()
    .describe('UUID v7; same 128-bit value as the X-Trace-Id header.'),
  span_id: z.string().regex(/^[0-9a-f]{16}$/)
    .describe('16 hex chars, root span of this request.'),
  timestamp: z.string()
    .describe('ISO 8601 UTC (Y-m-dTH:i:sZ), response time.'),
  duration_ms: z.number().int().nonnegative()
    .describe('Server-side wall clock.'),
  debug_url: z.string()
    .describe('Deep link to the post-call analysis UI.'),
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Search / Get / Create / Update response envelopes
// ═══════════════════════════════════════════════════════════════════════

export const McpPagination = z.object({
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
  total_count: z.number().int().nullable(),
});

export const McpSearchResponse = <
  T extends z.ZodTypeAny,
  I extends z.ZodTypeAny = z.ZodRecord<z.ZodString, z.ZodUnknown>,
  C extends z.ZodTypeAny = z.ZodRecord<z.ZodString, z.ZodUnknown>,
>(itemSchema: T, includedSchema?: I, countsSchema?: C) =>
  z.object({
    success: z.literal(true),
    operation: z.literal('search'),
    items: z.array(z.object({
      item: itemSchema,
      included: (includedSchema ?? z.record(z.unknown())) as I,
    })),
    pagination: McpPagination,
    applied_filters: z.record(z.unknown()),
    includes: z.array(z.string()),
    meta: McpEnvelopeMeta,
    // Top-level sibling; backend emits it only when a counts extractor is set.
    counts: ((countsSchema ?? z.record(z.unknown())) as C).optional(),
  });

export const McpGetResponse = <
  T extends z.ZodTypeAny,
  I extends z.ZodTypeAny = z.ZodRecord<z.ZodString, z.ZodUnknown>,
>(itemSchema: T, includedSchema?: I) =>
  z.object({
    success: z.literal(true),
    operation: z.literal('get'),
    item: itemSchema,
    included: (includedSchema ?? z.record(z.unknown())) as I,
    includes: z.array(z.string()),
    meta: McpEnvelopeMeta,
  });

export const McpCreateResponse = <T extends z.ZodTypeAny>(itemSchema: T) =>
  z.object({
    success: z.literal(true),
    operation: z.literal('create'),
    item: itemSchema,
    already_exists: z.boolean(),
    meta: McpEnvelopeMeta,
  });

export const McpUpdateResponse = <T extends z.ZodTypeAny>(itemSchema: T) =>
  z.object({
    success: z.literal(true),
    operation: z.literal('update'),
    item: itemSchema,
    updated_fields: z.array(z.string()),
    previous_values: z.record(z.unknown()),
    meta: McpEnvelopeMeta,
  });

// ─── Delete ─────────────────────────────────────────────────────────────

export const McpSimpleDeleteResponse = z.object({
  success: z.literal(true),
  operation: z.literal('delete'),
  item: z.record(z.unknown()),
  already_deleted: z.boolean(),
  soft_deleted: z.boolean(),
  retained: z.array(z.string()),
  meta: McpEnvelopeMeta,
});

export const BlockerSeverity = z.enum(['hard', 'soft']);

export const DeleteBlocker = z.object({
  type: z.string()
    .describe('Machine-readable blocker type (active_flow, pending_tasks, …).'),
  severity: BlockerSeverity
    .describe('hard = external action required; soft = acknowledge is enough.'),
  description: z.string(),
  entity_sid: z.string().nullable(),
  count: z.number().int().optional(),
  resolution: z.string()
    .describe('Hard: tool name to call. Soft: code for acknowledge[].'),
  resolution_hint: z.string(),
});

// delete_blocked is emitted as an ERROR envelope, but (unlike other errors)
// it carries `meta` and puts blockers at error.blockers (not error.context).
export const McpDeleteBlockedResponse = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.literal('delete_blocked'),
    message: z.string(),
    recoverable: z.boolean(),
    blockers: z.array(DeleteBlocker),
  }),
  meta: McpEnvelopeMeta,
});

export const CascadeDetail = z.object({
  entity: z.string(),
  deleted: z.number().int(),
  cancelled: z.number().int().optional(),
});

export const McpCascadeDeleteResponse = z.object({
  success: z.literal(true),
  operation: z.literal('delete'),
  item: z.record(z.unknown()),
  already_deleted: z.boolean(),
  soft_deleted: z.boolean(),
  cascade: z.object({
    summary: z.string(),
    details: z.array(CascadeDetail),
    recovery_available_until: z.string().nullable(),
  }).nullable(),
  meta: McpEnvelopeMeta,
});

// ─── Metrics & Group-by ─────────────────────────────────────────────────

// The backend nests the metrics payload. `response.metrics` is a service-local
// envelope: { filter?, period, aggregated: { counts, metrics? }, metrics? }.
// The entity's leaf metric object lives at DIFFERENT depths per service:
//   - linkedin: response.metrics.metrics
//   - id:       response.metrics.aggregated.metrics
// Accept either location, validating the leaf where it appears; the counts
// block (with its group breakdowns) rides in aggregated.counts.
export const McpMetricsResponse = <M extends z.ZodTypeAny>(metricsSchema: M) =>
  z.object({
    success: z.literal(true),
    operation: z.literal('metrics'),
    metrics: z.object({
      filter: z.record(z.unknown()).optional(),
      period: z.object({ from: z.string(), to: z.string() }).passthrough().optional(),
      aggregated: z.object({
        counts: z.record(z.unknown()).optional(),
        metrics: metricsSchema.optional(),
      }).passthrough().optional(),
      metrics: metricsSchema.optional(),
    }).passthrough(),
    applied_filters: z.record(z.unknown()).optional(),
    meta: McpEnvelopeMeta,
  });

export const McpGroupByGroup = z.object({
  value: z.union([z.string(), z.number(), z.null()]),
  count: z.number().int(),
});

export const McpGroupByResponse = z.object({
  success: z.literal(true),
  operation: z.literal('group_by'),
  field: z.string(),
  groups: z.array(McpGroupByGroup),
  total: z.number().int(),
  applied_filters: z.record(z.unknown()),
  available_fields: z.array(z.string()),
  meta: McpEnvelopeMeta,
});

// ═══════════════════════════════════════════════════════════════════════
// 3. Action envelopes + async pending refs (§10)
// ═══════════════════════════════════════════════════════════════════════

// 2026-08-16: credits left the platform. No envelope carries a credits block,
// CreditsSpentValue is gone from gtm.lib.common, and GetSales reconciles off
// POST /api/data-requests/search (kind=enrich, status=completed,
// served_from_cache=false).

// pending[] ref emitted by mcpAsyncAction. The backend contract is
// {activity_log_sid, expected_completion_seconds, webhook_events[]}; kept
// permissive (passthrough) so richer refs (embedded progress rows) still parse.
export const PendingRef = z.object({
  activity_log_sid: z.string().optional(),
  expected_completion_seconds: z.number().int().nonnegative(),
  webhook_events: z.array(z.string()),
}).passthrough();

export const McpActionResponse = <
  I extends z.ZodTypeAny = z.ZodRecord<z.ZodString, z.ZodUnknown>,
  R extends z.ZodTypeAny = z.ZodRecord<z.ZodString, z.ZodUnknown>,
>(itemSchema?: I, resultSchema?: R) =>
  z.object({
    success: z.literal(true),
    operation: z.literal('action'),
    action: z.string()
      .describe('kebab-case verb; matches the route segment.'),
    item: ((itemSchema ?? z.record(z.unknown())) as I).nullable(),
    result: (resultSchema ?? z.record(z.unknown())) as R,
    meta: McpEnvelopeMeta,
  });

export const McpAsyncActionResponse = <
  I extends z.ZodTypeAny = z.ZodRecord<z.ZodString, z.ZodUnknown>,
  R extends z.ZodTypeAny = z.ZodRecord<z.ZodString, z.ZodUnknown>,
>(itemSchema?: I, resultSchema?: R) =>
  z.object({
    success: z.literal(true),
    operation: z.literal('action'),
    action: z.string(),
    async: z.literal(true),
    item: ((itemSchema ?? z.record(z.unknown())) as I).nullable(),
    pending: z.array(PendingRef),
    result: (resultSchema ?? z.record(z.unknown())) as R,
    meta: McpEnvelopeMeta,
  });

// ═══════════════════════════════════════════════════════════════════════
// 4. Error envelope - 16-code taxonomy (McpErrorCode.php)
// ═══════════════════════════════════════════════════════════════════════

export const McpErrorCode = z.enum([
  'validation_failed',   // 422
  'nothing_to_update',   // 422
  'not_found',           // 404
  'relation_not_found',  // 422
  'invalid_transition',  // 409
  'limit_exceeded',      // 429
  'payment_required',    // 402
  'duplicate_rejected',  // 409
  'conflict',            // 409
  'delete_blocked',      // 409
  'unauthorized',        // 401
  'forbidden',           // 403
  'rate_limited',        // 429
  'internal_error',      // 500
  'service_unavailable', // 503
  'not_implemented',     // 501
]);

export type McpErrorCodeValue = z.infer<typeof McpErrorCode>;

export const McpFieldError = z.object({
  rule: z.string(),
  message: z.string(),
});

export const McpErrorResponse = z.object({
  success: z.literal(false),
  error: z.object({
    code: McpErrorCode,
    message: z.string(),
    recoverable: z.boolean(),
    suggestion: z.string().optional(),
    // Two backend shapes: FormRequest validation → [{rule, message}]; a manual
    // McpException::invalidInput(field, reason) → [reason:string]. Accept both.
    field_errors: z.record(z.array(z.union([z.string(), McpFieldError]))).optional(),
    blockers: z.array(DeleteBlocker).optional(),
    context: z.record(z.unknown()).optional(),
  }),
  // Present on delete_blocked; absent on most errors - hence optional.
  meta: McpEnvelopeMeta.optional(),
});

// ═══════════════════════════════════════════════════════════════════════
// 5. Request builders
// ═══════════════════════════════════════════════════════════════════════
// Conventions (McpFormRequest.php): pagination is `page_size` (default 50;
// `limit` is a deprecated alias, never emitted here) + opaque `cursor`.
// The CEILING is per entity, not global: `McpFormRequest::pageSize()` clamps at
// 500, but the owning {Entity}SearchRequest is what actually validates, and it
// caps at 100, 200, 500 or 1000 depending on how heavy the table is. Whatever
// that FormRequest says has to be what the tool advertises - a schema promising
// 500 against a max:200 route hands the agent a 422 it could not predict - so
// `maxPageSize` is passed per tool and the request-parity gate checks it.
// Full-text search is `filter.q` (a reserved string field inside the filter
// object), NOT a top-level param, so it belongs in each entity's filterSchema.
// `_meta` (usage analytics) is optional on every input.

export const SortDirection = z.enum(['asc', 'desc']);

export const McpSearchRequestSchema = <
  F extends z.ZodTypeAny,
  I extends z.ZodEnum<[string, ...string[]]> | undefined = undefined,
  S extends z.ZodEnum<[string, ...string[]]> | undefined = undefined,
>(
  filterSchema: F,
  includeEnum?: I,
  sortableEnum?: S,
  maxPageSize = 500,
) =>
  z.object({
    filter: filterSchema.optional(),
    include: z.array((includeEnum ?? z.string()) as z.ZodTypeAny).optional()
      .describe('Relations to eager-load (see entity Includes).'),
    sort: z.object({
      field: (sortableEnum ?? z.string()) as z.ZodTypeAny,
      direction: SortDirection.optional().describe('Default desc.'),
    }).optional(),
    page_size: z.number().int().min(0).max(maxPageSize).optional()
      .describe(`0..${maxPageSize}, default 50. page_size=0 = count-only, page_size=1 = getFirst.`),
    cursor: z.string().nullable().optional()
      .describe('Opaque forward cursor from a previous response pagination.next_cursor.'),
    _meta: UsageMetaSchema.optional(),
  });

export const McpGetRequestSchema = <
  I extends z.ZodEnum<[string, ...string[]]> | undefined = undefined,
>(
  sidPrefix: string,
  includeEnum?: I,
) =>
  z.object({
    sid: z.string().length(18).startsWith(sidPrefix),
    include: z.array((includeEnum ?? z.string()) as z.ZodTypeAny).optional(),
    _meta: UsageMetaSchema.optional(),
  });

export const McpMetricsRequestSchema = <F extends z.ZodTypeAny>(filterSchema: F) =>
  z.object({
    filter: filterSchema.optional(),
    _meta: UsageMetaSchema.optional(),
  });

export const McpGroupByRequestSchema = <
  E extends z.ZodEnum<[string, ...string[]]>,
  F extends z.ZodTypeAny,
>(fieldEnum: E, filterSchema: F) =>
  z.object({
    field: fieldEnum,
    filter: filterSchema.optional(),
    _meta: UsageMetaSchema.optional(),
  });

export const McpSimpleDeleteRequestSchema = (sidPrefix: string) =>
  z.object({
    sid: z.string().length(18).startsWith(sidPrefix),
    _meta: UsageMetaSchema.optional(),
  });

// `acknowledge` codes are per entity: the route that restricts them with an
// `in:` rule has to pass its own enum, because a 422 on a resolution code the
// caller invented never says which codes exist.
export const McpCascadeDeleteRequestSchema = <
  A extends z.ZodEnum<[string, ...string[]]> | undefined = undefined,
>(sidPrefix: string, acknowledgeEnum?: A) =>
  z.object({
    sid: z.string().length(18).startsWith(sidPrefix),
    acknowledge: z.array((acknowledgeEnum ?? z.string()) as z.ZodTypeAny).optional()
      .describe('Resolution codes for soft blockers the user confirmed.'),
    _meta: UsageMetaSchema.optional(),
  });

// ═══════════════════════════════════════════════════════════════════════
// 6. Filter operators (McpFormRequest FilterOp::ALL_OPS)
// ═══════════════════════════════════════════════════════════════════════
// Each filter field is an object with a fixed set of operators. `in`/`nin`
// take arrays; `is_null` takes a boolean. Multiple ops on one field = AND.
// Bare scalar shorthand is accepted by the backend and normalizes to {eq}.

export type FilterOpKey =
  | 'eq' | 'ne' | 'in' | 'nin' | 'gte' | 'lte' | 'gt' | 'lt' | 'is_null';

// Structurally identical filterOp() results are memoized to ONE shared Zod
// instance. Semantics are unchanged (same shape, same parsing); what changes
// is the advertised JSON schema: zod-to-json-schema deduplicates by instance,
// so the 14 timestamp fields of a search filter serialize as one full object
// plus 13 `$ref`s instead of 14 identical inline blocks. Measured on
// search_linkedin_accounts this is ~20% of the tool's wire size; ToolSearch
// loads these schemas into the copilot's context, so wire bytes are tokens.
// The key covers the value schema's type, checks, enum values and description;
// anything it cannot represent gets a unique key and stays unshared (the
// pre-memo behavior). Bump FILTER_OP_KEY_REV when the key shape changes.
const FILTER_OP_CACHE = new Map<string, z.ZodTypeAny>();
let filterOpNonce = 0;

function filterOpKey(value: z.ZodTypeAny, allowed: ReadonlyArray<FilterOpKey>): string {
  const def = value._def as {
    typeName?: string;
    checks?: unknown;
    values?: unknown;
    description?: string;
  };
  if (!def.typeName) return `nonce:${filterOpNonce++}`;
  // Wrapped types (optional/nullable/effects) hide their inner structure from
  // this key; give them unique keys rather than guessing.
  if (['ZodOptional', 'ZodNullable', 'ZodEffects', 'ZodLazy', 'ZodUnion'].includes(def.typeName)) {
    return `nonce:${filterOpNonce++}`;
  }
  try {
    return JSON.stringify({
      t: def.typeName,
      c: def.checks ?? null,
      v: def.values ?? null,
      d: def.description ?? null,
      ops: allowed,
    });
  } catch {
    return `nonce:${filterOpNonce++}`;
  }
}

export function filterOp<V extends z.ZodTypeAny>(
  value: V,
  allowed: ReadonlyArray<FilterOpKey>,
) {
  const key = filterOpKey(value, allowed);
  const cached = FILTER_OP_CACHE.get(key);
  if (cached) return cached as ReturnType<typeof buildFilterOp<V>>;
  const built = buildFilterOp(value, allowed);
  FILTER_OP_CACHE.set(key, built);
  return built;
}

function buildFilterOp<V extends z.ZodTypeAny>(
  value: V,
  allowed: ReadonlyArray<FilterOpKey>,
) {
  const shape: Record<string, z.ZodTypeAny> = {};
  if (allowed.includes('eq'))      shape.eq = value;
  if (allowed.includes('ne'))      shape.ne = value;
  if (allowed.includes('in'))      shape.in = z.array(value);
  if (allowed.includes('nin'))     shape.nin = z.array(value);
  if (allowed.includes('gte'))     shape.gte = value;
  if (allowed.includes('lte'))     shape.lte = value;
  if (allowed.includes('gt'))      shape.gt = value;
  if (allowed.includes('lt'))      shape.lt = value;
  if (allowed.includes('is_null')) shape.is_null = z.boolean();
  return z.object(shape).partial().strict();
}

// ═══════════════════════════════════════════════════════════════════════
// 7. Shared cross-domain Value objects
// ═══════════════════════════════════════════════════════════════════════

// Core\Enums\ActorType, verbatim and in its order. It is the ONE spelling of
// this enum on our side: every entity's created_by / deleted_by / ended_by /
// canceled_by / actor block imports it rather than restating the list, because
// the restated copies are how `mcp_agent` (a value AccessIdentityValue::validate()
// rejects) and three different spellings of the same four cases got in.
export const AccessIdentityValueActorTypeEnum = z.enum([
  'user',
  'support',
  'api_key',
  'system',
  'agent',
]);

// Core\Enums\HandoverRoleEnum. Which side of a share or transfer a row sits on.
// It is shared because the sharing rework put a nullable `share_role` on the
// CHANNEL entities too (LinkedinAccountDomain, AntidetectBrowserDomain), not
// only on the account_shares row in gtm.service.id.
export const HandoverRoleEnum = z.enum([
  'owner',
  'holder',
  'giver',
  'receiver',
]);

// Live serialization (confirmed against both services): `permissions` is an
// object map ({ tokens: [...], allowed_account_sids: ... }), NOT a string
// array; `request_sid` is often absent; and extra keys (cluster_id, trace_id)
// appear. Permissive + passthrough to match the real envelope everywhere.
export const AccessIdentityValue = z.object({
  actor_type: AccessIdentityValueActorTypeEnum,
  actor_sid: z.string().nullable(),
  team_sid: z.string(),
  permissions: z.record(z.unknown()),
  request_sid: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
}).passthrough();
