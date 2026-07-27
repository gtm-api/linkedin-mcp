import type { z } from 'zod';

export type ServiceId = 'linkedin' | 'id' | 'orchestration' | 'support';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type ToolOperation =
  | 'search' | 'get' | 'create' | 'update' | 'delete'
  | 'metrics' | 'group_by' | 'action';

export type EnvelopeKind =
  | 'search' | 'get' | 'create' | 'update'
  | 'delete_simple' | 'delete_cascade'
  | 'metrics' | 'group_by'
  | 'action' | 'action_async';

export type ToolAvailability = 'ga' | 'stub_501';

export interface RouteMeta {
  service: ServiceId;
  method: HttpMethod;
  /** Path relative to the service base URL, incl. the /api prefix and {sid}
   *  literal, e.g. '/api/linkedin-accounts/{sid}/check-premium'. */
  pathTemplate: string;
  /** Input field bound to {sid} in the template. Default 'sid'. */
  sidParam?: string;
  /** Extra {var} → input-key bindings for non-sid path params. */
  pathParams?: Record<string, string>;
  /** GET/DELETE: which input keys become query params. Default: all non-path,
   *  non-_meta keys. */
  queryParams?: string[];
}

export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  /** Always false - we only ever call our own backend. */
  openWorldHint: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  toolClass?: 'trivial' | 'typical' | 'complex' | 'meta-protocol';
  service: ServiceId;
  entity: string;
  mount: string;
  route: RouteMeta;
  operation: ToolOperation;
  envelope: EnvelopeKind;
  availability: ToolAvailability;
  /** Server-side preview→commit gate applies (destructive / paid). */
  dangerous: boolean;
  /** Response carries the §9.5 credits block. */
  creditable: boolean;
  /** ACTION verbs only: this verb's OWN surface takes a filter/targets[] set, which
   *  the owning service drains. Mirrors #[ApiMethod(..., massAction:)] (§R4). */
  massAction?: boolean;
  /** ACTION verbs only: orchestration may run this verb as a mass-action plan step,
   *  calling it once per item over the service's /internal hop. Mirrors
   *  #[ApiMethod(..., stepEligible:)] (§R4). Independent of massAction in both
   *  directions: a fan-out verb can have no executor arm, and a single-target verb
   *  can be a plan step because orchestration mints the items. */
  stepEligible?: boolean;
  /** Bulk verbs that MUST be paced (anti-spam send-class). Only meaningful on top of
   *  massAction or stepEligible: a verb that is neither cannot mandate pacing. */
  scheduleRequired?: boolean;
  /** Response fields carrying one-time secrets (exempt from redaction). */
  allowSecretFields?: string[];
  /** MUST include `_meta` (usage analytics). */
  inputSchema: z.AnyZodObject;
  /** Typed envelope schema; used by contract tests, not for SDK validation. */
  outputSchema: z.ZodTypeAny;
  annotations: ToolAnnotations;
  docsPath?: string;
  /**
   * In-worker execution instead of a backend HTTP call (e.g. the bundled
   * support knowledge index). Returns a SUCCESS envelope object; throwing maps
   * to an internal_error result. `route` stays as inert metadata for tooling.
   */
  localHandler?: (ctx: DispatchContext) => Promise<unknown>;
}

export interface ToolPackage {
  /** e.g. 'mcp.linkedin/linkedin_accounts'. */
  id: string;
  service: ServiceId;
  entity: string;
  tools: ToolDefinition[];
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  // Structural compatibility with the SDK's CallToolResult (open shape).
  [key: string]: unknown;
}

export interface AuthScope {
  /** Raw Bearer JWT - forwarded verbatim upstream; NEVER logged. */
  token: string;
  /** Team-SID header override, or null (backend falls back to the token claim). */
  teamSid: string | null;
  /**
   * Read off the token's `access_identity.actor_type` claim, so the union is
   * Core\Enums\ActorType and nothing else: `support` is a real case the backend
   * mints, and `mcp_agent` never was one (AccessIdentityValue::validate()
   * rejects it).
   */
  actor: { type: 'user' | 'support' | 'api_key' | 'system'; sid: string | null };
  permissions: string[];
  /** uuid - propagated to the backend as X-Trace-Id. */
  traceId: string;
  mountPath: string;
}

export interface Logger {
  info(event: Record<string, unknown>): void;
  error(event: Record<string, unknown>): void;
}

export interface PreviewGateConfig {
  /** True when a secret is configured. Dangerous tools refuse to run if false. */
  enabled: boolean;
  secret: string | null;
  ttlSeconds: number;
}

export interface RuntimeConfig {
  envName: string;
  version: string;
  baseUrls: Record<ServiceId, string>;
  backendTimeoutMs: number;
  responseCharBudget: number;
  previewGate: PreviewGateConfig;
}

// Single-use commit-token store (KV-backed in the worker; in-memory in tests).
export interface CommitTokenStore {
  get(jti: string): Promise<string | null>;
  put(jti: string, value: string, ttlSeconds: number): Promise<void>;
}

export interface RuntimeDeps {
  config: RuntimeConfig;
  logger: Logger;
  commitTokens?: CommitTokenStore;
  now?: () => number;
  /**
   * Worker-provided capability bindings for local tools (e.g. Vectorize/AI for
   * the support KB), keyed by consumer. Kept untyped here so the runtime stays
   * platform-agnostic; the owning package narrows its own entry.
   */
  extensions?: Record<string, unknown>;
}

export interface DispatchContext {
  tool: ToolDefinition;
  args: Record<string, unknown>;
  scope: AuthScope;
  deps: RuntimeDeps;
}
