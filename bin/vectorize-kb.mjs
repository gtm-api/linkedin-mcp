#!/usr/bin/env node
// Embed the support KB and upsert it into Cloudflare Vectorize (the semantic
// side of the hybrid retriever - see packages/mcp.support/kb_articles/).
//
//   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… node bin/vectorize-kb.mjs
//
// Flags:  --dry-run   show what would change, touch nothing
//         --full      re-embed everything (ignore the manifest diff)
//
// Env:    VECTORIZE_INDEX  index name        (default: gtm-kb)
//         KB_DIR           corpus override   (default: ../../../customer_success/kb)
//         EMBED_BATCH      texts per AI call (default: 20)
//
// Token permissions: Account → Workers AI: Run + Vectorize: Edit.
// Incremental: chunk ids are `${article_id}#${n}`, hashed; only new/changed
// chunks are embedded, ids that vanished are deleted. State lives in
// bin/.vectorize-manifest.json (gitignored). Must stay in lockstep with the
// worker's EMBEDDING_MODEL (vector-retriever.ts): @cf/baai/bge-m3, 1024 dims.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCorpus } from './lib/kb-corpus.mjs';

const EMBEDDING_MODEL = '@cf/baai/bge-m3';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const kbDir = process.env.KB_DIR ?? resolve(repoRoot, '../../../customer_success/kb');
const manifestFile = join(repoRoot, 'bin/.vectorize-manifest.json');
const indexName = process.env.VECTORIZE_INDEX ?? 'gtm-kb';
const embedBatch = Number(process.env.EMBED_BATCH ?? '20');
const dryRun = process.argv.includes('--dry-run');
const full = process.argv.includes('--full');

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
if (!dryRun && (!accountId || !apiToken)) {
  console.error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required (see DEPLOY.md).');
  process.exit(1);
}

const api = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;

async function cf(path, init) {
  const res = await fetch(`${api}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiToken}`, ...init.headers },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.success === false) {
    throw new Error(`${path} → ${res.status}: ${JSON.stringify(body?.errors ?? body).slice(0, 400)}`);
  }
  return body;
}

async function embed(texts) {
  const body = await cf(`/ai/run/${EMBEDDING_MODEL}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: texts }),
  });
  const data = body?.result?.data;
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new Error(`embedding returned ${data?.length ?? 'no'} vectors for ${texts.length} texts`);
  }
  return data;
}

async function upsert(vectors) {
  const ndjson = vectors.map((v) => JSON.stringify(v)).join('\n');
  await cf(`/vectorize/v2/indexes/${indexName}/upsert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-ndjson' },
    body: ndjson,
  });
}

async function deleteByIds(ids) {
  await cf(`/vectorize/v2/indexes/${indexName}/delete_by_ids`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
}

// ── plan ────────────────────────────────────────────────────────────────────
const { articles, chunks } = loadCorpus(kbDir);
const byArticle = new Map(articles.map((a) => [a.id, a]));

const perArticleCounter = new Map();
const current = chunks.map((chunk) => {
  const n = perArticleCounter.get(chunk.article_id) ?? 0;
  perArticleCounter.set(chunk.article_id, n + 1);
  const id = `${chunk.article_id}#${n}`;
  const hash = createHash('sha256').update(`${chunk.head}\n${chunk.body}`).digest('hex').slice(0, 16);
  return { id, hash, chunk };
});

const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : {};
const currentIds = new Set(current.map((c) => c.id));
const toEmbed = full ? current : current.filter((c) => manifest[c.id] !== c.hash);
const toDelete = Object.keys(manifest).filter((id) => !currentIds.has(id));

console.log(
  `corpus: ${articles.length} articles, ${chunks.length} chunks | ` +
  `embed: ${toEmbed.length}${full ? ' (full)' : ''} | delete: ${toDelete.length} | index: ${indexName}`,
);
if (dryRun) {
  for (const c of toEmbed.slice(0, 10)) console.log(`  ~ ${c.id}`);
  for (const id of toDelete.slice(0, 10)) console.log(`  - ${id}`);
  process.exit(0);
}

// ── execute ─────────────────────────────────────────────────────────────────
for (let i = 0; i < toEmbed.length; i += embedBatch) {
  const batch = toEmbed.slice(i, i + embedBatch);
  // Embed what the retriever scores: head (title+section) + body.
  const vectors = await embed(batch.map((c) => `${c.chunk.head}\n${c.chunk.body}`));
  await upsert(batch.map((c, j) => ({
    id: c.id,
    values: vectors[j],
    metadata: {
      article_id: c.chunk.article_id,
      article_title: byArticle.get(c.chunk.article_id)?.title ?? c.chunk.article_id,
      section: c.chunk.section,
      content: c.chunk.body,
      help_url: byArticle.get(c.chunk.article_id)?.help_url ?? '',
    },
  })));
  console.log(`  upserted ${Math.min(i + embedBatch, toEmbed.length)}/${toEmbed.length}`);
}

if (toDelete.length > 0) {
  await deleteByIds(toDelete);
  console.log(`  deleted ${toDelete.length} stale vectors`);
}

const nextManifest = Object.fromEntries(current.map((c) => [c.id, c.hash]));
writeFileSync(manifestFile, JSON.stringify(nextManifest, null, 2));
console.log(`done - manifest updated (${Object.keys(nextManifest).length} vectors tracked)`);
