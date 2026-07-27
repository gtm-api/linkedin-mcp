// BM25 retriever over the bundled KB index. Staged design (SUPPORT_AGENT_PLAN
// §3.2): v1 is lexical BM25 with zero external infra; a Vectorize-backed
// semantic retriever slots in behind the same search() signature later.

export interface KbArticle {
  id: string;
  title: string;
  tags: string[];
  help_url: string | null;
  updated_at: string | null;
  content: string;
}

export interface KbChunk {
  article_id: string;
  /** Section heading breadcrumb ("Intro" for pre-heading text). */
  section: string;
  /** Title + section, indexed with 2× weight. */
  head: string;
  body: string;
}

export interface KbIndex {
  articles: KbArticle[];
  chunks: KbChunk[];
}

export interface KbHit {
  article_id: string;
  article_title: string;
  section: string;
  content: string;
  score: number;
  help_url: string | null;
}

const K1 = 1.2;
const B = 0.75;
const HEAD_WEIGHT = 2;

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

interface BuiltChunk {
  chunk: KbChunk;
  tf: Map<string, number>;
  len: number;
}

interface BuiltIndex {
  built: BuiltChunk[];
  df: Map<string, number>;
  avgdl: number;
  byArticleId: Map<string, KbArticle>;
}

// Built lazily once per isolate; a few hundred chunks, negligible CPU/memory.
const cache = new WeakMap<KbIndex, BuiltIndex>();

function build(index: KbIndex): BuiltIndex {
  const cached = cache.get(index);
  if (cached) return cached;

  const built: BuiltChunk[] = [];
  const df = new Map<string, number>();
  let totalLen = 0;

  for (const chunk of index.chunks) {
    const tf = new Map<string, number>();
    let len = 0;
    const add = (tokens: string[], weight: number): void => {
      for (const t of tokens) {
        tf.set(t, (tf.get(t) ?? 0) + weight);
        len += weight;
      }
    };
    add(tokenize(chunk.head), HEAD_WEIGHT);
    add(tokenize(chunk.body), 1);
    for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
    built.push({ chunk, tf, len });
    totalLen += len;
  }

  const result: BuiltIndex = {
    built,
    df,
    avgdl: built.length > 0 ? totalLen / built.length : 1,
    byArticleId: new Map(index.articles.map((a) => [a.id, a])),
  };
  cache.set(index, result);
  return result;
}

export function searchKb(index: KbIndex, query: string, topK: number): KbHit[] {
  const { built, df, avgdl, byArticleId } = build(index);
  const n = built.length;
  if (n === 0) return [];

  const terms = [...new Set(tokenize(query))];
  const scored: Array<{ b: BuiltChunk; score: number }> = [];

  for (const b of built) {
    let score = 0;
    for (const term of terms) {
      const f = b.tf.get(term);
      if (!f) continue;
      const d = df.get(term) ?? 0;
      const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5));
      score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * b.len) / avgdl));
    }
    if (score > 0) scored.push({ b, score });
  }

  scored.sort((x, y) => y.score - x.score);
  return scored.slice(0, topK).map(({ b, score }) => {
    const article = byArticleId.get(b.chunk.article_id);
    return {
      article_id: b.chunk.article_id,
      article_title: article?.title ?? b.chunk.article_id,
      section: b.chunk.section,
      content: b.chunk.body,
      score: Math.round(score * 1000) / 1000,
      help_url: article?.help_url ?? null,
    };
  });
}

export function getKbArticle(index: KbIndex, id: string): KbArticle | null {
  return build(index).byArticleId.get(id) ?? null;
}
