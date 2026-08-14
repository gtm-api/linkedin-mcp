import { describe, expect, it } from 'vitest';
import {
  asMintlifyExtension,
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
    const hits = await searchKbMintlify(
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
  });

  it('honors topK and throws on a non-2xx so the caller can fall back', async () => {
    const three = await searchKbMintlify(
      { ...EXT, fetchImpl: fakeFetch(200, [{ path: 'a' }, { path: 'b' }, { path: 'c' }, { path: 'd' }]) },
      'q',
      3,
    );
    expect(three).toHaveLength(3);

    await expect(
      searchKbMintlify({ ...EXT, fetchImpl: fakeFetch(429, 'slow down') }, 'q', 3),
    ).rejects.toThrow('mintlify search 429');
    await expect(
      searchKbMintlify({ ...EXT, fetchImpl: fakeFetch(200, { not: 'an array' }) }, 'q', 3),
    ).rejects.toThrow('non-array');
  });
});

describe('chunk cap', () => {
  it('truncates an oversized chunk at a line boundary and says where the rest is', async () => {
    const line = 'a'.repeat(99) + '\n';
    const big = '## Heading\n' + line.repeat(40); // ~4KB
    const hits = await searchKbMintlify(
      { ...EXT, fetchImpl: fakeFetch(200, [{ path: 'kb/big', content: big }]) },
      'q',
      5,
    );
    expect(hits[0]!.content.length).toBeLessThan(1500);
    expect(hits[0]!.content).toContain('[truncated: fetch the full page with get_kb_article]');
    // still opens with the heading, so the section label survives the cut
    expect(hits[0]!.section).toBe('Heading');
  });

  it('leaves small chunks alone', async () => {
    const hits = await searchKbMintlify(
      { ...EXT, fetchImpl: fakeFetch(200, [{ path: 'kb/small', content: '## S\nshort body' }]) },
      'q',
      5,
    );
    expect(hits[0]!.content).toBe('## S\nshort body');
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

  it('returns null on a 404 so the caller can try the bundled corpus', async () => {
    const page = await fetchArticleMd(
      { ...EXT, fetchImpl: fakeFetch(404, 'nope') },
      'kb/missing',
    );
    expect(page).toBeNull();
  });
});
