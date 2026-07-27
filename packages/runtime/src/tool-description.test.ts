import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { toolDescription, withAffordances } from './tool-description';
import type { ToolDefinition } from './types';

function tool(over: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'send_thing', description: 'Send a thing.', service: 'linkedin', entity: 'e', mount: 'm',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/things/{sid}/send' },
    operation: 'action', envelope: 'action', availability: 'ga',
    dangerous: false, creditable: false,
    inputSchema: z.object({ _meta: z.any().optional() }), outputSchema: z.any(),
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
});
