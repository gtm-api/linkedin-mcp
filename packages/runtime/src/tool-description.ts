import type { ToolDefinition } from './types';

// The single place that turns a ToolDefinition into the text an LLM reads.
// Tool files own the prose; the runtime appends deterministic affordance
// markers so every surface (flat mount and the toolsets facade) says the same
// thing about the same tool.

// The two independent bulk facts of SERVICE_CONVENTIONS §R4, in the order an
// agent needs them: what THIS call can take, then what the planner may do with
// the verb. A tool can carry either, both, or neither.
const BULK = 'Bulk: dispatchable over filter/targets[] as a mass-action';
const STEP = 'Usable as a mass-action plan step';

/** Bulk-dispatch marker, or '' for a single-target, non-plannable tool. */
export function bulkAffordance(tool: ToolDefinition): string {
  const claims: string[] = [];
  if (tool.massAction) claims.push(BULK);
  if (tool.stepEligible) claims.push(STEP);
  if (!claims.length) return '';
  // Pacing rides on whichever bulk fact the verb has, so it closes the marker.
  return `${claims.join('. ')}${tool.scheduleRequired ? ', schedule required' : ''}.`;
}

/** Append the affordance markers to any description-shaped text. */
export function withAffordances(text: string, tool: ToolDefinition): string {
  const bulk = bulkAffordance(tool);
  return bulk ? `${text} ${bulk}` : text;
}

/** The description an MCP client sees for this tool. */
export function toolDescription(tool: ToolDefinition): string {
  return withAffordances(tool.description, tool);
}
