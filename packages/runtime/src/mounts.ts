import type { Registry } from './registry';
import type { ServiceId, ToolDefinition } from './types';

export type ToolSelector =
  | { kind: 'package'; id: string }
  | { kind: 'service'; service: ServiceId }
  | { kind: 'tool'; name: string }
  | { kind: 'exclude'; name: string };

export interface MountConfig {
  /** URL path this mount is served at, e.g. '/mcp/linkedin/accounts'. */
  path: string;
  /** MCP server name reported in `initialize`. */
  name: string;
  /** Thin (<2.4KB) server instructions. */
  instructions?: string;
  selectors: ToolSelector[];
  /** Hard cap; default 25. Facade mounts are exempt for their backing set. */
  maxTools?: number;
  /** 'toolsets' = meta-tool facade over the same registry (unified endpoint). */
  facade?: 'none' | 'toolsets';
}

export interface ResolvedMount {
  config: MountConfig;
  tools: ToolDefinition[];
}

// Resolve each mount's selectors into a concrete, deduped, budget-checked tool
// list. Throws on unknown targets or an over-budget non-facade mount, so a bad
// mounts.config fails at module load and in CI.
export function resolveMounts(registry: Registry, configs: MountConfig[]): ResolvedMount[] {
  return configs.map((config) => {
    const picked = new Map<string, ToolDefinition>();
    const excludes = new Set(
      config.selectors.flatMap((s) => (s.kind === 'exclude' ? [s.name] : [])),
    );

    for (const sel of config.selectors) {
      if (sel.kind === 'package') {
        const pkg = registry.packages.find((p) => p.id === sel.id);
        if (!pkg) throw new Error(`mount ${config.path}: unknown package '${sel.id}'`);
        for (const t of pkg.tools) picked.set(t.name, t);
      } else if (sel.kind === 'service') {
        for (const p of registry.packages) {
          if (p.service === sel.service) for (const t of p.tools) picked.set(t.name, t);
        }
      } else if (sel.kind === 'tool') {
        const entry = registry.byName.get(sel.name);
        if (!entry) throw new Error(`mount ${config.path}: unknown tool '${sel.name}'`);
        picked.set(sel.name, entry.tool);
      }
    }
    for (const name of excludes) picked.delete(name);

    const tools = [...picked.values()];
    const max = config.maxTools ?? 25;
    if (config.facade !== 'toolsets' && tools.length > max) {
      throw new Error(`mount ${config.path}: ${tools.length} tools exceeds max ${max}`);
    }
    return { config, tools };
  });
}
