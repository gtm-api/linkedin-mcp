import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { filterOp } from '@gtm/mcp-shared';

// filterOp memoizes structurally identical results to ONE shared Zod instance
// so zod-to-json-schema can $ref repeats instead of inlining them: on
// search_linkedin_accounts that is ~38% of the advertised tools/list schema
// (measured 2026-08-12, 3004 → 1861 est. tokens). Losing the sharing breaks no
// contract and no test (the schemas just silently grow back), which is
// exactly why this pin exists.
describe('filterOp memoization', () => {
  it('returns the same instance for structurally identical calls', () => {
    expect(filterOp(z.string(), ['eq', 'in'])).toBe(filterOp(z.string(), ['eq', 'in']));
    expect(
      filterOp(z.enum(['a', 'b']), ['eq', 'ne', 'in', 'nin']),
    ).toBe(filterOp(z.enum(['a', 'b']), ['eq', 'ne', 'in', 'nin']));
    // Checks ride the key: two 18-char sid ops share, a different prefix doesn't.
    expect(
      filterOp(z.string().length(18).startsWith('ab_br_'), ['eq', 'in']),
    ).toBe(filterOp(z.string().length(18).startsWith('ab_br_'), ['eq', 'in']));
  });

  it('keeps structurally different calls apart', () => {
    expect(filterOp(z.string(), ['eq', 'in'])).not.toBe(filterOp(z.string(), ['eq', 'ne', 'in']));
    expect(filterOp(z.enum(['a', 'b']), ['eq'])).not.toBe(filterOp(z.enum(['a', 'c']), ['eq']));
    expect(filterOp(z.string(), ['eq'])).not.toBe(filterOp(z.string().max(64), ['eq']));
    expect(
      filterOp(z.string().describe('one thing'), ['eq']),
    ).not.toBe(filterOp(z.string().describe('another thing'), ['eq']));
  });

  it('does not share wrapped or opaque value schemas', () => {
    expect(
      filterOp(z.string().optional(), ['eq']),
    ).not.toBe(filterOp(z.string().optional(), ['eq']));
    expect(
      filterOp(z.union([z.string(), z.number()]), ['eq']),
    ).not.toBe(filterOp(z.union([z.string(), z.number()]), ['eq']));
  });

  it('parses exactly like an unshared instance', () => {
    const op = filterOp(z.enum(['x', 'y']), ['eq', 'in', 'is_null']);
    expect(op.parse({ eq: 'x' })).toEqual({ eq: 'x' });
    expect(op.parse({ in: ['x', 'y'], is_null: false })).toEqual({ in: ['x', 'y'], is_null: false });
    expect(() => op.parse({ eq: 'z' })).toThrow();
    expect(() => op.parse({ ne: 'x' })).toThrow(); // op not in the allowed set
  });
});
