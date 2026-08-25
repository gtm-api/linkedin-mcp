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

/**
 * Per-hit meta for the caller's `rest.io` log line: sizes around the cap and
 * an FNV-1a hash of the FULL (pre-cap) section text. The hash is the drift
 * detector: replaying the same query later and comparing hashes tells "the
 * index content changed" apart from "the ranking changed", without ever
 * logging bodies.
 */
export interface KbHitIoMeta {
  article_id: string;
  chars_full: number;
  chars_sent: number;
  truncated: boolean;
  hash: string;
}

/** What the one outbound Mintlify call did; feeds the caller's rest.io line. */
export interface KbSearchIo {
  url: string;
  status: number;
  duration_ms: number;
  /** Rows the index returned BEFORE the top_k slice. */
  received_count: number;
  hits: KbHitIoMeta[];
}

/**
 * FNV-1a 32-bit, hex. Dependency-free and identical across runs and runtimes,
 * which is all a drift detector needs; this is not a security hash.
 */
export function contentHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
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
): Promise<{ hits: KbHit[]; io: KbSearchIo }> {
  const doFetch = ext.fetchImpl ?? (globalThis as { fetch?: FetchLike }).fetch;
  if (!doFetch) throw new Error('no fetch available');
  const url = `https://api.mintlify.com/discovery/v1/search/${ext.domain}`;
  const startedAt = Date.now();
  const response = await doFetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ext.key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  if (!response.ok) {
    throw new Error(`mintlify search ${response.status}`);
  }
  const results = (await response.json()) as MintlifyResult[];
  const durationMs = Date.now() - startedAt;
  if (!Array.isArray(results)) {
    throw new Error('mintlify search returned a non-array body');
  }

  // The kb/index hub page is navigation, not answer content, and the
  // 2026-08-25 golden run showed it eating a top-5 slot in 6 of 30 queries.
  // Drop it BEFORE the slice: the API's default 10-row page (it also accepts
  // pageSize, deliberately unused) leaves a tail that backfills the slot,
  // while received_count keeps recording what the index actually served.
  const served = results.filter((r) => r.path !== 'kb/index');

  const hits: KbHit[] = [];
  const hitMeta: KbHitIoMeta[] = [];
  served.slice(0, topK).forEach((r, rank) => {
    const path = typeof r.path === 'string' ? r.path : 'unknown';
    const content = typeof r.content === 'string' ? r.content : '';
    const metaTitle = typeof r.metadata?.title === 'string' ? r.metadata.title : null;
    const sent = capChunk(content);
    hits.push({
      article_id: path,
      article_title: metaTitle ?? titleFromPath(path),
      section: sectionOf(content),
      content: sent,
      // The API returns relevance order without scores; encode the rank so
      // downstream consumers keep a monotone axis.
      score: 1 / (rank + 1),
      help_url: `https://docs.gtm-api.com/${path}`,
    });
    hitMeta.push({
      article_id: path,
      chars_full: content.length,
      chars_sent: sent.length,
      truncated: content.length > CHUNK_CHAR_CAP,
      hash: contentHash(content),
    });
  });
  return {
    hits,
    io: {
      url,
      status: response.status,
      duration_ms: durationMs,
      received_count: results.length,
      hits: hitMeta,
    },
  };
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
