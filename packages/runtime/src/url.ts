import type { DispatchContext } from './types';

export interface BuiltRequest {
  url: string;
  body: Record<string, unknown> | undefined;
}

// Turn a tool call into a concrete backend request:
//  - substitute {sid} (from sidParam, default 'sid') and any pathParams;
//  - GET/DELETE  → remaining args become query params (arrays as key[]=v);
//  - POST/PUT/PATCH → remaining args become the JSON body.
// `_meta` is always dropped (usage analytics, never sent to the backend).
export function buildRequest(ctx: DispatchContext): BuiltRequest {
  const { tool, args, deps } = ctx;
  const { route } = tool;
  const base = deps.config.baseUrls[route.service];
  if (!base) throw new Error(`no base URL configured for service '${route.service}'`);

  let path = route.pathTemplate;
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
    return { url: url.toString(), body: undefined };
  }

  return { url: url.toString(), body: rest };
}
