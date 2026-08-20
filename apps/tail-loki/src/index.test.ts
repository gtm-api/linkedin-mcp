import { describe, expect, it } from 'vitest';
import { buildPush } from './index.js';

const wideEvent =
  '{"time":"2026-08-20T12:00:00.000Z","level":"info","trace_id":"9b194125","mount":"/mcp/support/knowledge","tool":"search_knowledge","ok":true,"dur_ms":740}';

describe('buildPush', () => {
  it('passes wide-event strings through verbatim, ns-stamped, grouped by level', () => {
    const payload = buildPush([
      {
        outcome: 'ok',
        logs: [
          { timestamp: 1787222964000, level: 'log', message: [wideEvent] },
          { timestamp: 1787222965000, level: 'error', message: ['boom'] },
        ],
        exceptions: [],
      },
    ]);
    expect(payload).not.toBeNull();
    const info = payload!.streams.find((s) => s.stream['level'] === 'INFO')!;
    expect(info.stream).toEqual({ service: 'gtm.mcp', env: 'production', level: 'INFO' });
    expect(info.values).toEqual([['1787222964000000000', wideEvent]]);
    const error = payload!.streams.find((s) => s.stream['level'] === 'ERROR')!;
    expect(error.values).toEqual([['1787222965000000000', 'boom']]);
  });

  it('ships exceptions and non-ok outcomes as ERROR lines', () => {
    const payload = buildPush([
      {
        outcome: 'exception',
        logs: [],
        exceptions: [{ timestamp: 1787222966000, name: 'TypeError', message: 'x is not a function' }],
      },
      { outcome: 'exceededCpu', eventTimestamp: 1787222967000, logs: [], exceptions: [] },
    ]);
    const error = payload!.streams.find((s) => s.stream['level'] === 'ERROR')!;
    expect(error.values.map(([, line]) => JSON.parse(line))).toEqual([
      { exception: 'TypeError', message: 'x is not a function', outcome: 'exception' },
      { outcome: 'exceededCpu' },
    ]);
  });

  it('returns null when there is nothing to ship', () => {
    expect(buildPush([{ outcome: 'ok', logs: [], exceptions: [] }])).toBeNull();
    expect(buildPush([{ outcome: 'canceled', logs: [], exceptions: [] }])).toBeNull();
  });

  it('joins non-string console args as JSON', () => {
    const payload = buildPush([
      { outcome: 'ok', logs: [{ timestamp: 1, level: 'log', message: ['a', { b: 1 }] }], exceptions: [] },
    ]);
    expect(payload!.streams[0]!.values[0]![1]).toBe('a {"b":1}');
  });

  it('orders values ascending within a stream', () => {
    const payload = buildPush([
      {
        outcome: 'ok',
        logs: [
          { timestamp: 1787222965000, level: 'log', message: ['second'] },
          { timestamp: 1787222964000, level: 'log', message: ['first'] },
        ],
        exceptions: [],
      },
    ]);
    expect(payload!.streams[0]!.values.map(([, line]) => line)).toEqual(['first', 'second']);
  });
});
