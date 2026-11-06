import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { buildRegistry } from './registry';
import { resolveMounts, type MountConfig } from './mounts';
import type { ToolDefinition, ToolPackage } from './types';

// resolveMounts is the seam every mount is cut on, and it throws at module
// scope in the worker, so these pin the cut and the refusals that keep a bad
// mounts.config from booting: the selectors, the exclude, the budget, and the
// REST-only tool (surface api, 2026-11-06: a line in the REST reference and no
// tool, which no selector may serve).

function tool(name: string, mount: string, extra: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name, description: 'd', service: 'id', entity: 'things', mount,
    route: { service: 'id', method: 'POST', pathTemplate: '/api/things/search' },
    operation: 'search', envelope: 'search', availability: 'ga',
    dangerous: false, inputSchema: z.object({ _meta: z.any().optional() }), outputSchema: z.any(),
    annotations: { title: 't', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    ...extra,
  };
}

const things: ToolPackage = {
  id: 'mcp.id/things', service: 'id', entity: 'things',
  tools: [tool('search_things', 'id.things'), tool('list_things', 'id.things')],
};
const keys: ToolPackage = {
  id: 'mcp.id/keys', service: 'id', entity: 'keys',
  tools: [tool('create_key', 'id.keys', { surface: 'api' }), tool('search_keys', 'id.keys')],
};
const registry = buildRegistry([things, keys]);

const thingsMount: MountConfig = { path: '/mcp/id/things', name: 'things', selectors: [{ kind: 'package', id: 'mcp.id/things' }] };
const keysMount: MountConfig = { path: '/mcp/id/keys', name: 'keys', selectors: [{ kind: 'package', id: 'mcp.id/keys' }] };
const whole: MountConfig = { path: '/mcp', name: 'whole', selectors: [{ kind: 'service', service: 'id' }], facade: 'toolsets' };

const names = (mount: MountConfig) => resolveMounts(registry, [mount])[0].tools.map((t) => t.name);

describe('resolveMounts', () => {
  it('serves a package whole, dedupes a tool picked twice, and drops an excluded name', () => {
    expect(names(thingsMount)).toEqual(['search_things', 'list_things']);
    expect(names({ ...thingsMount, selectors: [...thingsMount.selectors, { kind: 'tool', name: 'search_things' }] })).toEqual(['search_things', 'list_things']);
    expect(names({ ...thingsMount, selectors: [...thingsMount.selectors, { kind: 'exclude', name: 'list_things' }] })).toEqual(['search_things']);
  });

  it('a REST-only tool (surface api) is served by no package or service selector, and a tool selector naming it is a config error', () => {
    expect(names(keysMount)).toEqual(['search_keys']);
    expect(names(whole)).toEqual(['search_things', 'list_things', 'search_keys']);
    expect(() => resolveMounts(registry, [{ ...keysMount, selectors: [{ kind: 'tool', name: 'create_key' }] }])).toThrow(/REST only/);
  });

  it('refuses an unknown package, an unknown tool and an over-budget domain mount', () => {
    expect(() => resolveMounts(registry, [{ ...thingsMount, selectors: [{ kind: 'package', id: 'mcp.id/nope' }] }])).toThrow(/unknown package 'mcp.id\/nope'/);
    expect(() => resolveMounts(registry, [{ ...thingsMount, selectors: [{ kind: 'tool', name: 'search_nope' }] }])).toThrow(/unknown tool 'search_nope'/);
    expect(() => resolveMounts(registry, [{ ...thingsMount, maxTools: 1 }])).toThrow(/2 tools exceeds max 1/);
    expect(resolveMounts(registry, [{ ...whole, maxTools: 1 }])[0].tools).toHaveLength(3);
  });
});
