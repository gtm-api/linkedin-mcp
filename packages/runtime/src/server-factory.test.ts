import { describe, it, expect } from 'vitest';
import { REPLY_STYLE, composeInstructions } from './server-factory';
import { PACING_CONTRACT } from './tool-description';

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

  it('puts the pacing contract between the domain prose and the rule on a surface with paced tools', () => {
    expect(composeInstructions('Domain prose.', true)).toBe(`Domain prose.\n\n${PACING_CONTRACT}\n\n${REPLY_STYLE}`);
    expect(composeInstructions(undefined, true)).toBe(`${PACING_CONTRACT}\n\n${REPLY_STYLE}`);
  });

  it('says nothing about pacing on a surface that has no paced tool', () => {
    expect(composeInstructions('Domain prose.', false)).not.toContain('Pacing:');
  });

  it('keeps the rule thin', () => {
    expect(REPLY_STYLE.length).toBeLessThan(400);
  });
});
