// Mintlify discovery search as the KB retrieval backend.
//
// One index covers everything the docs site publishes: the knowledge base,
// the guides, the MCP pages AND the generated API reference, which is the
// whole point of the switch (SUPPORT_AGENT_PLAN §3.2 staged design: this is
// the retriever that replaced the staged BM25+Vectorize pair). Measured
// 2026-08-13 on a 10-question set: bundled BM25 answered 4, this answered 10,
// and it surfaces the matching API-reference page next to the KB article.
//
// There is NO fallback backend, by decision (Eugene, 2026-08-14): a stale
// local index answering silently is a quality regression nobody can see.
// When this path fails, the tool fails with an error naming the dependency.

/** The row shape search_knowledge returns; article_id is a docs path. */
export interface KbHit {
  article_id: string;
  article_title: string;
  section: string;
  content: string;
  score: number;
  help_url: string | null;
}

// The package compiles without DOM/workers libs on purpose (same constraint the
// vector retriever works under), so the fetch surface is declared structurally:
// the worker passes its global fetch in, tests pass a stub.
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<FetchResponseLike>;

export interface MintlifySearchExtension {
  /** Assistant API key (mint_dsc_...). */
  key: string;
  /** Docs subdomain as Mintlify knows it, e.g. "docs.gtm-api.com". */
  domain: string;
  /** The fetch to use; the worker passes its global, tests pass a stub. */
  fetchImpl?: FetchLike;
}

export function asMintlifyExtension(value: unknown): MintlifySearchExtension | null {
  if (!value || typeof value !== 'object') return null;
  const ext = value as { key?: unknown; domain?: unknown };
  if (typeof ext.key !== 'string' || ext.key.length === 0) return null;
  if (typeof ext.domain !== 'string' || ext.domain.length === 0) return null;
  return ext as unknown as MintlifySearchExtension;
}

interface MintlifyResult {
  path?: unknown;
  content?: unknown;
  metadata?: { title?: unknown };
}

/** "kb/smart-limits-and-warmup" → "Smart limits and warmup" when metadata has no title. */
function titleFromPath(path: string): string {
  const last = path.split('/').pop() ?? path;
  const words = last.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** First markdown heading of the chunk, if any; the chunk's own section label. */
function sectionOf(content: string): string {
  const heading = content.match(/^#{1,4}\s+(.+)$/m);
  return heading ? heading[1]!.trim() : 'Intro';
}

// The discovery API returns whole sections, and five of them once weighed in
// at 8.5KB for a one-line question: at ~3 chars per token that is real money
// on every search. Cap each chunk at a line boundary; the agent has
// get_kb_article for the full page, and the cut says so.
const CHUNK_CHAR_CAP = 1400;

function capChunk(content: string): string {
  if (content.length <= CHUNK_CHAR_CAP) return content;
  const cut = content.lastIndexOf('\n', CHUNK_CHAR_CAP);
  const head = content.slice(0, cut > 200 ? cut : CHUNK_CHAR_CAP);
  return `${head}\n[truncated: fetch the full page with get_kb_article]`;
}

export async function searchKbMintlify(
  ext: MintlifySearchExtension,
  query: string,
  topK: number,
): Promise<KbHit[]> {
  const doFetch = ext.fetchImpl ?? (globalThis as { fetch?: FetchLike }).fetch;
  if (!doFetch) throw new Error('no fetch available');
  const response = await doFetch(
    `https://api.mintlify.com/discovery/v1/search/${ext.domain}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ext.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    },
  );
  if (!response.ok) {
    throw new Error(`mintlify search ${response.status}`);
  }
  const results = (await response.json()) as MintlifyResult[];
  if (!Array.isArray(results)) {
    throw new Error('mintlify search returned a non-array body');
  }

  return results.slice(0, topK).map((r, rank) => {
    const path = typeof r.path === 'string' ? r.path : 'unknown';
    const content = typeof r.content === 'string' ? r.content : '';
    const metaTitle = typeof r.metadata?.title === 'string' ? r.metadata.title : null;
    return {
      article_id: path,
      article_title: metaTitle ?? titleFromPath(path),
      section: sectionOf(content),
      content: capChunk(content),
      // The API returns relevance order without scores; encode the rank so
      // downstream consumers keep a monotone axis.
      score: 1 / (rank + 1),
      help_url: `https://docs.gtm-api.com/${path}`,
    };
  });
}

/**
 * Fetch one published page as markdown, by its docs path. Every page on the
 * site serves a .md variant, so `get_kb_article` works for any `article_id`
 * the search returns, API reference included.
 */
export async function fetchArticleMd(
  ext: MintlifySearchExtension,
  path: string,
  fetchImpl?: FetchLike,
): Promise<{ id: string; title: string; content: string; help_url: string } | null> {
  const doFetch = fetchImpl ?? ext.fetchImpl ?? (globalThis as { fetch?: FetchLike }).fetch;
  if (!doFetch) return null;
  const clean = path.replace(/^\/+/, '').replace(/\.md$/, '');
  // The docs site is public; no key needed for the page itself.
  const response = await doFetch(`https://${ext.domain}/${clean}.md`);
  if (!response.ok) return null;
  const content = await response.text();
  const heading = content.match(/^#\s+(.+)$/m);
  return {
    id: clean,
    title: heading ? heading[1]!.trim() : titleFromPath(clean),
    content,
    help_url: `https://${ext.domain}/${clean}`,
  };
}
