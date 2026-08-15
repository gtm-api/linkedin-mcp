// Entity: User (gtm.service.id)
// Source of truth: product/research/gtm.service.id/entities/users.md
// Format: registry v2. Each tool carries route metadata so the generic
// dispatcher can drive it. 2 tools (the users route group), both self-scoped
// to the JWT subject (NO {sid}: the authenticated user is the only addressable
// user). All auth (register / login / refresh / verify / reset / Google OAuth)
// is public REST, never MCP, so it produces no tools here.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  usageMetaField,
  McpGetResponse,
  McpUpdateResponse,
} from '@gtm/mcp-shared';

// Includes on get-current (see research Includes).
const UserInclude = z.enum(['default_team', 'accessible_teams']);

// In-Domain user preferences / onboarding state (patched via update).
const UserConfig = z.object({
  latest_team_sid: z.string().nullable().optional()
    .describe('Which workspace to open on load (ts_tm_…); NOT default_team_sid.'),
  onboarding_completed: z.boolean().optional(),
  onboarding_steps: z.array(z.string()).optional(),
  locale: z.string().max(8).nullable().optional(),
}).passthrough();

// Tight item projection: every UserDomain field enumerated (research users.md
// #### Domain). Trailing .passthrough() tolerates forward-compatible additions.
const User = z.object({
  sid: z.string(),
  default_team_sid: z.string().nullable(),
  email: z.string(),
  email_status: z.enum(['unverified', 'verified']),
  auth_provider: z.enum(['password', 'google']),
  first_name: z.string(),
  last_name: z.string().nullable(),
  avatar_url: z.string().nullable(),
  phone: z.string().nullable(),
  timezone: z.string().nullable(),
  country: z.string().nullable(),
  config: UserConfig.nullable(),            // UserConfigValue | null (Value schema above)
  utm: z.record(z.string()).nullable(),     // Record<string,string> | null
  created_at: z.string(),
  updated_at: z.string(),
  erasure_requested_at: z.string().nullable(),
  erased_at: z.string().nullable(),
  deleted_at: z.string().nullable(),
}).passthrough();

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const base = {
  service: 'id',
  entity: 'users',
  mount: 'id.identity',
} as const;

export const usersTools: ToolDefinition[] = [
  {
    ...base,
    name: 'get_current_user',
    description:
      "Return the authenticated user's own profile: the JWT subject, self only (no {sid} form). include[]=default_team hydrates the working team; include[]=accessible_teams returns the owner + active-membership union (workspace switcher / OAuth consent multiselect). Reads email, name, timezone, default_team_sid.",
    toolClass: 'trivial',
    route: { service: 'id', method: 'GET', pathTemplate: '/api/users/current' },
    operation: 'get',
    envelope: 'get',
    availability: 'ga',
    dangerous: false,
    inputSchema: z.object({
      include: z.array(UserInclude).optional().describe('Relations to eager-load: default_team, accessible_teams.'),
      ...usageMetaField,
    }),
    outputSchema: McpGetResponse(User),
    annotations: { title: 'Get current user', ...RO },
  },
  {
    ...base,
    name: 'update_current_user',
    description:
      "Patch the authenticated user's own profile: first_name / last_name / avatar_url / phone / timezone / country / config only. email (change-email flow), password (change-password flow), auth_provider, email_status and all sids are rejected if sent. At least one field required. config merges key-by-key.",
    toolClass: 'typical',
    route: { service: 'id', method: 'PATCH', pathTemplate: '/api/users/current' },
    operation: 'update',
    envelope: 'update',
    availability: 'ga',
    dangerous: false,
    inputSchema: z.object({
      first_name: z.string().min(1).max(100).optional(),
      last_name: z.string().max(100).nullable().optional(),
      avatar_url: z.string().max(1024).nullable().optional(),
      phone: z.string().max(32).nullable().optional(),
      timezone: z.string().nullable().optional().describe('IANA tz, e.g. "Europe/Riga".'),
      country: z.string().length(2).nullable().optional().describe('ISO 3166-1 alpha-2.'),
      config: UserConfig.optional(),
      ...usageMetaField,
    }),
    outputSchema: McpUpdateResponse(User),
    annotations: { title: 'Update current user', ...WRITE },
  },
];
