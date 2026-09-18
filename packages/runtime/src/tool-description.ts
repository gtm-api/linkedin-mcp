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

// What "paced" means, said ONCE per surface (the server instructions of a mount
// that has paced tools, the pacing note of a toolset listing), never per tool: a
// sentence this long on every row would double the lite listing.
export const PACING_CONTRACT =
  'Pacing: a tool marked "Paced: <bucket>" spends that smart-limit bucket of the LinkedIn account it runs on, and calls of one bucket are spaced per account. A short wait is slept on the server, so the call simply takes longer; a longer one answers 429 rate_limited with context.retry_after, and the call succeeds unchanged from that moment, not earlier. Calls fired in parallel do not leave together, they queue behind each other, so parallelism buys nothing on one account: run them one after another, or spread them over accounts. A success carries pacing.next_call_after when the platform reports it.';

/** `Paced: <bucket>.` for a tool whose call the platform paces, else ''. */
export function pacingAffordance(tool: ToolDefinition): string {
  return tool.pacedBucket ? `Paced: ${tool.pacedBucket}.` : '';
}

/** Append the affordance markers to any description-shaped text. */
export function withAffordances(text: string, tool: ToolDefinition): string {
  return [text, bulkAffordance(tool), pacingAffordance(tool)].filter(Boolean).join(' ');
}

/** The description an MCP client sees for this tool. */
export function toolDescription(tool: ToolDefinition): string {
  return withAffordances(tool.description, tool);
}
