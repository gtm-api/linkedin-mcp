// CLI for the public OpenAPI generator. Driven by bin/openapi-public.sh, which
// adds the OAS validation pass on top.
//
//   node --import bin/lib/register-ts.mjs packages/openapi/src/cli.ts
//   node ... cli.ts --out /some/dir
//   node ... cli.ts --check          # regenerate into a temp dir, diff, exit 1 on drift

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from './generate';
import { renderYaml, serviceSpecPath, writeSpec } from './emit';

// packages/openapi/src -> product/openapi/gtm.openapi.public
export const DEFAULT_OUT_DIR = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../../openapi/gtm.openapi.public',
);

interface Options {
  outDir: string;
  check: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { outDir: DEFAULT_OUT_DIR, check: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') {
      options.check = true;
    } else if (arg === '--out') {
      const value = argv[++i];
      if (!value) throw new Error('--out needs a directory');
      options.outDir = resolve(value);
    } else {
      throw new Error(`unknown argument '${arg}'. Usage: cli.ts [--check] [--out <dir>]`);
    }
  }
  return options;
}

function report(): ReturnType<typeof generate> {
  const result = generate();
  const excludedByReason = new Map<string, string[]>();
  for (const item of result.excluded) {
    const reason = item.reason.split(':')[0];
    excludedByReason.set(reason, [...(excludedByReason.get(reason) ?? []), item.tool]);
  }

  for (const document of result.documents) {
    const deprecated = document.deprecated > 0 ? `, ${document.deprecated} deprecated (stub_501)` : '';
    console.log(`  ${document.service.padEnd(14)} ${String(document.operations).padStart(3)} operations${deprecated}`);
  }
  for (const [reason, tools] of excludedByReason) {
    console.log(`  excluded (${reason}): ${tools.length} -> ${tools.join(', ')}`);
  }
  for (const fallback of result.fallbacks) {
    console.log(`  WARN schema fallback: ${fallback}`);
  }
  return result;
}

function runCheck(committedDir: string): number {
  const temp = mkdtempSync(join(tmpdir(), 'gtm-openapi-public-'));
  try {
    const result = report();
    const drifted: string[] = [];
    for (const document of result.documents) {
      const generated = renderYaml(document.document);
      const committedPath = serviceSpecPath(committedDir, document.service);
      writeSpec(temp, document.service, document.document);
      if (!existsSync(committedPath)) {
        drifted.push(`${document.service}: no committed spec at ${committedPath}`);
        continue;
      }
      if (readFileSync(committedPath, 'utf8') !== generated) {
        drifted.push(
          `${document.service}: ${relative(process.cwd(), committedPath)} differs from the registry`,
        );
      }
    }
    if (drifted.length > 0) {
      console.error('\nDRIFT: the committed public spec no longer matches the Zod registry.');
      for (const line of drifted) console.error(`  - ${line}`);
      console.error('\nRegenerate and commit:  pnpm openapi:public');
      return 1;
    }
    console.log('\nOK, the committed public spec matches the Zod registry.');
    return 0;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function runWrite(outDir: string): number {
  const result = report();
  for (const document of result.documents) {
    const target = writeSpec(outDir, document.service, document.document);
    console.log(`  wrote ${relative(process.cwd(), target)}`);
  }
  return 0;
}

const options = parseArgs(process.argv.slice(2));
process.exitCode = options.check ? runCheck(options.outDir) : runWrite(options.outDir);
