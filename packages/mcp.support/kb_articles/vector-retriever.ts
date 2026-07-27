// Vectorize-backed semantic retrieval for the support KB (production path).
// The worker exposes bindings via deps.extensions.supportKb. When the bindings
// are absent, or any vector-path call fails, we fall back to the bundled BM25
// index, so dev and prod share one code path with different depth. See DEPLOY.md for
// provisioning and bin/vectorize-kb.mjs for the embed/upsert side.

import type { KbHit } from './retriever';

/** Structural slices of the Workers AI / Vectorize bindings we actually use,
 *  kept local so this package does not depend on @cloudflare/workers-types. */
export interface AiBindingLike {
  run(model: string, input: { text: string[] }): Promise<unknown>;
}

export interface VectorizeBindingLike {
  query(
    vector: number[],
    options: { topK: number; returnMetadata: 'all' | 'indexed' | 'none' },
  ): Promise<{ matches: Array<{ id: string; score: number; metadata?: Record<string, unknown> }> }>;
}

export interface SupportKbExtension {
  ai: AiBindingLike;
  vectorize: VectorizeBindingLike;
}

/** Must match bin/vectorize-kb.mjs (embedding side). bge-m3 → 1024 dims. */
export const EMBEDDING_MODEL = '@cf/baai/bge-m3';

export function asSupportKbExtension(value: unknown): SupportKbExtension | null {
  if (!value || typeof value !== 'object') return null;
  const ext = value as { ai?: unknown; vectorize?: unknown };
  if (!ext.ai || !ext.vectorize) return null;
  return ext as SupportKbExtension;
}

function extractVector(aiResult: unknown): number[] | null {
  // bge-m3 responses arrive as {data: number[][]} (REST parity); tolerate a
  // {result: {data}} wrapper too.
  const root = (aiResult as { result?: unknown })?.result ?? aiResult;
  const data = (root as { data?: unknown })?.data;
  if (!Array.isArray(data) || !Array.isArray(data[0])) return null;
  return data[0] as number[];
}

export async function searchKbVector(
  ext: SupportKbExtension,
  query: string,
  topK: number,
): Promise<KbHit[]> {
  const embedded = await ext.ai.run(EMBEDDING_MODEL, { text: [query] });
  const vector = extractVector(embedded);
  if (!vector) throw new Error('embedding returned no vector');

  const { matches } = await ext.vectorize.query(vector, { topK, returnMetadata: 'all' });
  return matches.map((match) => {
    const m = match.metadata ?? {};
    return {
      article_id: String(m['article_id'] ?? match.id.split('#')[0] ?? match.id),
      article_title: String(m['article_title'] ?? m['article_id'] ?? match.id),
      section: String(m['section'] ?? ''),
      content: String(m['content'] ?? ''),
      score: Math.round(match.score * 1000) / 1000,
      help_url: typeof m['help_url'] === 'string' ? (m['help_url'] as string) : null,
    };
  });
}

/**
 * Reciprocal-rank fusion of the vector and BM25 result lists (k=60), deduped
 * by article+section. Scores become fused ranks, comparable across retrievers,
 * unlike raw BM25/cosine values.
 */
export function fuseHits(vectorHits: KbHit[], bm25Hits: KbHit[], topK: number): KbHit[] {
  const K = 60;
  const fused = new Map<string, { hit: KbHit; score: number }>();
  for (const [listIndex, list] of [vectorHits, bm25Hits].entries()) {
    list.forEach((hit, rank) => {
      const key = `${hit.article_id}#${hit.section}`;
      const contribution = 1 / (K + rank + 1);
      const existing = fused.get(key);
      if (existing) {
        existing.score += contribution;
      } else {
        // Prefer the vector copy's content when both lists carry the chunk.
        fused.set(key, { hit: listIndex === 0 ? hit : hit, score: contribution });
      }
    });
  }
  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ hit, score }) => ({ ...hit, score: Math.round(score * 10000) / 10000 }));
}
