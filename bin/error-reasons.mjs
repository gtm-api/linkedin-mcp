#!/usr/bin/env node
// Generate the docs' "Reasons" reference from the contract-oracle fixtures.
//
//   pnpm docs:reasons            # write marketing/docs/gtm.docs/concepts/reasons.mdx
//   pnpm docs:reasons --check    # exit 1 when the committed page differs from what the fixtures say
//
// Every machine code a service throws without copy of its own has a sentence
// in that service's ErrorCopyCatalog (gtm.lib.common
// Core/Exceptions/ErrorCopyCatalog.php), and `gtm:contract-oracle` publishes
// the table as `error_catalog` in fixtures/contract-oracle/<service>.contract.json.
// This script renders the union of the four tables as one page, one row per
// code, with the service(s) that throw it. Nobody edits the page by hand: the
// sentence lives next to the code, in the backend, and the ErrorCopyScan gate
// in each service keeps a code from being thrown without one.
//
// The page is written into the docs repo directly (the docs live inside the
// monorepo, like sync-openapi.sh assumes), so a docs commit follows a fixture
// refresh the same way an OpenAPI regeneration does.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, '..', 'fixtures', 'contract-oracle');
const outFile = path.resolve(here, '..', '..', '..', '..', 'marketing', 'docs', 'gtm.docs', 'concepts', 'reasons.mdx');
const services = ['linkedin', 'id', 'orchestration', 'email'];
const check = process.argv.includes('--check');

/** @type {Map<string, Map<string, string[]>>} code => sentence => services that say it */
const codes = new Map();
for (const service of services) {
  const file = path.join(fixturesDir, `${service}.contract.json`);
  if (!existsSync(file)) continue;
  const document = JSON.parse(readFileSync(file, 'utf8'));
  for (const [code, sentence] of Object.entries(document.error_catalog ?? {})) {
    const bySentence = codes.get(code) ?? new Map();
    bySentence.set(sentence, [...(bySentence.get(sentence) ?? []), service]);
    codes.set(code, bySentence);
  }
}

const escape = (text) => text.replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/\{field\}/g, '_the field_');
const rows = [...codes.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([code, bySentence]) => {
    const services = [...bySentence.values()].flat();
    // One code, one meaning: when two services word it differently, both sentences
    // are shown with their service, so the difference is visible instead of hidden.
    const meaning = bySentence.size === 1
      ? escape([...bySentence.keys()][0])
      : [...bySentence.entries()].map(([sentence, who]) => `**${who.join(', ')}:** ${escape(sentence)}`).join('<br/>');

    return `| \`${code}\` | ${meaning} | ${services.join(', ')} |`;
  });

const page = `---
title: "Reasons"
description: "Every machine reason the platform answers with, and what it means. Generated from the backends' error catalogs; do not edit by hand."
---

An error envelope carries one of the 16 [error codes](/concepts/envelopes-and-errors#the-16-error-codes) and, under it, a
**reason**: the machine word for what exactly went wrong. On \`validation_failed\` it is \`field_errors.<field>[].rule\`,
on \`conflict\`, \`rate_limited\` and \`service_unavailable\` it is \`error.context.reason\`. The \`message\` next to it is the
sentence below, so an agent branches on the reason and a person reads the message; the ids, dates and limits the sentence
refers to are in \`error.context\` (a \`retry_after\` timestamp, a \`resend_available_at\`, a \`max_bytes\`).

This page is generated from the same table the backends answer from (one catalog per service, checked in CI so no
reason is thrown without a sentence). ${codes.size} reasons across ${services.length} services.

| Reason | What it means | Service |
|---|---|---|
${rows.join('\n')}
`;

if (check) {
  const committed = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
  if (committed !== page) {
    console.error(`DRIFT: ${outFile} does not match the contract-oracle fixtures. Run: pnpm docs:reasons`);
    process.exit(1);
  }
  console.log(`OK: ${outFile} matches the fixtures (${codes.size} reasons)`);
} else {
  writeFileSync(outFile, page);
  console.log(`wrote ${outFile} (${codes.size} reasons)`);
}
