// What every entity file of @gtm/mcp-email shares: the field that names the
// email server a call is for, the route builder that lifts it into its header,
// and the small request helpers.
//
// A workspace may own several email servers (email boxes, em_bx_*, the registry
// is gtm.service.id's email_boxes), and each server is its own deployment of
// gtm.service.email with its own database. One public prefix serves them all:
// the gateway reads the `Email-Box-SID` header and routes the request to that
// server, and a request that names none lands on the primary server of the
// token's workspace. So every email tool takes an optional `email_box_sid`,
// described once (here) and bound once (emailRoute): the runtime takes it out
// of the body and the query and sends it as the header (route.headerParams).

import { z } from 'zod';
import type { HttpMethod, RouteMeta } from '@gtm/mcp-runtime/types';
import { filterOp, McpMetricsResponse, McpSearchRequestSchema, usageMetaField } from '@gtm/mcp-shared';

export const EMAIL_BOX_HEADER = 'Email-Box-SID';

/**
 * The server a call is for. Short on purpose: it rides the schema of every
 * email tool, so the long form is in each email mount's instructions.
 */
export const emailBoxField = {
  email_box_sid: z.string().regex(/^em_bx_[A-Za-z0-9]{12}$/).optional()
    .describe('Email server (em_bx_...) the call is for, from search_email_boxes. Omitted: the primary server.'),
} as const;

/** The server field and `_meta`: the tail of every email input schema. */
export const emailCommon = { ...emailBoxField, ...usageMetaField } as const;

/** A route of gtm.service.email. `{sid}` binds to `sid`; the server field becomes its header. */
export const emailRoute = (method: HttpMethod, pathTemplate: string): RouteMeta => ({
  service: 'email',
  method,
  pathTemplate,
  ...(pathTemplate.includes('{sid}') ? { sidParam: 'sid' } : {}),
  headerParams: { [EMAIL_BOX_HEADER]: 'email_box_sid' },
});

/** A prefixed sid: 18 characters, e.g. sid('em_ac_'). */
export const sid = (prefix: string) => z.string().length(18).startsWith(prefix);

type Ops = Parameters<typeof filterOp>[1];

/** A string filter field (a sid, an address, a code) with the operators the backend applies. */
export const str = (ops: Ops) => filterOp(z.string(), ops).optional();
/** A timestamp filter field, ISO 8601. */
export const when = (ops: Ops = ['gte', 'lte', 'gt', 'lt']) => filterOp(z.string(), ops).optional();
/** An enum filter field. */
export const oneOf = <E extends z.ZodEnum<[string, ...string[]]>>(values: E, ops: Ops = ['eq', 'ne', 'in', 'nin']) =>
  filterOp(values, ops).optional();

/**
 * The input of a search tool: the shared request (filter, sort, page_size 0..500,
 * cursor) plus the server field. `include` is offered only where the route
 * builds an included block; a route with no include rule refuses the key.
 */
export function searchInput<F extends z.ZodTypeAny>(
  filter: F,
  sortable: z.ZodEnum<[string, ...string[]]>,
  include?: z.ZodEnum<[string, ...string[]]>,
) {
  const request = McpSearchRequestSchema(filter, include, sortable).extend(emailBoxField);
  return include ? request : request.omit({ include: true });
}

/** The window of a metrics call. Required on every email metrics route. */
export const period = z.object({
  from: z.string().describe('ISO 8601 UTC, inclusive.'),
  to: z.string().describe('ISO 8601 UTC, exclusive; after from.'),
}).describe('The metrics window [from, to).');

/**
 * The shared metrics envelope with this service's blocks typed. Every email
 * metrics route answers `metrics: { period, aggregated: { counts, metrics } }`
 * beside `applied_filters`; `groups` is typed only where the route builds it
 * (the others accept group_by and answer no groups, so their tools do not
 * offer it).
 */
export function metricsResponse(metrics: z.AnyZodObject, counts: z.ZodTypeAny, group?: z.ZodTypeAny) {
  const envelope = McpMetricsResponse(metrics);
  return envelope.extend({
    metrics: envelope.shape.metrics.extend({
      period: z.object({ from: z.string(), to: z.string() }).passthrough(),
      aggregated: z.object({ counts, metrics }).passthrough(),
      ...(group ? { groups: z.array(group).optional().describe('Only when group_by was passed.') } : {}),
    }),
  });
}

// ─── values a request names ─────────────────────────────────────────────
// The bounds are the Value classes' own (gtm.lib.common EmailAccount/Values).
// A Value is replaced whole: a key left out falls back to the service default,
// not to what the row held, so each of these requires every key.

export const SendingWindowInput = z.object({
  time_zone: z.string().max(64).describe('IANA time zone, e.g. Europe/Berlin.'),
  days: z.array(z.number().int().min(1).max(7)).min(1).max(7).describe('ISO weekdays, 1 Monday to 7 Sunday.'),
  start: z.string().describe('HH:MM.'),
  end: z.string().describe('HH:MM.'),
});

export const WarmupConfigInput = z.object({
  enabled: z.boolean(),
  ramp_start_daily: z.number().int().min(1).max(100),
  ramp_step_per_day: z.number().int().min(1).max(50),
  target_daily: z.number().int().min(5).max(2000),
});

export const SendingLimitsInput = z.object({
  daily_limit: z.number().int().min(1).max(2000),
  min_interval_seconds: z.number().int().min(0).max(3600),
  sending_window: SendingWindowInput.nullable().describe('null: send at any time.'),
});

export const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
/** A read that dials the mailbox's provider or public DNS. */
export const RO_OPEN = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
