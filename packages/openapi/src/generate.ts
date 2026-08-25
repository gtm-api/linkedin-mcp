// Build the public OpenAPI documents from the Zod tool registry.
//
// The registry (packages/mcp.{service}/{entity}/mcp-tools.ts) is the single
// source of truth for the external contract, so this file only PROJECTS it:
//
//   route.method + route.pathTemplate  ->  path item + operation
//   inputSchema                        ->  path params, query params (GET and
//                                          DELETE) or the JSON request body
//   outputSchema                       ->  the 200 response
//   description / annotations / flags  ->  summary, description, x- extensions
//
// Nothing is hand-maintained per endpoint. If an operation is wrong here, the
// tool definition is wrong; fix it there and regenerate.
//
// Exclusions, in the order they are applied (all are reported, never silent):
//   - a tool with a localHandler (the support knowledge base: it runs
//     inside the worker and has no backend route to publish);
//   - a route outside `/api/` (the `/internal` and `/local` surfaces);
//   - a route the contract oracle marks internal (belt and braces: the registry
//     is public-only by construction, and the coverage gate already proves it).
//
// `availability: 'stub_501'` tools are KEPT and marked `deprecated: true` with
// the reason, because their request contract is final and integrators are meant
// to build against it before the backend ships the verb.

import type { ToolDefinition, ToolPackage } from '@gtm/mcp-runtime/types';
import { linkedinPackages } from '@gtm/mcp-linkedin';
import { idPackages } from '@gtm/mcp-id';
import { orchestrationPackages } from '@gtm/mcp-orchestration';
import { supportPackages } from '@gtm/mcp-support';
import { McpErrorResponse } from '@gtm/mcp-shared';
import { convertSchema, type JsonSchema } from './schema';
import {
  CONTACT,
  LICENSE,
  PUBLIC_SERVICES,
  SERVICE_META,
  SPEC_VERSION,
  type PublicServiceId,
} from './services';

const ALL_PACKAGES: ToolPackage[] = [
  ...linkedinPackages,
  ...idPackages,
  ...orchestrationPackages,
  ...supportPackages,
];

// `_meta` is usage analytics consumed by the MCP worker and stripped before the
// backend call (runtime/src/url.ts), so it is not part of the HTTP contract.
const NON_WIRE_INPUT_FIELDS = new Set(['_meta']);

const STUB_REASON =
  'Not shipped yet. The registry marks this route availability=stub_501: the backend validates the whole request and then answers 501 not_implemented. The request contract is final, so integrations can be written and tested against it today. Marked deprecated so generated clients flag it at compile time; this is a NOT-YET flag, not a sunset.';

export interface ExcludedTool {
  tool: string;
  service: string;
  route: string;
  reason: string;
}

export interface GeneratedDocument {
  service: PublicServiceId;
  document: JsonSchema;
  operations: number;
  deprecated: number;
}

export interface GenerationReport {
  documents: GeneratedDocument[];
  excluded: ExcludedTool[];
  /** Schemas that had to degrade to an open object, with the converter's reason. */
  fallbacks: string[];
}

const pascal = (name: string): string =>
  name
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');

// Code-unit order, NOT localeCompare: the sort has to give the same answer on
// every machine or the drift check fails wherever CI's ICU locale differs from
// the author's.
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const sortKeys = <T>(record: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(record).sort(([a], [b]) => byName(a, b)));

const pathVariables = (template: string): string[] =>
  [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);

/** {var} in the path -> the input field that fills it (registry invariant). */
const pathBindings = (tool: ToolDefinition): Map<string, string> => {
  const bindings = new Map<string, string>();
  for (const variable of pathVariables(tool.route.pathTemplate)) {
    bindings.set(
      variable,
      variable === 'sid' ? tool.route.sidParam ?? 'sid' : (tool.route.pathParams ?? {})[variable],
    );
  }
  return bindings;
};

const flagSentences = (tool: ToolDefinition): string[] => {
  const flags: string[] = [];
  if (tool.annotations.readOnlyHint) flags.push('read only');
  if (tool.dangerous) {
    flags.push(
      'dangerous: the MCP layer gates it behind a preview/commit token, and the effect cannot be undone through this API',
    );
  }
  if (tool.massAction) {
    flags.push(
      "mass action: this verb's own request accepts a filter or targets[] set, which the owning service drains",
    );
  }
  if (tool.stepEligible) {
    flags.push(
      'step eligible: gtm.service.orchestration can run this verb as a mass-action plan step, once per item',
    );
  }
  if (tool.scheduleRequired) {
    flags.push('schedule required: bulk use of this verb MUST be paced, an unpaced plan is rejected');
  }
  return flags;
};

const operationDescription = (tool: ToolDefinition): string => {
  const lines: string[] = [tool.description.trim(), ''];
  if (tool.availability === 'stub_501') lines.push(STUB_REASON, '');
  lines.push('Contract:');
  lines.push(
    `- MCP tool \`${tool.name}\`, registry package \`mcp.${tool.service}/${tool.entity}\`, mount \`${tool.mount}\`.`,
  );
  lines.push(`- Operation \`${tool.operation}\`, response envelope \`${tool.envelope}\`.`);
  const flags = flagSentences(tool);
  lines.push(`- Flags: ${flags.length > 0 ? flags.join('; ') : 'none'}.`);
  if (tool.docsPath) lines.push(`- Entity reference: \`${tool.docsPath}\`.`);
  return lines.join('\n');
};

const extensions = (tool: ToolDefinition): JsonSchema => {
  const ext: JsonSchema = {
    'x-gtm-mcp-tool': tool.name,
    'x-gtm-mcp-mount': tool.mount,
    'x-gtm-entity': tool.entity,
    'x-gtm-operation': tool.operation,
    'x-gtm-envelope': tool.envelope,
    'x-gtm-availability': tool.availability,
    'x-gtm-dangerous': tool.dangerous,
    'x-gtm-mass-action': tool.massAction === true,
    'x-gtm-step-eligible': tool.stepEligible === true,
    'x-gtm-schedule-required': tool.scheduleRequired === true,
  };
  if (tool.toolClass) ext['x-gtm-tool-class'] = tool.toolClass;
  if (tool.availability === 'stub_501') ext['x-gtm-not-implemented-reason'] = STUB_REASON;
  return ext;
};

const SECURITY_SCHEMES: JsonSchema = {
  BearerJwt: {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description:
      'Access token issued by gtm.service.id. Its `access_identity` claim carries `team_sid`, `actor_sid` and `actor_type`, and that team scope is authoritative.',
  },
  TeamSid: {
    type: 'apiKey',
    in: 'header',
    name: 'Team-SID',
    description:
      'Team scope for tokens that do not carry one. Ignored when the token already names a team.',
  },
};

const infoDescription = (service: PublicServiceId, toolCount: number): string =>
  [
    SERVICE_META[service].summary,
    '',
    'GENERATED. This document is projected from the Zod MCP tool registry in `product/mcp/gtm.mcp` (one tool per public endpoint, 1:1). Do not edit it by hand; edit the tool definition and regenerate with `pnpm openapi:public`.',
    '',
    `Surface: the public \`/api\` contract of \`gtm.service.${service}\`, ${toolCount} operations. This is the only OpenAPI document the platform publishes. Internal (\`/internal\`) and health endpoints are deliberately absent: they are not part of any contract, they can change without notice, and the service source is their only description.`,
    '',
    'Conventions:',
    '- Auth is a bearer JWT, optionally narrowed by the `Team-SID` header.',
    '- Every success body is an MCP envelope: `success: true` plus one typed `operation` shape (`search`, `get`, `create`, `update`, `delete`, `metrics`, `group_by`, `action`), and a `meta` block with `trace_id` for support.',
    '- Every failure is the same `McpError` envelope with a code from a fixed 16-code taxonomy, so a client maps errors once.',
    '- Lists page with `page_size` (0 to 500, default 50) plus an opaque forward `cursor`; `page_size: 0` returns counts only.',
    '- On `GET` and `DELETE`, object-valued query parameters (`filter`, `sort`) travel as JSON text and array-valued ones repeat as `name[]=value`.',
    '- The MCP-only `_meta` field (usage analytics) never reaches the backend and is not part of this contract.',
  ].join('\n');

/** Every registered tool, and why it is in or out of the public contract. */
export function partitionTools(): {
  included: ToolDefinition[];
  excluded: ExcludedTool[];
} {
  const included: ToolDefinition[] = [];
  const excluded: ExcludedTool[] = [];
  for (const pkg of ALL_PACKAGES) {
    for (const tool of pkg.tools) {
      const route = `${tool.route.method} ${tool.route.pathTemplate}`;
      if (tool.localHandler) {
        excluded.push({
          tool: tool.name,
          service: tool.service,
          route,
          reason: 'local_handler: runs inside the MCP worker, there is no backend endpoint to publish',
        });
        continue;
      }
      if (!tool.route.pathTemplate.startsWith('/api/')) {
        excluded.push({
          tool: tool.name,
          service: tool.service,
          route,
          reason: 'not_public_api: the route is outside the /api surface',
        });
        continue;
      }
      if (!PUBLIC_SERVICES.includes(tool.service as PublicServiceId)) {
        excluded.push({
          tool: tool.name,
          service: tool.service,
          route,
          reason: 'no_public_service_document: the service has no public /api backend',
        });
        continue;
      }
      included.push(tool);
    }
  }
  return { included, excluded };
}

function buildDocument(
  service: PublicServiceId,
  tools: ToolDefinition[],
  fallbacks: string[],
): GeneratedDocument {
  const paths: Record<string, Record<string, unknown>> = {};
  const schemas: Record<string, JsonSchema> = {};
  const tags = new Map<string, string>();
  let deprecated = 0;

  const error = convertSchema('McpError', McpErrorResponse);
  if (error.fallbackReason) fallbacks.push(`${service} McpError: ${error.fallbackReason}`);
  schemas.McpError = error.schema;

  for (const tool of tools) {
    const name = pascal(tool.name);
    const bindings = pathBindings(tool);

    const input = convertSchema(`${name}Input`, tool.inputSchema);
    if (input.fallbackReason) fallbacks.push(`${tool.name} input: ${input.fallbackReason}`);
    const properties = (input.schema.properties ?? {}) as Record<string, JsonSchema>;
    const required = new Set((input.schema.required as string[] | undefined) ?? []);

    const consumed = new Set<string>([...NON_WIRE_INPUT_FIELDS, ...bindings.values()]);
    const wireFields = Object.keys(properties).filter((key) => !consumed.has(key));

    const parameters: JsonSchema[] = [];
    for (const [variable, field] of bindings) {
      const schema = properties[field] ?? { type: 'string' };
      parameters.push({
        name: variable,
        in: 'path',
        required: true,
        description: (schema.description as string | undefined) ?? `Path segment \`{${variable}}\`.`,
        schema,
      });
    }

    let requestBody: JsonSchema | undefined;
    const isQueryVerb = tool.route.method === 'GET' || tool.route.method === 'DELETE';

    if (isQueryVerb) {
      // Mirrors runtime/src/url.ts buildRequest(): declared queryParams if the
      // route pins them, otherwise every remaining input field.
      for (const field of tool.route.queryParams ?? wireFields) {
        const schema = properties[field];
        if (!schema) continue;
        const shared = {
          in: 'query',
          required: required.has(field),
          description: (schema.description as string | undefined) ?? `Query parameter \`${field}\`.`,
        };
        if (schema.type === 'array') {
          parameters.push({ name: `${field}[]`, ...shared, style: 'form', explode: true, schema });
        } else if (schema.type === 'object' || 'properties' in schema || 'additionalProperties' in schema) {
          // buildRequest JSON-encodes object values into a single query value.
          parameters.push({ name: field, ...shared, content: { 'application/json': { schema } } });
        } else {
          parameters.push({ name: field, ...shared, schema });
        }
      }
    } else if (wireFields.length > 0) {
      const bodyRequired = wireFields.filter((field) => required.has(field));
      const bodySchema: JsonSchema = {
        type: 'object',
        description: `Request body of \`${tool.name}\`.`,
        properties: Object.fromEntries(wireFields.map((field) => [field, properties[field]])),
      };
      if (bodyRequired.length > 0) bodySchema.required = bodyRequired;
      if (input.schema.additionalProperties !== undefined) {
        bodySchema.additionalProperties = input.schema.additionalProperties;
      }
      schemas[`${name}Request`] = bodySchema;
      requestBody = {
        required: bodyRequired.length > 0,
        content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}Request` } } },
      };
    }

    const output = convertSchema(`${name}Response`, tool.outputSchema);
    if (output.fallbackReason) fallbacks.push(`${tool.name} output: ${output.fallbackReason}`);
    schemas[`${name}Response`] = output.schema;

    const operation: JsonSchema = {
      operationId: tool.name,
      summary: tool.annotations.title,
      description: operationDescription(tool),
      tags: [tool.entity],
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(requestBody ? { requestBody } : {}),
      responses: {
        '200': {
          description: `\`${tool.envelope}\` success envelope.`,
          content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}Response` } } },
        },
        '4XX': { $ref: '#/components/responses/McpClientError' },
        '5XX': { $ref: '#/components/responses/McpServerError' },
      },
      ...extensions(tool),
    };
    if (tool.availability === 'stub_501') {
      operation.deprecated = true;
      deprecated += 1;
    }

    const method = tool.route.method.toLowerCase();
    const item = (paths[tool.route.pathTemplate] ??= {});
    if (item[method]) {
      throw new Error(
        `two tools claim ${tool.route.method} ${tool.route.pathTemplate} in ${service}: ` +
          `'${(item[method] as JsonSchema).operationId as string}' and '${tool.name}'. ` +
          'One route is one tool; retire or repoint one of them.',
      );
    }
    item[method] = operation;

    tags.set(
      tool.entity,
      `Registry package \`mcp.${tool.service}/${tool.entity}\`, served on MCP mount \`${tool.mount}\`.`,
    );
  }

  const document: JsonSchema = {
    openapi: '3.0.3',
    info: {
      title: SERVICE_META[service].title,
      description: infoDescription(service, tools.length),
      version: SPEC_VERSION,
      contact: CONTACT,
      license: LICENSE,
    },
    servers: SERVICE_META[service].servers,
    security: [{ BearerJwt: [], TeamSid: [] }],
    tags: [...tags]
      .sort(([a], [b]) => byName(a, b))
      .map(([tagName, description]) => ({ name: tagName, description })),
    paths: sortKeys(paths),
    components: {
      securitySchemes: SECURITY_SCHEMES,
      responses: {
        McpClientError: {
          description:
            'MCP error envelope. `error.code` is one of validation_failed, nothing_to_update, not_found, relation_not_found, invalid_transition, limit_exceeded, payment_required, duplicate_rejected, conflict, delete_blocked, unauthorized, forbidden, rate_limited, not_implemented.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/McpError' } } },
        },
        McpServerError: {
          description: 'MCP error envelope with `error.code` internal_error or service_unavailable.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/McpError' } } },
        },
      },
      schemas: sortKeys(schemas),
    },
  };

  return { service, document, operations: tools.length, deprecated };
}

/** Project the whole registry into one OpenAPI document per public service. */
export function generate(): GenerationReport {
  const { included, excluded } = partitionTools();
  const fallbacks: string[] = [];
  const documents = PUBLIC_SERVICES.map((service) =>
    buildDocument(
      service,
      included.filter((tool) => tool.service === service),
      fallbacks,
    ),
  );
  return { documents, excluded, fallbacks };
}
