import type { AuthScope, DispatchContext, RuntimeDeps, ToolResult } from '../types';
import type { ToolMiddleware } from '../chain';
import { mapErrorEnvelope } from '../error-map';

// Abuse + cost control on the tool chain.
//
// Every tool call on this server is one HTTP call into one of our own backends
// (25s timeout, real DB work behind it), so an unbounded caller is a direct
// bill and a direct availability risk. Nothing else in the chain caps that:
// stub-gate short-circuits 15 tools, preview-gate slows down the dangerous
// ones, and the JWT check happens once per HTTP request, not per call.
//
// ── The axis ────────────────────────────────────────────────────────────────
// The subject is the TENANT, not the connection:
//
//   team:{sid}   the Team-SID header when the client sent one, else the
//                `access_identity.team_sid` claim off the bearer. This is the
//                unit that pays: the subscription, the backend load and the
//                support cost all aggregate here, so it is the only axis where
//                "too much" means anything financially.
//   actor:{...}  fallback for a token that carries no team claim at all.
//   token:{fp}   last resort, the first 8 bytes of SHA-256 over the bearer.
//                Never the bearer itself, in a key or in a log line.
//
// NOT per IP. Every request that reaches this middleware is already
// authenticated, so the IP adds no information about who is spending our
// budget, and it is actively wrong twice over: agents run behind NAT and
// serverless egress pools, so one IP bucket punishes unrelated tenants that
// happen to share an exit; and one leaked token driven from a botnet defeats
// an IP bucket entirely while the team bucket still holds. Unauthenticated
// floods never get here (the verifier rejects them with no backend hop), and
// volumetric attacks are Cloudflare's layer, not ours.
//
// Two buckets, because the two costs are not the same size. Every call spends
// from `calls`. A call the registry marks not-read-only (a mutation, a
// LinkedIn-side action, a mass-action fan-out) ALSO spends from the tighter
// `writes` bucket, so a runaway write loop is stopped long before a runaway
// read loop, which is the right order: a read costs us a query, a write costs
// us a slot out of a LinkedIn account's daily limit bucket, the support risk
// that comes with burning it, or a row somebody has to clean up.
//
// ── The mechanism ───────────────────────────────────────────────────────────
// Cloudflare's rate-limit binding when the environment binds one. It is the
// only option on Workers that counts without a storage round trip, it is
// available on the Free plan as well as Paid, and `@cloudflare/workers-types`
// already ships the type. Its cost is that the limit and the period live in
// wrangler.toml (the binding takes only a key and answers only success), and
// that counters are per-colo, so a caller spread over many colos gets a
// multiple of the nominal limit. That is fine here: the number exists to stop
// a storm, not to meter billing.
//
// When no binding is present (local dev, unit tests, an env that has not been
// given one yet) the gate falls back to an isolate-local fixed-window counter.
// That is deliberately the WEAKER honest option rather than a stronger fake:
//   - KV counters would be a lie. KV is eventually consistent and documented at
//     about one write per second per key, so under the exact traffic a limiter
//     exists for, the count is both wrong and expensive.
//   - A Durable Object per tenant would be accurate and global, but it puts a
//     stateful hop on the hot path of all 250 tools and is the thing the
//     platform binding was built to replace.
// The fallback is per isolate, so it does not stop a distributed abuser. It
// does stop the case that actually happens, a client retrying in a tight loop,
// because that client is one connection landing in one isolate. The result
// says which of the two enforced it (`context.enforcement`), so nobody reads a
// local verdict as an edge-wide guarantee.

export interface RateLimitVerdict {
  allowed: boolean;
  /** Whole seconds until this subject's window rolls over. Always >= 1. */
  retryAfterSeconds: number;
}

/** Counts hits per key in fixed windows. Injected so tests own their state. */
export interface RateLimitCounter {
  hit(key: string, limit: number, windowSeconds: number, nowMs: number): RateLimitVerdict;
}

// A long-lived isolate serving many tenants must not grow a Map forever. Above
// this many live keys the counter sheds, always preferring keys that are the
// furthest from their limit, so shedding costs the least enforcement it can.
const MAX_TRACKED_KEYS = 10_000;

export function isolateCounter(maxKeys: number = MAX_TRACKED_KEYS): RateLimitCounter {
  const windows = new Map<string, { start: number; count: number }>();

  return {
    hit(key, limit, windowSeconds, nowMs) {
      const windowMs = windowSeconds * 1000;
      const start = Math.floor(nowMs / windowMs) * windowMs;
      const retryAfterSeconds = Math.max(1, Math.ceil((start + windowMs - nowMs) / 1000));

      let entry = windows.get(key);
      if (!entry || entry.start !== start) {
        entry = { start, count: 0 };
        windows.set(key, entry);
      }
      entry.count += 1;
      const allowed = entry.count <= limit;

      if (windows.size > maxKeys) shed(windows, start, maxKeys);
      return { allowed, retryAfterSeconds };
    },
  };
}

function shed(
  windows: Map<string, { start: number; count: number }>,
  currentStart: number,
  maxKeys: number,
): void {
  for (const [key, entry] of windows) {
    if (entry.start < currentStart) windows.delete(key);
  }
  if (windows.size <= maxKeys) return;
  // Still over: more than maxKeys distinct subjects inside ONE window, which is
  // already a pathological fan-out. Drop the coldest keys first - a dropped key
  // restarts at zero, so the ones with the smallest counts lose the least.
  const coldest = [...windows.entries()].sort((a, b) => a[1].count - b[1].count);
  for (const [key] of coldest.slice(0, windows.size - maxKeys)) windows.delete(key);
}

// The isolate's shared counter. The worker rebuilds its middleware chain per
// request, so a per-chain Map would reset on every request and count nothing.
const ISOLATE_COUNTER = isolateCounter();

const encoder = new TextEncoder();

async function tokenFingerprint(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(token));
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export type RateLimitAxis = 'team' | 'actor' | 'token';

export interface RateLimitSubject {
  key: string;
  axis: RateLimitAxis;
}

/** The tenant this call is charged to, most specific billing identity first. */
export async function rateLimitSubject(scope: AuthScope): Promise<RateLimitSubject> {
  if (scope.teamSid) return { key: `team:${scope.teamSid}`, axis: 'team' };
  if (scope.tokenTeamSid) return { key: `team:${scope.tokenTeamSid}`, axis: 'team' };
  if (scope.actor.sid) return { key: `actor:${scope.actor.type}:${scope.actor.sid}`, axis: 'actor' };
  return { key: `token:${await tokenFingerprint(scope.token)}`, axis: 'token' };
}

type RateLimitBucket = 'calls' | 'writes';
type RateLimitEnforcement = 'edge_binding' | 'isolate_local';

interface RateLimitBreach {
  bucket: RateLimitBucket;
  axis: RateLimitAxis;
  limit: number;
  windowSeconds: number;
  retryAfterSeconds: number;
  enforcement: RateLimitEnforcement;
}

// The error an agent gets. Rendered through mapErrorEnvelope with the backend's
// own `rate_limited` code, so a limit hit at the edge reads EXACTLY like a limit
// hit in the service: same envelope, same "Retryable: retry after Ns." line off
// `context.retry_after`. `context.source` is the one field that differs, so a
// caller can still tell the two apart without parsing prose.
//
// The actionable part rides in `message`, not in `suggestion`: error-map's
// rate_limited branch prints the message and the retry line and nothing else,
// and an agent that only reads content[] must still learn what to do.
function rateLimitedResult(ctx: DispatchContext, breach: RateLimitBreach): ToolResult {
  const noun = breach.bucket === 'writes' ? 'write tool calls' : 'tool calls';
  const envelope = {
    success: false as const,
    error: {
      code: 'rate_limited',
      message:
        `Rate limit reached: this tenant may run ${breach.limit} ${noun} per ${breach.windowSeconds}s ` +
        `on the GTM MCP server, and ${ctx.tool.name} is over that. Nothing was sent to the backend and ` +
        'nothing changed. Wait for the window to roll over instead of retrying immediately: a tight ' +
        'retry loop only keeps the bucket full. If the work genuinely needs this rate, batch it into ' +
        'fewer, larger calls (raise page_size, use a mass-action verb) rather than more calls.',
      recoverable: true,
      suggestion: `Pause for ${breach.retryAfterSeconds}s, then continue.`,
      context: {
        source: 'mcp_runtime',
        bucket: breach.bucket,
        limit: breach.limit,
        window_seconds: breach.windowSeconds,
        retry_after: breach.retryAfterSeconds,
        enforcement: breach.enforcement,
        subject_axis: breach.axis,
      },
    },
  };
  return mapErrorEnvelope(429, envelope, ctx);
}

/**
 * Rate-limit gate. Sits ahead of stub-gate and preview-gate: a limiter a caller
 * can dodge by picking a tool name is not a limiter, and worker CPU is billed
 * whether or not the tool it targeted would have reached the backend.
 */
export function makeRateLimitGate(
  deps: RuntimeDeps,
  counter: RateLimitCounter = ISOLATE_COUNTER,
): ToolMiddleware {
  return async (ctx, next) => {
    const cfg = deps.config.rateLimit;
    if (!cfg.enabled) return next(ctx);

    const buckets: Array<{ name: RateLimitBucket; limit: number }> = [
      { name: 'calls', limit: cfg.callsPerWindow },
    ];
    // readOnlyHint comes off the registry annotations, which the contract
    // oracle keeps aligned with the backend route, so "write" here means what
    // the service says it means, not a name-prefix guess.
    if (!ctx.tool.annotations.readOnlyHint) {
      buckets.push({ name: 'writes', limit: cfg.writesPerWindow });
    }

    const subject = await rateLimitSubject(ctx.scope);
    const nowMs = deps.now?.() ?? Date.now();

    for (const bucket of buckets) {
      if (bucket.limit <= 0) continue;
      const binding = deps.rateLimiters?.[bucket.name];
      const key = `${bucket.name}:${subject.key}`;

      let allowed: boolean;
      let retryAfterSeconds: number;
      let enforcement: RateLimitEnforcement;

      if (binding) {
        enforcement = 'edge_binding';
        // The binding reports success and nothing else, so the only honest
        // retry hint is a whole window. `bucket.limit` is what the error quotes;
        // wrangler.toml's `simple.limit` is what actually enforces, and the two
        // are kept in sync there, next to the binding that owns the number.
        retryAfterSeconds = cfg.windowSeconds;
        allowed = (await binding.limit({ key })).success;
      } else {
        enforcement = 'isolate_local';
        const verdict = counter.hit(key, bucket.limit, cfg.windowSeconds, nowMs);
        allowed = verdict.allowed;
        retryAfterSeconds = verdict.retryAfterSeconds;
      }

      if (!allowed) {
        // The subject key never reaches the log, for the same reason the wide
        // event in index.ts logs `team: 'set'` rather than the sid.
        deps.logger.info({
          trace_id: ctx.scope.traceId,
          event: 'rate_limited',
          tool: ctx.tool.name,
          bucket: bucket.name,
          subject_axis: subject.axis,
          limit: bucket.limit,
          window_seconds: cfg.windowSeconds,
          enforcement,
        });
        return rateLimitedResult(ctx, {
          bucket: bucket.name,
          axis: subject.axis,
          limit: bucket.limit,
          windowSeconds: cfg.windowSeconds,
          retryAfterSeconds,
          enforcement,
        });
      }
    }

    return next(ctx);
  };
}
