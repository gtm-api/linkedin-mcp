import { describe, expect, it } from 'vitest';
import {
  asMintlifyExtension,
  contentHash,
  fetchArticleMd,
  searchKbMintlify,
  type FetchLike,
} from './mintlify-retriever';

const EXT = { key: 'mint_dsc_test', domain: 'docs.example.com' };

function fakeFetch(status: number, body: unknown): FetchLike {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(text),
    text: async () => text,
  });
}

describe('asMintlifyExtension', () => {
  it('accepts a key+domain pair and rejects everything else', () => {
    expect(asMintlifyExtension(EXT)).not.toBeNull();
    expect(asMintlifyExtension({ key: '', domain: 'x' })).toBeNull();
    expect(asMintlifyExtension({ key: 'k' })).toBeNull();
    expect(asMintlifyExtension(undefined)).toBeNull();
    expect(asMintlifyExtension('mint_dsc_x')).toBeNull();
  });
});

describe('searchKbMintlify', () => {
  it('maps discovery results into KbHit rows with docs paths as ids', async () => {
    const { hits, io } = await searchKbMintlify(
      {
        ...EXT,
        fetchImpl: fakeFetch(200, [
          {
            path: 'kb/smart-limits-and-warmup',
            content: '## Limit statuses\n\n| Status | Meaning |',
            metadata: { title: 'Smart limits and warmup' },
          },
          { path: 'api-reference/linkedin/x', content: 'no heading here' },
        ]),
      },
      'held limit',
      5,
    );

    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({
      article_id: 'kb/smart-limits-and-warmup',
      article_title: 'Smart limits and warmup',
      section: 'Limit statuses',
      help_url: 'https://docs.gtm-api.com/kb/smart-limits-and-warmup',
    });
    // No native scores: the rank becomes a monotone score axis.
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
    expect(hits[1]!.section).toBe('Intro');
    expect(hits[1]!.article_title).toBe('X');
    // The io side mirrors the hits: same paths, sizes, a stable content hash.
    expect(io.status).toBe(200);
    expect(io.received_count).toBe(2);
    expect(io.hits[0]).toMatchObject({
      article_id: 'kb/smart-limits-and-warmup',
      truncated: false,
      hash: contentHash('## Limit statuses\n\n| Status | Meaning |'),
    });
  });

  it('honors topK, counts what the index returned, and throws on a non-2xx', async () => {
    const { hits: three, io } = await searchKbMintlify(
      { ...EXT, fetchImpl: fakeFetch(200, [{ path: 'a' }, { path: 'b' }, { path: 'c' }, { path: 'd' }]) },
      'q',
      3,
    );
    expect(three).toHaveLength(3);
    // received_count keeps the pre-slice size (a transport fact; the live
    // index pads every answer to a fixed page, so it is not a relevance signal).
    expect(io.received_count).toBe(4);

    await expect(
      searchKbMintlify({ ...EXT, fetchImpl: fakeFetch(429, 'slow down') }, 'q', 3),
    ).rejects.toThrow('mintlify search 429');
    await expect(
      searchKbMintlify({ ...EXT, fetchImpl: fakeFetch(200, { not: 'an array' }) }, 'q', 3),
    ).rejects.toThrow('non-array');
  });
});

describe('contentHash', () => {
  it('is deterministic, hex, and sensitive to single-character drift', () => {
    expect(contentHash('abc')).toBe(contentHash('abc'));
    expect(contentHash('abc')).toMatch(/^[0-9a-f]{8}$/);
    expect(contentHash('abc')).not.toBe(contentHash('abd'));
    expect(contentHash('')).toBe('811c9dc5');
  });
});

describe('chunk cap', () => {
  it('truncates an oversized chunk at a line boundary and says where the rest is', async () => {
    const line = 'a'.repeat(99) + '\n';
    const big = '## Heading\n' + line.repeat(40); // ~4KB
    const { hits, io } = await searchKbMintlify(
      { ...EXT, fetchImpl: fakeFetch(200, [{ path: 'kb/big', content: big }]) },
      'q',
      5,
    );
    expect(hits[0]!.content.length).toBeLessThan(1500);
    expect(hits[0]!.content).toContain('[truncated: fetch the full page with get_kb_article]');
    // still opens with the heading, so the section label survives the cut
    expect(hits[0]!.section).toBe('Heading');
    // The io meta records the cut, and hashes the FULL text, not the capped one.
    expect(io.hits[0]).toMatchObject({
      truncated: true,
      chars_full: big.length,
      chars_sent: hits[0]!.content.length,
      hash: contentHash(big),
    });
  });

  it('leaves small chunks alone', async () => {
    const { hits } = await searchKbMintlify(
      { ...EXT, fetchImpl: fakeFetch(200, [{ path: 'kb/small', content: '## S\nshort body' }]) },
      'q',
      5,
    );
    expect(hits[0]!.content).toBe('## S\nshort body');
  });
});

describe('hub-page drop', () => {
  it('never serves kb/index, backfills its slot from the tail, keeps the honest received_count', async () => {
    const rows = [
      { path: 'kb/a', content: 'a' },
      { path: 'kb/index', content: 'link hub' },
      { path: 'kb/b', content: 'b' },
      { path: 'kb/c', content: 'c' },
    ];
    const { hits, io } = await searchKbMintlify({ ...EXT, fetchImpl: fakeFetch(200, rows) }, 'q', 3);
    expect(hits.map((h) => h.article_id)).toEqual(['kb/a', 'kb/b', 'kb/c']);
    expect(io.received_count).toBe(4);
  });
});

describe('fetchArticleMd', () => {
  it('fetches the .md variant and lifts the H1 as the title', async () => {
    const page = await fetchArticleMd(
      { ...EXT, fetchImpl: fakeFetch(200, '# Enrichment\n\nBody text.') },
      '/kb/enrichment.md',
    );
    expect(page).toMatchObject({
      id: 'kb/enrichment',
      title: 'Enrichment',
      help_url: 'https://docs.example.com/kb/enrichment',
    });
  });

  it('returns null on a 404 so the caller can report the id as unknown', async () => {
    const page = await fetchArticleMd(
      { ...EXT, fetchImpl: fakeFetch(404, 'nope') },
      'kb/missing',
    );
    expect(page).toBeNull();
  });
});
