import type { RuntimeDeps, ToolResult } from '../types';
import type { ToolMiddleware } from '../chain';

// Response size budget.
//
// `responseCharBudget` has been plumbed through env.ts since the server was
// built and read by nothing, so the number was a claim, not a control. What it
// was supposed to stop is real: a default page_size=50 search on
// search_linkedin_accounts measures around 0.17 MiB, roughly 46k tokens, and an
// MCP tool result carries its payload TWICE, once as content[].text and once as
// structuredContent, because clients split on which of the two they read.
// Two or three of those calls fill a context window on their own.
//
// Three levers, in order, each one only reached when the one before it was not
// enough. The order is chosen so that the lossless levers run first and nothing
// is ever dropped while a formatting saving is still on the table:
//
//   1. Render the text copy compactly. renderSuccess pretty-prints with two
//      spaces of indent, which on a real search envelope is 20-30% of the
//      bytes. Losing indentation loses nothing, so it is free and it is silent.
//   2. Trim the data page. Rows come off the END of the list, never sampled and
//      never reordered, and the result SAYS how many went and how to get them.
//   3. Nothing left to drop losslessly. Return the payload whole, flagged
//      `over_budget`, and say which knob shrinks it. Blowing the budget while
//      admitting it beats quietly deleting fields out of a single record.
//
// The one thing this never does is drop rows silently. Every trimmed result
// carries a `truncation` block in structuredContent AND a plain-text notice
// ahead of the payload, because the whole failure mode being prevented is an
// agent reasoning over 12 rows while believing it has 50.

/** Lists that are a page of DATA, so dropping the tail loses nothing but data. */
const TRIMMABLE_LISTS = ['items', 'groups'] as const;

// Deliberately not trimmable, though both are arrays that can grow:
//   error.blockers  each blocker is an INSTRUCTION (what to resolve before a
//                   delete goes through). Dropping one tells the agent a delete
//                   is unblocked when it is not.
//   pending         each ref is how the agent follows an async action to
//                   completion. Dropping one orphans the work.
// A response that is over budget because of either is lever 3's problem, and
// lever 3 keeps it whole.

export function resultChars(result: ToolResult): number {
  const text = result.content.reduce((n, c) => n + c.text.length, 0);
  const structured = result.structuredContent ? JSON.stringify(result.structuredContent).length : 0;
  return text + structured;
}

function findTrimmableList(
  structured: Record<string, unknown>,
): { key: string; rows: unknown[] } | null {
  for (const key of TRIMMABLE_LISTS) {
    const value = structured[key];
    if (Array.isArray(value) && value.length > 1) return { key, rows: value };
  }
  return null;
}

function hasCursor(structured: Record<string, unknown>): boolean {
  const pagination = structured.pagination;
  return !!pagination && typeof pagination === 'object' && 'next_cursor' in pagination;
}

function howToGetTheRest(
  structured: Record<string, unknown>,
  listKey: string,
  kept: number,
  total: number,
): string {
  const head =
    `Rows come off the END of the list, never sampled and never reordered, so ${listKey} holds the ` +
    `first ${kept} of the ${total} rows the backend returned for this page.`;
  if (!hasCursor(structured)) {
    return (
      `${head} This response has no cursor to resume from, so narrow the filter (or drop entries from ` +
      "'include') until the whole set fits."
    );
  }
  return (
    `${head} Do NOT follow pagination.next_cursor to collect the missing rows: that cursor resumes AFTER ` +
    `row ${total}, so rows ${kept + 1}..${total} would be skipped without a trace. Re-run this exact call ` +
    `with page_size: ${kept} (or smaller) and then follow next_cursor from THAT response, which resumes at ` +
    `row ${kept + 1}. Dropping entries from 'include' shrinks every row and lets more of them fit.`
  );
}

interface TruncationBlock extends Record<string, unknown> {
  truncated: boolean;
  over_budget: boolean;
  source: 'mcp_runtime';
  reason: 'response_char_budget';
  char_budget: number;
  full_response_chars: number;
  how_to_get_the_rest: string;
}

/**
 * Bring one tool result under `budget` characters, counting both copies the MCP
 * result carries. Pure, so the tests can hand it a realistic envelope.
 */
export function applySizeBudget(result: ToolResult, budget: number, toolName?: string): ToolResult {
  if (budget <= 0) return result;
  const fullChars = resultChars(result);
  if (fullChars <= budget) return result;

  const structured = result.structuredContent;
  // Prose-only result (a preview refusal, a transport error). There is no
  // second copy to compact and no row list to trim, and cutting prose mid
  // sentence would corrupt the instruction the agent is meant to follow.
  if (!structured) return result;

  // Whether this middleware owns the text block: true exactly when the block is
  // renderSuccess's pretty print of the same envelope. When it is prose plus a
  // structured payload (the preview gate), the prose is kept verbatim and the
  // notice is prepended as its own block instead.
  const ownsText =
    result.content.length === 1 && result.content[0].text === JSON.stringify(structured, null, 2);

  const build = (envelope: Record<string, unknown>, notice: string | null): ToolResult => {
    const json = JSON.stringify(envelope);
    const content = ownsText
      ? [{ type: 'text' as const, text: notice ? `${notice}\n\n${json}` : json }]
      : notice
        ? [{ type: 'text' as const, text: notice }, ...result.content]
        : result.content;
    return { ...result, content, structuredContent: envelope };
  };

  // ── Lever 1: compact render, nothing lost, nothing announced ──────────────
  const compacted = build(structured, null);
  if (resultChars(compacted) <= budget) return compacted;

  const tool = toolName ? { tool: toolName } : {};
  const list = findTrimmableList(structured);

  // ── Lever 3 (no list to trim) ─────────────────────────────────────────────
  if (!list) {
    const advice =
      'Nothing was dropped: this payload has no row list, so the only way to shrink it here would be to ' +
      "delete fields out of a single record. Drop entries from 'include' to stop eager-loading relations, " +
      'or fetch a smaller unit (one sid at a time).';
    const truncation: TruncationBlock = {
      truncated: false,
      over_budget: true,
      source: 'mcp_runtime',
      reason: 'response_char_budget',
      ...tool,
      list: null,
      returned: null,
      omitted: 0,
      char_budget: budget,
      full_response_chars: fullChars,
      how_to_get_the_rest: advice,
    };
    const notice =
      `OVER THE RESPONSE BUDGET. This result is ${fullChars} chars against this server's ${budget}-char ` +
      `tool-result budget. ${advice}`;
    return build({ ...structured, truncation }, notice);
  }

  // ── Lever 2: trim the data page ───────────────────────────────────────────
  const total = list.rows.length;

  const trimmedAt = (kept: number, overBudget: boolean): Record<string, unknown> => {
    const truncation: TruncationBlock = {
      truncated: true,
      over_budget: overBudget,
      source: 'mcp_runtime',
      reason: 'response_char_budget',
      ...tool,
      list: list.key,
      returned: kept,
      omitted: total - kept,
      rows_on_this_page: total,
      char_budget: budget,
      full_response_chars: fullChars,
      how_to_get_the_rest: howToGetTheRest(structured, list.key, kept, total),
    };
    return { ...structured, [list.key]: list.rows.slice(0, kept), truncation };
  };

  const noticeAt = (kept: number, overBudget: boolean): string => {
    const lines = [
      `TRUNCATED BY THE MCP SERVER. The full response was ${fullChars} chars against this server's ` +
        `${budget}-char tool-result budget, so ${list.key} was cut to the first ${kept} of ${total} rows ` +
        `and ${total - kept} were dropped.`,
      howToGetTheRest(structured, list.key, kept, total),
    ];
    if (overBudget) {
      lines.push(
        `Even one row does not fit this budget, so this result is still over it at ${kept} row(s). ` +
          "Drop entries from 'include': the rows themselves are what is oversized.",
      );
    }
    return lines.join('\n');
  };

  const fits = (kept: number): boolean =>
    resultChars(build(trimmedAt(kept, false), noticeAt(kept, false))) <= budget;

  // Monotone in `kept`, so a binary search finds the largest page that fits in
  // log2(total) renders. total itself is known not to fit (lever 1 failed).
  let lo = 1;
  let hi = total - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (fits(mid)) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  // A floor of one row rather than zero. A zero-row page is honest and useless:
  // the agent cannot even see the shape of what it asked for, and it tells us
  // nothing that the over_budget flag does not already say.
  const kept = best > 0 ? best : 1;
  const overBudget = best < 0;
  return build(trimmedAt(kept, overBudget), noticeAt(kept, overBudget));
}

/**
 * Size-budget middleware. Outermost link in the chain, so EVERY result that
 * leaves this server is measured: dispatch payloads, the preview gate's
 * previews, error envelopes with a long field_errors map, and anything a future
 * middleware short-circuits with.
 */
export function makeSizeBudget(deps: RuntimeDeps): ToolMiddleware {
  return async (ctx, next) => {
    const result = await next(ctx);
    return applySizeBudget(result, deps.config.responseCharBudget, ctx.tool.name);
  };
}
