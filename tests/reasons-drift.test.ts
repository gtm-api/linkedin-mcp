import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Drift gate: the docs' Reasons page is what the contract-oracle fixtures say.
//
// marketing/docs/gtm.docs/concepts/reasons.mdx is GENERATED from the
// `error_catalog` table each backend publishes through gtm:contract-oracle
// (bin/error-reasons.mjs). Nobody edits it by hand, so the only way it can be
// wrong is by going stale after an oracle refresh: someone adds a code and its
// sentence to a service's ErrorCatalog, refreshes the fixture, and forgets
// `pnpm docs:reasons`. Same shape as the public OpenAPI drift gate.
const script = fileURLToPath(new URL('../bin/error-reasons.mjs', import.meta.url));

describe('docs reasons page', () => {
  it('matches the error catalogs the fixtures carry', () => {
    let output = '';
    try {
      output = execFileSync('node', [script, '--check'], { encoding: 'utf8' });
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      throw new Error(`${failure.stderr ?? ''}${failure.stdout ?? ''}\nRegenerate and commit the page: pnpm docs:reasons`);
    }
    expect(output).toContain('OK:');
  });
});
