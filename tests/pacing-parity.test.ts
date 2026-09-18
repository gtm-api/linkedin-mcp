import { describe, it, expect } from 'vitest';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import { SMART_LIMIT_BUCKETS, linkedinPackages } from '@gtm/mcp-linkedin';
import { idPackages } from '@gtm/mcp-id';
import { orchestrationPackages } from '@gtm/mcp-orchestration';

// Pacing gate.
//
// A call that the platform dispatches to an account's LinkedIn browser spends one
// smart-limit bucket of that account, and calls of one bucket are spaced: a short
// wait is slept on the server, a longer one answers 429 rate_limited with
// context.retry_after. An agent can only plan around that when the tool says so,
// which is `pacedBucket` on the definition (the `Paced: <bucket>.` marker, the
// pacing note of a facade listing, the pacing contract in the mount instructions).
//
// The bucket a call spends is decided on the backend, per dispatch, by
// LinkedinActionTypeLimitMap (gtm.lib.common) plus the dispatch-site overrides, and
// no oracle dump carries it. So this gate pins what CAN be derived here: the value
// is a real public bucket, only LinkedIn tools carry one, and the tool families
// whose every member dispatches (they are named after what they do) are covered in
// full, so a new scrape / enrich / send tool cannot land unmarked.

const linkedinTools: ToolDefinition[] = linkedinPackages.flatMap((pkg) => pkg.tools);
const otherTools: ToolDefinition[] = [...idPackages, ...orchestrationPackages].flatMap((pkg) => pkg.tools);
const paced = linkedinTools.filter((tool) => tool.pacedBucket !== undefined);

describe('pacedBucket', () => {
  it('is one of the public smart-limit buckets', () => {
    const unknown = paced.filter((tool) => !(SMART_LIMIT_BUCKETS as readonly string[]).includes(tool.pacedBucket!));

    expect(unknown.map((tool) => `${tool.name}: ${tool.pacedBucket}`)).toEqual([]);
  });

  it('lives on LinkedIn tools only: nothing else dispatches to an account browser', () => {
    expect(otherTools.filter((tool) => tool.pacedBucket !== undefined).map((tool) => tool.name)).toEqual([]);
  });

  it.each([
    ['scrape_linkedin_', 'scraping'],
    ['enrich_linkedin_', 'enrichment'],
    ['get_my_latest_linkedin_', 'self_account_sync'],
    ['get_linkedin_account_my_', 'self_account_sync'],
  ])('marks every %s* tool with the %s bucket', (prefix, bucket) => {
    const family = linkedinTools.filter((tool) => tool.name.startsWith(prefix));

    expect(family.length).toBeGreaterThan(0);
    expect(family.filter((tool) => tool.pacedBucket !== bucket).map((tool) => tool.name)).toEqual([]);
  });

  it('marks every send tool with a send bucket', () => {
    const sends = linkedinTools.filter((tool) => tool.name.startsWith('send_linkedin_') || tool.name === 'start_linkedin_group_conversation');

    expect(sends.length).toBeGreaterThan(0);
    expect(sends.filter((tool) => !tool.pacedBucket?.startsWith('send_')).map((tool) => tool.name)).toEqual([]);
  });

  it('leaves the reads of our own store unmarked: a search never reaches LinkedIn', () => {
    const storeReads = paced.filter((tool) => ['search', 'get', 'metrics', 'group_by'].includes(tool.operation));

    expect(storeReads.map((tool) => tool.name)).toEqual([]);
  });
});
