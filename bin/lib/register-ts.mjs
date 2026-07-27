// Let plain `node` run the workspace's TypeScript.
//
// Node >= 23 strips the types itself, so the only thing missing is specifier
// resolution: the packages are written for a bundler (`moduleResolution:
// Bundler` in tsconfig.base.json), so an import reads
// `./linkedin_accounts/mcp-tools` with no extension and Node's ESM resolver
// rejects it. This hook re-tries such a specifier as `<spec>.ts`, then
// `<spec>/index.ts`.
//
// Used by bin/openapi-public.sh, which imports the tool registry straight from
// source. Nothing here changes how the worker or vitest resolve modules.
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HAS_EXTENSION = /\.[cm]?[jt]sx?$|\.json$/;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith('./') || specifier.startsWith('../')) &&
      !HAS_EXTENSION.test(specifier) &&
      context.parentURL
    ) {
      for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
        if (existsSync(fileURLToPath(new URL(candidate, context.parentURL)))) {
          return nextResolve(candidate, context);
        }
      }
    }
    return nextResolve(specifier, context);
  },
});
