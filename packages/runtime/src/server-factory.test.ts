import { describe, it, expect } from 'vitest';
import { REPLY_STYLE, composeInstructions } from './server-factory';

// The reply-style rule rides on every mount's server instructions (the factory
// appends it at the single SDK seam), so these pin the two things a regression
// would break: the rule always lands after the mount's own domain prose, and it
// stays thin enough to be paid on every mount at once.

describe('composeInstructions', () => {
  it('appends the global rule after the mount instructions', () => {
    expect(composeInstructions('Domain prose.')).toBe(`Domain prose.\n\n${REPLY_STYLE}`);
  });

  it('serves the rule alone when a mount has none', () => {
    expect(composeInstructions(undefined)).toBe(REPLY_STYLE);
  });

  it('keeps the rule thin', () => {
    expect(REPLY_STYLE.length).toBeLessThan(400);
  });
});
