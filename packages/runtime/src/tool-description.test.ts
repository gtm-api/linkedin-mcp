import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { PACING_CONTRACT, toolDescription, withAffordances } from './tool-description';
import type { ToolDefinition } from './types';

function tool(over: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'send_thing', description: 'Send a thing.', service: 'linkedin', entity: 'e', mount: 'm',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/things/{sid}/send' },
    operation: 'action', envelope: 'action', availability: 'ga',
    dangerous: false,    inputSchema: z.object({ _meta: z.any().optional() }), outputSchema: z.any(),
    annotations: { title: 't', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    ...over,
  };
}

describe('toolDescription', () => {
  it('leaves a single-target tool untouched', () => {
    expect(toolDescription(tool())).toBe('Send a thing.');
  });

  it('appends the bulk marker for a mass-action tool', () => {
    expect(toolDescription(tool({ massAction: true }))).toBe(
      'Send a thing. Bulk: dispatchable over filter/targets[] as a mass-action.',
    );
  });

  it('names the schedule requirement for paced bulk verbs', () => {
    expect(toolDescription(tool({ massAction: true, scheduleRequired: true }))).toBe(
      'Send a thing. Bulk: dispatchable over filter/targets[] as a mass-action, schedule required.',
    );
  });

  it('names step-eligibility on a verb orchestration can plan', () => {
    expect(toolDescription(tool({ stepEligible: true }))).toBe(
      'Send a thing. Usable as a mass-action plan step.',
    );
  });

  it('names both bulk facts when the verb carries both', () => {
    expect(toolDescription(tool({ massAction: true, stepEligible: true }))).toBe(
      'Send a thing. Bulk: dispatchable over filter/targets[] as a mass-action. Usable as a mass-action plan step.',
    );
  });

  it('closes the marker with the schedule requirement whichever fact carries it', () => {
    expect(toolDescription(tool({ stepEligible: true, scheduleRequired: true }))).toBe(
      'Send a thing. Usable as a mass-action plan step, schedule required.',
    );
  });

  it('applies the same markers to any description-shaped text', () => {
    expect(withAffordances('one-liner', tool({ massAction: true }))).toBe(
      'one-liner Bulk: dispatchable over filter/targets[] as a mass-action.',
    );
    expect(withAffordances('one-liner', tool({ stepEligible: true }))).toBe(
      'one-liner Usable as a mass-action plan step.',
    );
    expect(withAffordances('one-liner', tool())).toBe('one-liner');
  });

  it('names the bucket of a paced tool, after the bulk marker', () => {
    expect(toolDescription(tool({ pacedBucket: 'send_messages' }))).toBe('Send a thing. Paced: send_messages.');
    expect(toolDescription(tool({ massAction: true, scheduleRequired: true, pacedBucket: 'send_messages' }))).toBe(
      'Send a thing. Bulk: dispatchable over filter/targets[] as a mass-action, schedule required. Paced: send_messages.',
    );
    expect(withAffordances('one-liner', tool({ pacedBucket: 'scraping' }))).toBe('one-liner Paced: scraping.');
  });
});

// The marker on a tool is one word and a bucket; what it MEANS is said once per
// surface. These pin the three facts an agent has to act on, because a contract
// that drops one of them sends the agent back to hammering a refused call.
describe('PACING_CONTRACT', () => {
  it('tells the agent what a wait looks like, when to come back, and that parallel calls queue', () => {
    expect(PACING_CONTRACT).toContain('Paced: <bucket>');
    expect(PACING_CONTRACT).toContain('429 rate_limited');
    expect(PACING_CONTRACT).toContain('context.retry_after');
    expect(PACING_CONTRACT).toContain('parallel');
    expect(PACING_CONTRACT).toContain('pacing.next_call_after');
  });

  it('stays thin enough to ride on the instructions of every paced mount', () => {
    expect(PACING_CONTRACT.length).toBeLessThan(700);
  });
});
