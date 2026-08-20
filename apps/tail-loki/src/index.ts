// gtm-mcp-tail: pushes gtm-mcp's console output to Grafana Cloud Loki.
//
// What it makes visible: the worker's one-line-per-JSON-RPC wide events
// ({trace_id, mount, tool, ok, dur_ms, team, actor}) next to the copilot's and
// the backends' logs. External MCP sessions - agents that never pass through
// the in-product copilot - have no other footprint in the platform's Grafana.

export interface Env {
  LOKI_PUSH_URL: string;
  LOKI_PUSH_USER: string;
  LOKI_PUSH_TOKEN: string;
}

/** Structural slice of Cloudflare's TraceItem, so the transform stays testable. */
export interface TailLogLike {
  timestamp: number;
  level: string;
  message: unknown;
}
export interface TailExceptionLike {
  timestamp: number;
  name: string;
  message: string;
}
export interface TailItemLike {
  outcome: string;
  eventTimestamp?: number | null;
  logs: readonly TailLogLike[];
  exceptions: readonly TailExceptionLike[];
}

interface LokiStream {
  stream: Record<string, string>;
  values: Array<[string, string]>;
}

const LEVELS: Record<string, string> = {
  log: 'INFO',
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
  debug: 'DEBUG',
};

/** The worker logs one JSON string per console call; join anything else. */
function lineOf(message: unknown): string {
  const parts = Array.isArray(message) ? message : [message];
  return parts.map((p) => (typeof p === 'string' ? p : (JSON.stringify(p) ?? String(p)))).join(' ');
}

/** ms epoch → ns string. BigInt because ms * 1e6 overflows Number precision. */
const ns = (tsMs: number): string => (BigInt(Math.round(tsMs)) * 1_000_000n).toString();

/** Group tail items into Loki streams; null when there is nothing to ship. */
export function buildPush(items: readonly TailItemLike[]): { streams: LokiStream[] } | null {
  const byLevel = new Map<string, Array<[string, string]>>();
  const add = (level: string, tsMs: number, line: string): void => {
    const values = byLevel.get(level) ?? [];
    values.push([ns(tsMs), line]);
    byLevel.set(level, values);
  };

  for (const item of items) {
    for (const log of item.logs) add(LEVELS[log.level] ?? 'INFO', log.timestamp, lineOf(log.message));
    for (const ex of item.exceptions) {
      add('ERROR', ex.timestamp, JSON.stringify({ exception: ex.name, message: ex.message, outcome: item.outcome }));
    }
    // exceededCpu / exceededMemory end an invocation without an exception line.
    if (item.outcome !== 'ok' && item.outcome !== 'canceled' && item.exceptions.length === 0) {
      add('ERROR', item.eventTimestamp ?? 0, JSON.stringify({ outcome: item.outcome }));
    }
  }

  if (byLevel.size === 0) return null;
  return {
    // 19-digit ns strings sort lexicographically = numerically; Loki wants
    // ascending order within a stream.
    streams: [...byLevel.entries()].map(([level, values]) => ({
      stream: { service: 'gtm.mcp', env: 'production', level },
      values: values.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    })),
  };
}

async function push(env: Env, body: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(env.LOKI_PUSH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${btoa(`${env.LOKI_PUSH_USER}:${env.LOKI_PUSH_TOKEN}`)}`,
        },
        body,
      });
      if (res.ok) return;
    } catch {
      // fall through to the retry
    }
  }
  // Out of attempts the batch is dropped: log shipping must never matter more
  // than the traffic it observes, and a tail worker has no durable buffer.
}

export default {
  async tail(events, env, ctx): Promise<void> {
    const payload = buildPush(events);
    if (!payload) return;
    ctx.waitUntil(push(env, JSON.stringify(payload)));
  },
} satisfies ExportedHandler<Env>;
