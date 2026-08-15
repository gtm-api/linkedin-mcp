// Entity: KB Article (support knowledge base, in-worker, no backend service)
// Source of truth: gtm.ai/product/research/gtm.agent.copilot/SUPPORT_AGENT_PLAN.md §3.2
// Format: registry v2 with `localHandler`. The handlers call the Mintlify
// discovery index over the published docs site; `route` is inert metadata.
// 2 read-only tools, mounted on /mcp/support/knowledge.

import { z } from 'zod';
import type { DispatchContext, ToolDefinition, ToolPackage } from '@gtm/mcp-runtime/types';
import { usageMetaField, McpSearchResponse, McpGetResponse } from '@gtm/mcp-shared';
import { asMintlifyExtension, fetchArticleMd, searchKbMintlify } from './mintlify-retriever';

const KbHitSchema = z.object({
  article_id: z.string(),
  article_title: z.string(),
  section: z.string(),
  content: z.string(),
  score: z.number(),
  help_url: z.string().nullable(),
});

const KbArticleSchema = z.object({
  id: z.string(),
  title: z.string(),
  tags: z.array(z.string()),
  help_url: z.string().nullable(),
  updated_at: z.string().nullable(),
  content: z.string(),
});

function spanId(): string {
  // Fabricated root span for a local (no-backend) call; randomness quality is
  // irrelevant, and Math.random avoids a DOM/workers lib dependency here.
  let hex = '';
  for (let i = 0; i < 16; i += 1) hex += Math.floor(Math.random() * 16).toString(16);
  return hex;
}

function envelopeMeta(ctx: DispatchContext, startedAt: number) {
  return {
    trace_id: ctx.scope.traceId,
    span_id: spanId(),
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    duration_ms: Math.max(0, Math.round(Date.now() - startedAt)),
    debug_url: 'local://support-knowledge',
  };
}

const searchKnowledge: ToolDefinition = {
  name: 'search_knowledge',
  description:
    'Search the gtm-api.com product knowledge base (help articles + Q&A). Returns the most ' +
    'relevant article chunks with title, section and content. Query in ENGLISH, phrased in ' +
    'help-article wording (e.g. "connect LinkedIn account antidetect browser", "smart limits ' +
    'warmup"). Read ALL returned chunks: answers are often assembled from several. Knowledge ' +
    'only, no account data: pair with platform tools for the user\'s own state.',
  toolClass: 'typical',
  service: 'support',
  entity: 'kb_articles',
  mount: 'support.knowledge',
  route: { service: 'support', method: 'POST', pathTemplate: '/local/kb-articles/search' },
  operation: 'search',
  envelope: 'search',
  availability: 'ga',
  dangerous: false,
  inputSchema: z.object({
    query: z.string().min(2).max(300)
      .describe('English search query in help-article wording.'),
    top_k: z.number().int().min(1).max(10).optional()
      .describe('Max chunks to return. Default 5.'),
    ...usageMetaField,
  }),
  outputSchema: McpSearchResponse(KbHitSchema),
  annotations: {
    title: 'Search Knowledge Base',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  localHandler: async (ctx) => {
    const startedAt = Date.now();
    const query = String(ctx.args['query'] ?? '');
    const topK = typeof ctx.args['top_k'] === 'number' ? (ctx.args['top_k'] as number) : 5;

    // The Mintlify discovery index over the published docs site (KB + guides
    // + API reference) is the ONLY retrieval backend, by decision (Eugene,
    // 2026-08-14): a silent fallback to a stale local index would degrade
    // answer quality invisibly, which costs more debugging than an honest
    // failure. Down means down, and the error says which dependency.
    const mintlify = asMintlifyExtension(ctx.deps.extensions?.['mintlifySearch']);
    if (!mintlify) {
      throw new Error(
        'Knowledge search backend is not configured on this deployment '
        + '(MINTLIFY_ASSISTANT_KEY). Retrieval is intentionally not served '
        + 'from a local index.',
      );
    }
    let hits;
    try {
      hits = await searchKbMintlify(mintlify, query, topK);
    } catch (err) {
      ctx.deps.logger.error({
        event: 'support_kb_search_unavailable',
        detail: String((err as { message?: string })?.message ?? err),
      });
      throw new Error(
        'Knowledge search is temporarily unavailable (the docs search '
        + 'backend did not answer). Retry shortly; account data tools are '
        + 'unaffected.',
      );
    }

    return {
      success: true,
      operation: 'search',
      items: hits.map((hit) => ({ item: hit, included: {} })),
      pagination: { next_cursor: null, has_more: false, total_count: hits.length },
      applied_filters: [],
      includes: [],
      meta: envelopeMeta(ctx, startedAt),
    };
  },
};

const getArticle: ToolDefinition = {
  name: 'get_kb_article',
  description:
    'Fetch one knowledge-base article in full by its id (as returned by search_knowledge in ' +
    'article_id). Use when the retrieved chunks reference steps or context you need whole.',
  toolClass: 'trivial',
  service: 'support',
  entity: 'kb_articles',
  mount: 'support.knowledge',
  route: { service: 'support', method: 'POST', pathTemplate: '/local/kb-articles/get' },
  operation: 'get',
  envelope: 'get',
  availability: 'ga',
  dangerous: false,
  inputSchema: z.object({
    id: z.string().min(1).max(200)
      .describe('Article id, e.g. "smart-limits-and-warmup".'),
    ...usageMetaField,
  }),
  outputSchema: McpGetResponse(KbArticleSchema),
  annotations: {
    title: 'Get KB Article',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  localHandler: async (ctx) => {
    const startedAt = Date.now();
    const id = String(ctx.args['id'] ?? '');

    // Ids are docs paths ("kb/enrichment", "guides/receive-webhooks"); every
    // published page serves a .md variant, API reference included. Same
    // no-fallback rule as the search: an unreachable docs site is an error,
    // not an excuse to serve a stale bundled copy.
    const mintlify = asMintlifyExtension(ctx.deps.extensions?.['mintlifySearch']);
    if (!mintlify) {
      throw new Error(
        'Knowledge base is not configured on this deployment '
        + '(MINTLIFY_ASSISTANT_KEY).',
      );
    }
    const page = await fetchArticleMd(mintlify, id);
    if (!page) {
      throw new Error(`KB article '${id}' not found; ids come from search_knowledge results.`);
    }
    return {
      success: true,
      operation: 'get',
      item: { ...page, tags: [], updated_at: null },
      included: {},
      includes: [],
      meta: envelopeMeta(ctx, startedAt),
    };
  },
};

export const kbArticlesPackage: ToolPackage = {
  id: 'mcp.support/kb_articles',
  service: 'support',
  entity: 'kb_articles',
  tools: [searchKnowledge, getArticle],
};
