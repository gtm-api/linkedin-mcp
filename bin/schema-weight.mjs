// Token weight of the advertised tool schemas, as the wire actually serves them.
//
//   node bin/schema-weight.mjs            # per-service totals + top offenders
//   node bin/schema-weight.mjs --top 25   # longer offender list
//
// Serializes registeredShape() through the same zod-to-json-schema call the
// MCP SDK makes for tools/list, so the numbers ARE the wire (the OpenAPI
// generator inlines shared instances and overstates). Token estimate is
// chars/3.5, good to ~10%. Every ToolSearch load puts these bytes into an
// agent's context, so wire bytes are tokens are money: this is the gauge to
// run after touching filter vocabularies, describes or shared value objects.
// filterOp() memoizes structurally identical op-objects into shared instances
// exactly so this serialization can $ref repeats (tests/filter-op-memo.test.ts).

import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
await import(pathToFileURL(join(ROOT, 'bin/lib/register-ts.mjs')).href);

const req = createRequire(join(ROOT, 'packages/runtime/package.json'));
const { z } = await import(pathToFileURL(req.resolve('zod')).href);
const sdkReq = createRequire(req.resolve('@modelcontextprotocol/sdk/package.json'));
const { zodToJsonSchema } = await import(pathToFileURL(sdkReq.resolve('zod-to-json-schema')).href);

const [{ linkedinPackages }, { idPackages }, { orchestrationPackages }, { supportPackages }, { registeredShape }] =
  await Promise.all([
    import(pathToFileURL(join(ROOT, 'packages/mcp.linkedin/index.ts')).href),
    import(pathToFileURL(join(ROOT, 'packages/mcp.id/index.ts')).href),
    import(pathToFileURL(join(ROOT, 'packages/mcp.orchestration/index.ts')).href),
    import(pathToFileURL(join(ROOT, 'packages/mcp.support/index.ts')).href),
    import(pathToFileURL(join(ROOT, 'packages/runtime/src/input-schema.ts')).href),
  ]);

const topN = (() => {
  const at = process.argv.indexOf('--top');
  return at === -1 ? 12 : Number(process.argv[at + 1]);
})();

const tok = (s) => Math.round(s.length / 3.5);
const rows = [];
const services = new Map();

for (const pkg of [...linkedinPackages, ...idPackages, ...orchestrationPackages, ...supportPackages]) {
  for (const tool of pkg.tools) {
    let schemaTok = 0;
    let err = null;
    try {
      schemaTok = tok(JSON.stringify(zodToJsonSchema(z.object(registeredShape(tool)))));
    } catch (e) {
      err = String(e).slice(0, 80);
    }
    const total = schemaTok + tok(tool.description);
    rows.push({ name: tool.name, service: tool.service, total, schemaTok, err });
    const s = services.get(tool.service) ?? { tools: 0, tok: 0 };
    s.tools += 1;
    s.tok += total;
    services.set(tool.service, s);
  }
}

console.log('service totals (schema + description, ~tokens):');
for (const [service, s] of [...services.entries()].sort((a, b) => b[1].tok - a[1].tok)) {
  console.log(`  ${String(s.tok).padStart(7)}  ${service}  (${s.tools} tools, avg ${Math.round(s.tok / s.tools)})`);
}
console.log(`  ${String([...services.values()].reduce((n, s) => n + s.tok, 0)).padStart(7)}  TOTAL\n`);

rows.sort((a, b) => b.total - a.total);
console.log(`top ${topN} tools:`);
for (const r of rows.slice(0, topN)) {
  console.log(`  ${String(r.total).padStart(6)}  ${r.name}${r.err ? `  [serialize failed: ${r.err}]` : ''}`);
}
const failed = rows.filter((r) => r.err);
if (failed.length) console.log(`\n${failed.length} tools failed to serialize, so their weight is understated above.`);
