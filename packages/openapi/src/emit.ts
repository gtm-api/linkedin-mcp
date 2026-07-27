// Serialize and write the generated documents.
//
// Byte-for-byte determinism is the whole point: the drift check (`--check`)
// regenerates into a temp directory and compares bytes, so any non-determinism
// here shows up as a permanent CI failure. Hence `lineWidth: 0` (never re-wrap
// a description, so a one-word edit is a one-line diff) and sorted keys
// upstream in generate.ts.
//
// `aliasDuplicateObjects: false` matters more than it looks: the generator
// reuses one converted schema object in several places (a field appears in both
// a parameter and a request body), and the default serializer would turn the
// repeats into YAML anchors/aliases. Valid YAML, but this document is published
// to external integrators whose tooling may not resolve them, and the anchor
// names depend on JS object identity rather than on content. Write it expanded.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stringify } from 'yaml';
import type { JsonSchema } from './schema';
import type { PublicServiceId } from './services';

const BANNER = [
  '# GENERATED FILE. Do not edit.',
  '#',
  '# Projected from the Zod MCP tool registry in product/mcp/gtm.mcp.',
  '# Regenerate:  cd product/mcp/gtm.mcp && pnpm openapi:public',
  '# Verify:      cd product/mcp/gtm.mcp && pnpm openapi:public:check',
  '',
].join('\n');

export const serviceSpecPath = (outDir: string, service: PublicServiceId): string =>
  join(outDir, 'services', service, 'openapi.yaml');

export const renderYaml = (document: JsonSchema): string =>
  `${BANNER}${stringify(document, { lineWidth: 0, aliasDuplicateObjects: false })}`;

export function writeSpec(outDir: string, service: PublicServiceId, document: JsonSchema): string {
  const target = serviceSpecPath(outDir, service);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, renderYaml(document), 'utf8');
  return target;
}
