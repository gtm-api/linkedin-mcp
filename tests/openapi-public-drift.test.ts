import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generate, renderYaml, serviceSpecPath } from '@gtm/mcp-openapi';

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

const OUT_DIR = fileURLToPath(new URL('../../../openapi/gtm.openapi.public/', import.meta.url));

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
      const committed = readFileSync(serviceSpecPath(OUT_DIR, document.service), 'utf8');
      expect(
        renderYaml(document.document) === committed,
        `product/openapi/gtm.openapi.public/services/${document.service}/openapi.yaml is stale. Regenerate and commit it:  pnpm openapi:public`,
      ).toBe(true);
    });
  }
});
