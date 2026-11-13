import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CLIENT_ERROR_EXAMPLES,
  SERVER_ERROR_EXAMPLES,
  generate,
  renderYaml,
  serviceSpecPath,
} from '@gtm/mcp-openapi';
import { McpErrorResponse } from '@gtm/mcp-shared';
import { OPENAPI_PUBLIC_DIR } from './umbrella';

// Drift gate: the committed public OpenAPI contract must still be what the Zod
// registry produces.
//
// product/openapi/gtm.openapi.public is GENERATED from this registry (one
// operation per registered tool). Nobody edits it by hand, so the only way it
// can be wrong is by going stale: someone changes a tool's schema, description
// or flags and forgets `pnpm openapi:public`. A stale published contract is
// worse than a missing one, so this fails the suite the moment the two diverge.
//
// In-process and offline: no backend, no Docker, no Python, no temp files. It
// re-runs the generator and compares the rendered bytes with the committed
// file, which is exactly what `pnpm openapi:public:check` does (that one also
// writes into a temp dir and runs the shared OAS validator, which is why it
// stays a separate command rather than living here).

// OPENAPI_PUBLIC_DIR comes from ./umbrella: two directories up from this repo on
// a workstation and in CI, resolved through the main checkout from a linked worktree.

describe('gtm.openapi.public', () => {
  const result = generate();

  it('emits one document per public service, none empty', () => {
    expect(result.documents.map((document) => document.service)).toEqual([
      'linkedin',
      'id',
      'orchestration',
    ]);
    for (const document of result.documents) {
      expect(document.operations, `${document.service} generated zero operations`).toBeGreaterThan(0);
    }
  });

  it('degrades no schema to an open object', () => {
    expect(
      result.fallbacks,
      'A schema could not be projected from Zod, so an operation now documents an untyped body. Teach packages/openapi/src/schema.ts the construct instead of shipping the fallback.',
    ).toEqual([]);
  });

  it('excludes only the in-worker tools that have no backend endpoint', () => {
    expect(result.excluded.map((item) => item.tool).sort()).toEqual([
      'get_kb_article',
      'search_knowledge',
    ]);
  });

  for (const document of result.documents) {
    it(`${document.service}: the committed spec matches the registry`, () => {
      const committed = readFileSync(serviceSpecPath(OPENAPI_PUBLIC_DIR, document.service), 'utf8');
      expect(
        renderYaml(document.document) === committed,
        `product/openapi/gtm.openapi.public/services/${document.service}/openapi.yaml is stale. Regenerate and commit it:  pnpm openapi:public`,
      ).toBe(true);
    });
  }
});

// The examples under the two error responses. With none, a docs renderer draws
// one from the schema, and the shared envelope's first code is validation_failed:
// the 5XX tab showed a 422 with `<string>` for every text, and a customer took it
// for the answer his call had got (2026-11-10). An example is only worth having
// while it is a real answer of the class it stands under.
describe('gtm.openapi.public error examples', () => {
  const SERVER_CODES = ['internal_error', 'service_unavailable'];
  const result = generate();

  it('every example is an envelope the contract accepts', () => {
    for (const [name, example] of Object.entries({ ...CLIENT_ERROR_EXAMPLES, ...SERVER_ERROR_EXAMPLES })) {
      const parsed = McpErrorResponse.safeParse(example.value);
      expect(parsed.success, `${name}: ${parsed.success ? '' : parsed.error.message}`).toBe(true);
    }
  });

  it('an example is named for its code and stands under the response of its class', () => {
    for (const [name, example] of Object.entries(SERVER_ERROR_EXAMPLES)) {
      const code = (example.value.error as { code: string }).code;
      expect(code).toBe(name);
      expect(SERVER_CODES, `${name} is not a 5XX code`).toContain(code);
    }
    for (const [name, example] of Object.entries(CLIENT_ERROR_EXAMPLES)) {
      const code = (example.value.error as { code: string }).code;
      expect(code).toBe(name);
      expect(SERVER_CODES, `${name} is a 5XX code under 4XX`).not.toContain(code);
    }
    // Both server codes are shown: the retryable one and the one that is not.
    expect(Object.keys(SERVER_ERROR_EXAMPLES).sort()).toEqual([...SERVER_CODES].sort());
  });

  it('no example carries a placeholder', () => {
    const text = JSON.stringify({ ...CLIENT_ERROR_EXAMPLES, ...SERVER_ERROR_EXAMPLES });
    expect(text).not.toMatch(/<string>|<boolean>|<number>/);
  });

  for (const document of result.documents) {
    it(`${document.service}: both error responses publish the examples`, () => {
      const responses = (document.document.components as {
        responses: Record<string, { content: Record<string, { examples?: unknown }> }>;
      }).responses;
      expect(responses.McpClientError.content['application/json'].examples).toEqual(CLIENT_ERROR_EXAMPLES);
      expect(responses.McpServerError.content['application/json'].examples).toEqual(SERVER_ERROR_EXAMPLES);
    });
  }
});
