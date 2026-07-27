import { describe, it, expect } from 'vitest';
import { checkBatchSize, DEFAULT_MAX_BATCH_SIZE } from './batch-cap';

describe('JSON-RPC batch cap', () => {
  it('lets a single message through (what every current MCP client sends)', () => {
    expect(checkBatchSize(1, DEFAULT_MAX_BATCH_SIZE)).toBeNull();
  });

  it('lets a batch exactly at the cap through', () => {
    expect(checkBatchSize(DEFAULT_MAX_BATCH_SIZE, DEFAULT_MAX_BATCH_SIZE)).toBeNull();
  });

  it('rejects one over the cap, and nothing in it ran', () => {
    const rejected = checkBatchSize(DEFAULT_MAX_BATCH_SIZE + 1, DEFAULT_MAX_BATCH_SIZE);
    expect(rejected).not.toBeNull();
    expect(rejected!.status).toBe(413);
    expect(rejected!.body.error.code).toBe(-32600);
    expect(rejected!.body.error.data).toMatchObject({
      reason: 'batch_too_large',
      received: DEFAULT_MAX_BATCH_SIZE + 1,
      max_batch_size: DEFAULT_MAX_BATCH_SIZE,
    });
    // The caller has to be able to tell that this was all-or-nothing.
    expect(rejected!.body.error.message).toContain('Nothing in it ran');
  });

  it('rejects the 1000-element fan-out the audit named', () => {
    const rejected = checkBatchSize(1000, DEFAULT_MAX_BATCH_SIZE);
    expect(rejected!.status).toBe(413);
    expect(rejected!.body.error.data.received).toBe(1000);
  });

  it('rejects an empty batch instead of walking it to a silent 202', () => {
    const rejected = checkBatchSize(0, DEFAULT_MAX_BATCH_SIZE);
    expect(rejected!.status).toBe(400);
    expect(rejected!.body.error.data).toMatchObject({ reason: 'empty_batch' });
  });

  it('honours a configured cap rather than the default', () => {
    expect(checkBatchSize(4, 4)).toBeNull();
    expect(checkBatchSize(5, 4)!.body.error.data.max_batch_size).toBe(4);
  });

  // The number itself, asserted so a future bump has to argue with the reason
  // for it: worst case 3 subrequests per element (1 backend fetch + the preview
  // gate's 2 KV ops) has to stay under Cloudflare's 50-per-invocation ceiling on
  // the Free plan, which is the tighter of the two plans.
  it('stays inside the Free-plan subrequest ceiling at worst-case cost per element', () => {
    const WORST_CASE_SUBREQUESTS_PER_ELEMENT = 3;
    const CLOUDFLARE_FREE_PLAN_SUBREQUEST_LIMIT = 50;
    expect(DEFAULT_MAX_BATCH_SIZE * WORST_CASE_SUBREQUESTS_PER_ELEMENT).toBeLessThanOrEqual(
      CLOUDFLARE_FREE_PLAN_SUBREQUEST_LIMIT,
    );
  });

  it('is a JSON-RPC error response the client can parse, id null', () => {
    const rejected = checkBatchSize(99, DEFAULT_MAX_BATCH_SIZE)!;
    expect(rejected.body.jsonrpc).toBe('2.0');
    expect(rejected.body.id).toBeNull();
  });
});
