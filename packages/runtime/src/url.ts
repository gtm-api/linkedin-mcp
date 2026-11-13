import type { DispatchContext } from './types';

export interface BuiltRequest {
  url: string;
  body: Record<string, unknown> | undefined;
  /** The route's own headers (route.headerParams), without the ones every call carries. */
  headers: Record<string, string>;
}

// A header value is printable ASCII and nothing else: a line break in one would
// be a second header of the caller's choosing.
const HEADER_VALUE_RE = /^[\x20-\x7E]+$/;

// The headers backend-client.ts sets on every call, lowercase. A route may not
// bind one (route.headerParams): header names are case-insensitive on the wire,
// so `authorization` beside `Authorization` would reach the backend as one
// header with two values. buildRegistry refuses the binding at build time and
// buildRequest refuses it again at call time.
export const RESERVED_HEADERS: ReadonlySet<string> = new Set([
  'authorization', 'team-sid', 'x-trace-id', 'accept', 'content-type', 'content-length', 'cookie', 'host',
]);

// Turn a tool call into a concrete backend request:
//  - substitute {sid} (from sidParam, default 'sid') and any pathParams;
//  - lift the route's headerParams out of the args into headers;
//  - GET/DELETE  → remaining args become query params (arrays as key[]=v);
//  - POST/PUT/PATCH → remaining args become the JSON body.
// `_meta` is always dropped (usage analytics, never sent to the backend).
// The validate twin of the public API (gtm.lib.common Core/Http/ValidateOnly): the
// same routes mounted under `api/_validate`, authenticated and validated the same
// way, whose actions never run. A backend that has no twin answers 404 there.
export const VALIDATE_TWIN_PREFIX = '/api/_validate/';

export function buildRequest(ctx: DispatchContext, opts: { validateOnly?: boolean } = {}): BuiltRequest {
  const { tool, args, deps } = ctx;
  const { route } = tool;
  const base = deps.config.baseUrls[route.service];
  if (!base) throw new Error(`no base URL configured for service '${route.service}'`);

  let path = route.pathTemplate;
  if (opts.validateOnly) {
    if (!path.startsWith('/api/')) throw new Error(`tool ${tool.name}: only /api routes have a validate twin`);
    path = VALIDATE_TWIN_PREFIX + path.slice('/api/'.length);
  }
  // _meta (usage analytics) is never sent to the backend.
  //
  // `commit_token` belongs to the preview gate, which only runs on
  // `dangerous: true` tools: it injects the field into their input schema
  // (server-factory.ts) and strips it again before dispatch, so dropping it here
  // is belt-and-suspenders for exactly that case. On a NON-dangerous tool no gate
  // ever touched the args, so the field is the tool's own and must reach the
  // backend: gtm.service.orchestration's `create_mass_action` takes the
  // commit_token its own `preview` minted, and swallowing it here would make
  // every commit fail as "commit_token required".
  const consumed = new Set<string>(['_meta']);
  if (tool.dangerous) consumed.add('commit_token');

  if (path.includes('{sid}')) {
    const key = route.sidParam ?? 'sid';
    const value = args[key];
    if (typeof value !== 'string') {
      throw new Error(`tool ${tool.name}: expected string '${key}' for {sid}`);
    }
    path = path.replace('{sid}', encodeURIComponent(value));
    consumed.add(key);
  }

  if (route.pathParams) {
    for (const [tpl, key] of Object.entries(route.pathParams)) {
      const value = args[key];
      if (typeof value !== 'string' && typeof value !== 'number') {
        throw new Error(`tool ${tool.name}: expected '${key}' for {${tpl}}`);
      }
      path = path.replace(`{${tpl}}`, encodeURIComponent(String(value)));
      consumed.add(key);
    }
  }

  // The route's own headers. The bound key never reaches the body or the query,
  // whether or not the caller sent it: the backend reads it off the request.
  const headers: Record<string, string> = {};
  if (route.headerParams) {
    for (const [header, key] of Object.entries(route.headerParams)) {
      if (RESERVED_HEADERS.has(header.toLowerCase())) {
        throw new Error(`tool ${tool.name}: the ${header} header is set by the runtime and cannot be bound to '${key}'`);
      }
      consumed.add(key);
      const value = args[key];
      if (value === undefined || value === null || value === '') continue;
      if (typeof value !== 'string' || !HEADER_VALUE_RE.test(value)) {
        throw new Error(`tool ${tool.name}: expected '${key}' to be a plain string for the ${header} header`);
      }
      headers[header] = value;
    }
  }

  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (consumed.has(key) || value === undefined) continue;
    rest[key] = value;
  }

  const url = new URL(base.replace(/\/$/, '') + path);

  if (route.method === 'GET' || route.method === 'DELETE') {
    const keys = route.queryParams ?? Object.keys(rest);
    for (const key of keys) {
      const value = rest[key];
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(`${key}[]`, String(item));
      } else if (typeof value === 'object') {
        url.searchParams.set(key, JSON.stringify(value));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    return { url: url.toString(), body: undefined, headers };
  }

  return { url: url.toString(), body: rest, headers };
}
