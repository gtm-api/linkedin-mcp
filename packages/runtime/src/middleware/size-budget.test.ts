import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { applySizeBudget, makeSizeBudget, resultChars } from './size-budget';
import type { DispatchContext, RuntimeDeps, ToolDefinition, ToolResult } from '../types';

// A realistic oversized envelope, not a synthetic blob of x's.
//
// The shape is McpSearchResponse from packages/shared/contracts.ts and the
// fields are the ones linkedin_accounts actually serves (see its mcp-tools.ts):
// the same nested sync_config / webhook_config objects, the same eight
// last_*_sync_at timestamps, the same created_by block, plus an `included`
// side-load, which is what makes a row expensive. Fifty of these is the default
// page the audit measured at about 0.17 MiB.

const ISO = '2026-07-21T09:14:37Z';

function accountRow(i: number): Record<string, unknown> {
  const sid = `lna_ac_${String(i).padStart(11, '0')}`;
  return {
    item: {
      sid,
      team_sid: 'ts_tm_seeddev00001',
      antidetect_browser_sid: `adb_br_${String(i).padStart(11, '0')}`,
      status: 'active',
      account_share_sid: null,
      share_role: null,
      ln_id: `ACoAAA${String(i).padStart(12, '0')}`,
      ln_member_id: `ACoAAA${String(i).padStart(12, '0')}`,
      sn_id: null,
      nickname: `firstname-lastname-${i}`,
      full_name: `Firstname Lastname the ${i}th`,
      avatar_url: `https://media.licdn.com/dms/image/v2/D4E03AQH${i}/profile-displayphoto-shrink_800_800/0/1700000000000?e=1735000000&v=beta&t=abcdefghijklmnopqrstuvwxyz012345678`,
      has_premium: i % 3 === 0,
      has_sn: false,
      has_recruiter: false,
      inmail_credits: i % 3 === 0 ? 15 : null,
      last_premium_check_at: ISO,
      last_connections_sync_at: ISO,
      last_conversations_sync_at: ISO,
      last_sales_navigator_conversations_sync_at: null,
      last_connection_requests_sync_at: ISO,
      last_connection_invitations_sync_at: ISO,
      last_followers_sync_at: ISO,
      last_snapshot_at: ISO,
      initial_sync_completed_at: ISO,
      last_heartbeat_at: ISO,
      sync_config: {
        connections: { enabled: true, window_start: '09:00', window_end: '18:00', timezone: 'Europe/Amsterdam' },
        conversations: { enabled: true, window_start: '09:00', window_end: '18:00', timezone: 'Europe/Amsterdam' },
        connection_requests: { enabled: true, window_start: '09:00', window_end: '18:00', timezone: 'Europe/Amsterdam' },
        connection_invitations: { enabled: false, window_start: null, window_end: null, timezone: 'Europe/Amsterdam' },
        followers: { enabled: false, window_start: null, window_end: null, timezone: 'Europe/Amsterdam' },
      },
      webhook_config: {
        enabled: true,
        events: [
          'linkedin_account.connected',
          'linkedin_account.disconnected',
          'linkedin_conversation.message_received',
          'linkedin_connection_request.accepted',
        ],
        endpoint_sid: 'whk_ep_000000000001',
      },
      created_by: { actor_type: 'user', actor_sid: 'us_mb_seeddev00001', team_sid: 'ts_tm_seeddev00001' },
      created_at: ISO,
      updated_at: ISO,
      deleted_at: null,
    },
    included: {
      antidetect_browser: {
        sid: `adb_br_${String(i).padStart(11, '0')}`,
        vendor: 'gologin',
        vendor_profile_id: `68f${String(i).padStart(21, '0')}`,
        status: 'running',
        proxy: { host: 'brd.superproxy.io', port: 33335, country: 'nl', kind: 'residential' },
        last_started_at: ISO,
      },
      smart_limits: {
        connection_requests: { limit: 25, used: 12, resets_at: ISO, status: 'active' },
        messages: { limit: 60, used: 31, resets_at: ISO, status: 'active' },
        profile_views: { limit: 150, used: 88, resets_at: ISO, status: 'active' },
        warmup_day: 14,
      },
    },
  };
}

function searchEnvelope(rows: number): Record<string, unknown> {
  return {
    success: true,
    operation: 'search',
    items: Array.from({ length: rows }, (_, i) => accountRow(i)),
    pagination: { next_cursor: 'eyJzaWQiOiJsbmFfYWNfMDAwMDAwMDAwNDkifQ', has_more: true, total_count: 412 },
    applied_filters: { status: { eq: 'active' } },
    includes: ['antidetect_browser', 'smart_limits'],
    meta: {
      trace_id: '01920000-0000-7000-8000-000000000000',
      span_id: '0123456789abcdef',
      timestamp: ISO,
      duration_ms: 412,
    },
  };
}

/** Exactly what renderSuccess produces: pretty text plus the same object again. */
function rendered(envelope: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
    structuredContent: envelope,
  };
}

const truncationOf = (result: ToolResult): Record<string, unknown> =>
  (result.structuredContent as { truncation: Record<string, unknown> }).truncation;

describe('the envelope this is measured against', () => {
  // The audit measured one default page at about 0.17 MiB. This fixture lands
  // in the same order of magnitude for a single copy, and the point of the test
  // is the multiplier on top of it: an MCP result carries the payload TWICE,
  // and the text copy is pretty-printed, so what actually crosses the wire is
  // roughly two and a half times the raw envelope.
  it('a default page_size=50 account search costs six figures of characters, twice over', () => {
    const envelope = searchEnvelope(50);
    const oneCopy = JSON.stringify(envelope).length;
    const onTheWire = resultChars(rendered(envelope));

    expect(oneCopy).toBeGreaterThan(100_000);
    expect(onTheWire).toBeGreaterThan(oneCopy * 2);
    expect(onTheWire).toBeGreaterThan(300_000);
  });
});

describe('size budget', () => {
  const BUDGET = 48_000;

  it('leaves a result that already fits completely alone', () => {
    const small = rendered(searchEnvelope(2));
    expect(resultChars(small)).toBeLessThan(BUDGET);
    expect(applySizeBudget(small, BUDGET)).toBe(small);
  });

  it('takes the lossless lever first: compacting the text copy, with nothing dropped', () => {
    // Sized so the pretty render is over budget but the compact one is not.
    const envelope = searchEnvelope(6);
    const result = rendered(envelope);
    const budget = Math.floor((resultChars(result) + JSON.stringify(envelope).length * 2) / 2);
    expect(resultChars(result)).toBeGreaterThan(budget);

    const out = applySizeBudget(result, budget);
    expect(resultChars(out)).toBeLessThanOrEqual(budget);
    // Every row still there, and no truncation block, because nothing was lost.
    expect((out.structuredContent as { items: unknown[] }).items).toHaveLength(6);
    expect(out.structuredContent).not.toHaveProperty('truncation');
  });

  it('brings the 50-row page under budget and keeps the FIRST rows, unmodified', () => {
    const envelope = searchEnvelope(50);
    const out = applySizeBudget(rendered(envelope), BUDGET, 'search_linkedin_accounts');

    expect(resultChars(out)).toBeLessThanOrEqual(BUDGET);
    const items = (out.structuredContent as { items: unknown[] }).items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThan(50);
    // Prefix of the original, byte for byte: no sampling, no reordering, no
    // per-row field stripping.
    expect(items).toEqual((envelope.items as unknown[]).slice(0, items.length));
  });

  it('says it truncated, in the structured block AND in the text an agent reads', () => {
    const out = applySizeBudget(rendered(searchEnvelope(50)), BUDGET, 'search_linkedin_accounts');
    const kept = (out.structuredContent as { items: unknown[] }).items.length;

    expect(truncationOf(out)).toMatchObject({
      truncated: true,
      over_budget: false,
      source: 'mcp_runtime',
      reason: 'response_char_budget',
      tool: 'search_linkedin_accounts',
      list: 'items',
      returned: kept,
      omitted: 50 - kept,
      rows_on_this_page: 50,
      char_budget: BUDGET,
    });
    expect(out.content[0].text).toContain('TRUNCATED BY THE MCP SERVER');
    expect(out.content[0].text).toContain(`first ${kept} of 50 rows`);
  });

  it('warns that next_cursor would SKIP the dropped rows, and names the fix', () => {
    const out = applySizeBudget(rendered(searchEnvelope(50)), BUDGET);
    const kept = (out.structuredContent as { items: unknown[] }).items.length;
    const advice = String(truncationOf(out).how_to_get_the_rest);

    expect(advice).toContain('Do NOT follow pagination.next_cursor');
    expect(advice).toContain(`page_size: ${kept}`);
    // The text block carries the same warning: some clients read nothing else.
    expect(out.content[0].text).toContain('Do NOT follow pagination.next_cursor');
  });

  it('leaves the backend pagination block untouched rather than editing history', () => {
    const envelope = searchEnvelope(50);
    const out = applySizeBudget(rendered(envelope), BUDGET);
    expect((out.structuredContent as { pagination: unknown }).pagination).toEqual(envelope.pagination);
  });

  it('the text block and structuredContent agree after trimming', () => {
    const out = applySizeBudget(rendered(searchEnvelope(50)), BUDGET);
    const payload = out.content[0].text.slice(out.content[0].text.indexOf('\n\n') + 2);
    expect(JSON.parse(payload)).toEqual(out.structuredContent);
  });

  it('honours a tiny budget by keeping ONE row rather than zero, and admits it is still over', () => {
    const out = applySizeBudget(rendered(searchEnvelope(50)), 500);
    expect((out.structuredContent as { items: unknown[] }).items).toHaveLength(1);
    expect(truncationOf(out)).toMatchObject({ truncated: true, over_budget: true, returned: 1, omitted: 49 });
    expect(out.content[0].text).toContain('Even one row does not fit');
  });

  it('scales the kept page with the budget', () => {
    const rows = (budget: number) =>
      (applySizeBudget(rendered(searchEnvelope(50)), budget).structuredContent as { items: unknown[] }).items.length;
    expect(rows(96_000)).toBeGreaterThan(rows(48_000));
    expect(rows(48_000)).toBeGreaterThan(rows(24_000));
  });

  it('trims a group_by envelope on its own list', () => {
    const envelope = {
      success: true,
      operation: 'group_by',
      field: 'status',
      groups: Array.from({ length: 400 }, (_, i) => ({ value: `status-value-number-${i}`, count: 1000 - i })),
      total: 400,
      applied_filters: {},
      available_fields: ['status', 'has_premium', 'share_role'],
      meta: { trace_id: 't', span_id: '0123456789abcdef', timestamp: ISO, duration_ms: 3 },
    };
    const out = applySizeBudget(rendered(envelope), 8_000);
    expect(resultChars(out)).toBeLessThanOrEqual(8_000);
    expect(truncationOf(out)).toMatchObject({ list: 'groups', truncated: true });
    // No cursor on a group_by, so the advice cannot tell the agent to page.
    expect(String(truncationOf(out).how_to_get_the_rest)).toContain('no cursor to resume from');
  });

  it('never trims delete_blocked blockers: dropping one would read as "not blocked"', () => {
    const envelope = {
      success: false,
      error: {
        code: 'delete_blocked',
        message: 'This account cannot be deleted yet.',
        recoverable: true,
        blockers: Array.from({ length: 120 }, (_, i) => ({
          type: 'active_flow',
          severity: 'hard',
          description: `Flow number ${i} is still running against this account and would lose its queue.`,
          entity_sid: `flw_fl_${String(i).padStart(11, '0')}`,
          count: 3,
          resolution: 'stop_linkedin_flow',
          resolution_hint: `Call stop_linkedin_flow with sid flw_fl_${String(i).padStart(11, '0')} first.`,
        })),
      },
      meta: { trace_id: 't', span_id: '0123456789abcdef', timestamp: ISO, duration_ms: 9 },
    };
    const result: ToolResult = { ...rendered(envelope), isError: true };
    const out = applySizeBudget(result, 4_000);

    const blockers = (out.structuredContent as { error: { blockers: unknown[] } }).error.blockers;
    expect(blockers).toHaveLength(120);
    expect(truncationOf(out)).toMatchObject({ truncated: false, over_budget: true, list: null, omitted: 0 });
    expect(out.isError).toBe(true);
  });

  it('keeps a single oversized record whole and says which knob shrinks it', () => {
    const envelope = {
      success: true,
      operation: 'get',
      item: accountRow(1).item,
      included: { history: Array.from({ length: 300 }, (_, i) => ({ at: ISO, event: `event-number-${i}` })) },
      includes: ['history'],
      meta: { trace_id: 't', span_id: '0123456789abcdef', timestamp: ISO, duration_ms: 9 },
    };
    const out = applySizeBudget(rendered(envelope), 4_000);

    expect((out.structuredContent as { item: unknown }).item).toEqual(envelope.item);
    expect((out.structuredContent as { included: { history: unknown[] } }).included.history).toHaveLength(300);
    expect(truncationOf(out)).toMatchObject({ truncated: false, over_budget: true });
    expect(out.content[0].text).toContain('OVER THE RESPONSE BUDGET');
    expect(String(truncationOf(out).how_to_get_the_rest)).toContain("'include'");
  });

  it('keeps a gate result prose intact and prepends the notice instead of overwriting it', () => {
    const preview: ToolResult = {
      content: [{ type: 'text', text: 'Call send_linkedin_message AGAIN with commit_token to execute.' }],
      structuredContent: { preview: true, items: Array.from({ length: 40 }, (_, i) => accountRow(i)) },
    };
    const out = applySizeBudget(preview, 20_000);
    expect(out.content[out.content.length - 1].text).toBe(preview.content[0].text);
    expect(out.content[0].text).toContain('TRUNCATED BY THE MCP SERVER');
  });

  it('passes a prose-only result through: there is nothing to trim losslessly', () => {
    const prose: ToolResult = { content: [{ type: 'text', text: 'x'.repeat(60_000) }], isError: true };
    expect(applySizeBudget(prose, BUDGET)).toBe(prose);
  });

  it('a budget of 0 or less disables the whole thing', () => {
    const big = rendered(searchEnvelope(50));
    expect(applySizeBudget(big, 0)).toBe(big);
    expect(applySizeBudget(big, -1)).toBe(big);
  });
});

// A scrape action answers its page one level down, as result.rows next to
// result.paging and the ledger receipt result.data_request. Until 2026-09-28
// the trimmer looked at the top level only and let such a page out whole,
// flagged "no row list", which is how a 134 752-character Sales Navigator
// company page never reached its client (the MCP audit report, 17.09 item 14).
function personPreview(i: number): Record<string, unknown> {
  return {
    ln_id: `ACoAAA${String(i).padStart(12, '0')}`,
    ln_member_id: String(700_000_000 + i),
    nickname: `firstname-lastname-${i}`,
    full_name: `Firstname Lastname the ${i}th`,
    headline: 'Head of Growth at a company whose name is long enough to make a row cost something',
    location: 'Amsterdam, North Holland, The Netherlands',
    avatar_url: `https://media.licdn.com/dms/image/v2/D4E03AQH${i}/profile-displayphoto-shrink_800_800/0/1700000000000?e=1735000000&v=beta&t=abcdefghijklmnopqrstuvwxyz012345678`,
    connection_degree: '2nd',
  };
}

function scrapeEnvelope(rows: number): Record<string, unknown> {
  return {
    success: true,
    operation: 'action',
    action: 'search-people',
    item: null,
    result: {
      rows: Array.from({ length: rows }, (_, i) => personPreview(i)),
      paging: { page: 1, page_size: rows, has_more: true, total: null },
      commercial_use_limit_hit: false,
      data_request: { sid: 'er_rq_000000000001', kind: 'scrape', method: 'search_people_by_url', status: 'completed', served_from_cache: false, result_ref: null },
    },
    meta: { trace_id: '01920000-0000-7000-8000-000000000000', span_id: '0123456789abcdef', timestamp: ISO, duration_ms: 9120 },
  };
}

describe('a scrape page under result.rows', () => {
  const BUDGET = 12_000;

  it('is trimmed on result.rows, keeps the receipt and the paging, and says how to page', () => {
    const out = applySizeBudget(rendered(scrapeEnvelope(100)), BUDGET, 'scrape_linkedin_search_people');
    const structured = out.structuredContent as { result: Record<string, unknown> };
    const rows = structured.result.rows as unknown[];

    expect(resultChars(out)).toBeLessThanOrEqual(BUDGET);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(100);
    expect(rows[0]).toEqual(personPreview(0));
    expect(structured.result.paging).toEqual({ page: 1, page_size: 100, has_more: true, total: null });
    expect(structured.result.data_request).toMatchObject({ sid: 'er_rq_000000000001', result_ref: null });
    expect(truncationOf(out)).toMatchObject({
      truncated: true,
      over_budget: false,
      list: 'result.rows',
      returned: rows.length,
      omitted: 100 - rows.length,
      rows_on_this_page: 100,
      tool: 'scrape_linkedin_search_people',
    });
    expect(truncationOf(out).how_to_get_the_rest).toContain('result.paging');
    expect(truncationOf(out).how_to_get_the_rest).toContain(`page_size: ${rows.length}`);
    expect(out.content[0].text).toContain('TRUNCATED BY THE MCP SERVER');
  });

  it('leaves a page that fits alone', () => {
    const small = rendered(scrapeEnvelope(3));
    expect(applySizeBudget(small, BUDGET)).toBe(small);
  });
});

describe('size-budget middleware', () => {
  const tool: ToolDefinition = {
    name: 'search_linkedin_accounts',
    description: 'd',
    service: 'linkedin',
    entity: 'linkedin_accounts',
    mount: 'linkedin.accounts',
    route: { service: 'linkedin', method: 'GET', pathTemplate: '/api/linkedin-accounts' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    inputSchema: z.object({ _meta: z.any().optional() }),
    outputSchema: z.any(),
    annotations: { title: 't', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  };

  const deps: RuntimeDeps = {
    config: {
      envName: 'test',
      version: '0',
      baseUrls: { linkedin: '', id: '', orchestration: '', support: '' },
      backendTimeoutMs: 1000,
      responseCharBudget: 48_000,
      maxBatchSize: 16,
      rateLimit: { enabled: false, windowSeconds: 60, callsPerWindow: 0, writesPerWindow: 0 },
      previewGate: { enabled: false, secret: null, ttlSeconds: 300 },
    },
    logger: { info() {}, error() {} },
  };

  const ctx: DispatchContext = {
    tool,
    args: {},
    scope: {
      token: 't',
      teamSid: null,
      actor: { type: 'user', sid: null },
      permissions: [],
      traceId: 'trace',
      mountPath: '/mcp/linkedin/accounts',
    },
    deps,
  };

  it('applies the configured budget to whatever the rest of the chain returned', async () => {
    const gate = makeSizeBudget(deps);
    const out = await gate(ctx, async () => rendered(searchEnvelope(50)));
    expect(resultChars(out)).toBeLessThanOrEqual(48_000);
    expect(truncationOf(out)).toMatchObject({ truncated: true, tool: 'search_linkedin_accounts' });
  });

  // The defect this block guards: a trimmed page kept the backend's pagination,
  // so a loop on has_more and next_cursor lost rows without a word.
  describe('a search page that does not fit is asked again', () => {
    const searchTool: ToolDefinition = {
      ...tool,
      inputSchema: z.object({
        page_size: z.number().optional(),
        cursor: z.string().nullable().optional(),
        _meta: z.any().optional(),
      }),
    };
    const searchCtx: DispatchContext = { ...ctx, tool: searchTool };
    const gate = makeSizeBudget(deps);

    const paddedRow = (i: number, width: number): Record<string, unknown> => ({
      item: { sid: `cr_pp_${String(i).padStart(12, '0')}`, notes: 'n'.repeat(width) },
      included: {},
    });
    const idRow = (i: number): Record<string, unknown> => ({
      item: { sid: `cr_pp_${String(i).padStart(12, '0')}` },
      included: [],
    });
    const rowsOf = (out: ToolResult): Array<{ item: { sid: string } }> =>
      (out.structuredContent as { items: Array<{ item: { sid: string } }> }).items;
    const paginationOf = (out: ToolResult): { next_cursor: string | null; has_more: boolean; total_count: number } =>
      (out.structuredContent as { pagination: { next_cursor: string | null; has_more: boolean; total_count: number } }).pagination;

    /** A backend over one table: the cursor is an offset, has_more is the truth. */
    function tableOf(rows: Array<Record<string, unknown>>) {
      const calls: Array<Record<string, unknown>> = [];
      const next = async (c: DispatchContext): Promise<ToolResult> => {
        calls.push(c.args);
        const size = typeof c.args.page_size === 'number' ? c.args.page_size : 50;
        const offset = typeof c.args.cursor === 'string' ? Number(c.args.cursor) : 0;
        const hasMore = offset + size < rows.length;
        return rendered({
          ...searchEnvelope(0),
          items: rows.slice(offset, offset + size),
          pagination: { next_cursor: hasMore ? String(offset + size) : null, has_more: hasMore, total_count: rows.length },
        });
      };
      return { calls, next };
    }

    /** What a script does: has_more and next_cursor, and nothing else. */
    async function walk(rows: Array<Record<string, unknown>>, pageSize: number) {
      const table = tableOf(rows);
      const sids: string[] = [];
      const answers: ToolResult[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 3000; guard++) {
        const out = await gate({ ...searchCtx, args: { page_size: pageSize, ...(cursor ? { cursor } : {}) } }, table.next);
        answers.push(out);
        for (const row of rowsOf(out)) sids.push(row.item.sid);
        if (!paginationOf(out).has_more) return { sids, answers, calls: table.calls };
        cursor = paginationOf(out).next_cursor;
      }
      throw new Error('the walk did not end');
    }
    const sidsOf = (rows: Array<Record<string, unknown>>): string[] =>
      rows.map((row) => (row.item as { sid: string }).sid);

    it('a has_more loop alone collects every row of a wide table, in order, once each', async () => {
      const rows = Array.from({ length: 114 }, (_, i) => accountRow(i));
      const { sids, answers } = await walk(rows, 100);

      expect(sids).toEqual(sidsOf(rows));
      for (const out of answers) expect(resultChars(out)).toBeLessThanOrEqual(48_000);
    });

    it('an ids-only walk loses nothing either: 500 thin rows are over the budget too', async () => {
      const rows = Array.from({ length: 1200 }, (_, i) => idRow(i));
      const { sids, answers } = await walk(rows, 500);

      expect(sids).toEqual(sidsOf(rows));
      expect(truncationOf(answers[0])).toMatchObject({ page_shortened: true });
      expect(rowsOf(answers[0]).length).toBeGreaterThan(400);
    });

    it('rows too wide to pair still walk through, one at a time', async () => {
      const rows = Array.from({ length: 6 }, (_, i) => paddedRow(i, 17_000));
      const { sids, answers } = await walk(rows, 50);

      expect(sids).toEqual(sidsOf(rows));
      expect(rowsOf(answers[0])).toHaveLength(1);
      expect(resultChars(answers[0])).toBeLessThanOrEqual(48_000);
    });

    it('a row wider than the whole budget goes out whole and flagged, and the walk goes on', async () => {
      const rows = Array.from({ length: 3 }, (_, i) => paddedRow(i, 60_000));
      const { sids, answers } = await walk(rows, 50);

      expect(sids).toEqual(sidsOf(rows));
      expect(rowsOf(answers[0])[0]).toEqual(rows[0]);
      expect(truncationOf(answers[0])).toMatchObject({ truncated: false, page_shortened: true, over_budget: true, omitted: 0 });
      expect(answers[0].content[0].text).toContain('over the budget all the same');
    });

    it('never answers has_more=false with rows missing: the report that started this', async () => {
      const rows = Array.from({ length: 22 }, (_, i) => paddedRow(i, 2000));
      const table = tableOf(rows);
      const out = await gate({ ...searchCtx, args: { page_size: 100 } }, table.next);
      const returned = rowsOf(out).length;

      expect(returned).toBeLessThan(22);
      expect(paginationOf(out)).toEqual({ next_cursor: String(returned), has_more: true, total_count: 22 });
      expect(truncationOf(out)).toMatchObject({
        truncated: false,
        page_shortened: true,
        over_budget: false,
        source: 'mcp_runtime',
        reason: 'response_char_budget',
        tool: 'search_linkedin_accounts',
        list: 'items',
        returned,
        omitted: 0,
        full_page_rows: 22,
        char_budget: 48_000,
      });
    });

    it('says so ahead of the payload, and points at the cursor, not away from it', async () => {
      const table = tableOf(Array.from({ length: 50 }, (_, i) => accountRow(i)));
      const out = await gate({ ...searchCtx, args: { page_size: 50 } }, table.next);
      const text = out.content[0].text;

      expect(out.content).toHaveLength(1);
      expect(text.startsWith('PAGE SHORTENED BY THE MCP SERVER.')).toBe(true);
      expect(text).toContain('follow next_cursor as usual');
      expect(text).not.toContain('Do NOT follow');
      expect(JSON.parse(text.slice(text.indexOf('\n\n') + 2))).toEqual(out.structuredContent);
    });

    it('asks again with the same filter, sort and cursor, at the size that fit', async () => {
      const table = tableOf(Array.from({ length: 200 }, (_, i) => accountRow(i)));
      const args = {
        filter: { status: { eq: 'active' } },
        sort: { field: 'created_at', direction: 'asc' },
        include: ['smart_limits'],
        cursor: '10',
        page_size: 100,
        _meta: { user_goal: 'back up the workspace' },
      };
      const out = await gate({ ...searchCtx, args }, table.next);
      const returned = rowsOf(out).length;

      expect(table.calls).toHaveLength(2);
      expect(table.calls[0]).toEqual(args);
      expect(table.calls[1]).toEqual({ ...args, page_size: returned });
      expect(paginationOf(out).next_cursor).toBe(String(10 + returned));
    });

    it('runs once when the page fits', async () => {
      const table = tableOf(Array.from({ length: 3 }, (_, i) => accountRow(i)));
      const out = await gate({ ...searchCtx, args: { page_size: 3 } }, table.next);

      expect(table.calls).toHaveLength(1);
      expect(out.structuredContent).not.toHaveProperty('truncation');
    });

    it('runs once with the budget off', async () => {
      const off = makeSizeBudget({ ...deps, config: { ...deps.config, responseCharBudget: 0 } });
      const table = tableOf(Array.from({ length: 50 }, (_, i) => accountRow(i)));
      await off({ ...searchCtx, args: { page_size: 50 } }, table.next);

      expect(table.calls).toHaveLength(1);
    });

    const notAskedTwice: Array<[string, Partial<ToolDefinition>]> = [
      ['a tool that is not read-only, on the search envelope', { annotations: { ...tool.annotations, readOnlyHint: false } }],
      ['a read-only action with a cursor', { envelope: 'action', operation: 'action' }],
      ['a search with no page_size to ask for', { inputSchema: z.object({ _meta: z.any().optional() }) }],
    ];
    it.each(notAskedTwice)('never runs %s twice: it keeps the trimmed answer and the recipe', async (_name, change) => {
      const table = tableOf(Array.from({ length: 100 }, (_, i) => accountRow(i)));
      const out = await gate({ ...searchCtx, tool: { ...searchTool, ...change }, args: { page_size: 100 } }, table.next);

      expect(table.calls).toHaveLength(1);
      expect(truncationOf(out)).toMatchObject({ truncated: true });
      expect(out.content[0].text).toContain('Do NOT follow pagination.next_cursor');
    });

    it('never scrapes twice: a paid page under result.rows keeps the trimmed answer and the recipe', async () => {
      let call = 0;
      const scrape: ToolDefinition = { ...searchTool, name: 'scrape_linkedin_search_people', envelope: 'action', operation: 'action' };
      const out = await gate({ ...searchCtx, tool: scrape, args: { page_size: 100 } }, async () => {
        call += 1;
        return rendered(scrapeEnvelope(1000));
      });

      expect(call).toBe(1);
      expect(truncationOf(out)).toMatchObject({ truncated: true, list: 'result.rows' });
      expect(out.content[0].text).toContain('Do NOT page on from result.paging');
    });

    it('a refused second read goes out as the refusal, never as half a page', async () => {
      const table = tableOf(Array.from({ length: 100 }, (_, i) => accountRow(i)));
      const refusal: ToolResult = { content: [{ type: 'text', text: 'rate_limited: retry in 12 s' }], isError: true };
      let call = 0;
      const out = await gate({ ...searchCtx, args: { page_size: 100 } }, async (c) => (++call === 1 ? table.next(c) : refusal));

      expect(call).toBe(2);
      expect(out).toEqual(refusal);
    });

    it('a backend that ignores page_size leaves the first answer and its recipe standing', async () => {
      const answer = rendered(searchEnvelope(50));
      let call = 0;
      const out = await gate({ ...searchCtx, args: { page_size: 50 } }, async () => {
        call += 1;
        return answer;
      });

      expect(call).toBe(2);
      expect(truncationOf(out)).toMatchObject({ truncated: true, rows_on_this_page: 50 });
      expect(rowsOf(out).length).toBeLessThan(50);
    });

    it('rows that grew between the two reads go out whole and flagged, with their cursor', async () => {
      const table = tableOf(Array.from({ length: 100 }, (_, i) => paddedRow(i, 2000)));
      let call = 0;
      const out = await gate({ ...searchCtx, args: { page_size: 100 } }, async (c) => {
        call += 1;
        if (call === 1) return table.next(c);
        const size = c.args.page_size as number;
        return rendered({
          ...searchEnvelope(0),
          items: Array.from({ length: size }, (_, i) => paddedRow(i, 6000)),
          pagination: { next_cursor: String(size), has_more: true, total_count: 100 },
        });
      });

      expect(call).toBe(2);
      expect(resultChars(out)).toBeGreaterThan(48_000);
      expect(paginationOf(out).next_cursor).toBe(String(rowsOf(out).length));
      expect(truncationOf(out)).toMatchObject({ truncated: false, page_shortened: true, over_budget: true });
    });

    it('logs the second read, with no row and no token in the line', async () => {
      const events: Array<Record<string, unknown>> = [];
      const logged = makeSizeBudget({ ...deps, logger: { info: (e) => events.push(e), error() {} } });
      const table = tableOf(Array.from({ length: 50 }, (_, i) => accountRow(i)));
      const out = await logged({ ...searchCtx, args: { page_size: 50 } }, table.next);

      expect(events).toEqual([
        {
          trace_id: 'trace',
          event: 'page_shortened',
          tool: 'search_linkedin_accounts',
          full_page_rows: 50,
          rows: rowsOf(out).length,
          full_response_chars: expect.any(Number),
        },
      ]);
    });
  });
});
