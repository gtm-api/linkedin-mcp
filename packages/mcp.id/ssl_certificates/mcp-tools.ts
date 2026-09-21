// Entity: SSL Certificate (gtm.service.id)
// Source of truth: product/research/gtm.service.id/entities/ssl_certificates.md
// Format: registry v2. Each tool carries route metadata so the generic
// dispatcher can drive it. 7 tools (the ssl-certificates route group), mounted on
// id.platform. Let's Encrypt certs for customers' custom email domains (ACME
// HTTP-01, full issuer chain). The cert body and private key are returned by NO
// tool. issue/renew are async (mcpAsyncAction → action_async); poll get.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  AccessIdentityValueActorTypeEnum,
  filterOp,
  usageMetaField,
  McpAsyncActionResponse,
  McpCreateResponse,
  McpGetRequestSchema,
  McpGetResponse,
  McpSearchRequestSchema,
  McpSearchResponse,
  McpSimpleDeleteRequestSchema,
  McpSimpleDeleteResponse,
  McpUpdateResponse,
} from '@gtm/mcp-shared';

const SID = z.string().length(18).startsWith('id_sc_')
  .describe('SSL certificate sid (id_sc_…).');

const SslCertificateStatus = z.enum(['pending', 'challenge', 'active', 'failed', 'expired']);

// Loose item / counts schemas: the full field set is tightened by the Stage-1
// contract tests against live envelopes; passthrough keeps live responses valid.
// certificate_pem / chain_pem / private_key are NEVER present (persistence-only).
const SslCertificate = z.object({
  sid: z.string(),
  team_sid: z.string(),
  domain: z.string(),
  status: SslCertificateStatus,
  // The in-flight attempt's HTTP-01 token + key-authorization: set while an
  // attempt runs (status=challenge on a first issuance, status=active on a
  // renewal); null otherwise.
  challenge: z.object({
    type: z.literal('http-01'),
    token: z.string(),
    key_authorization: z.string(),
    well_known_path: z.string(),
    cname_target: z.string(),
    expires_at: z.string().nullable(),
  }).nullable(),
  issuer: z.string().nullable(),
  issued_at: z.string().nullable(),
  expires_at: z.string().nullable(),
  last_error: z.string().nullable(),
  // Shared AccessIdentityValue (general/KNOWLEDGE.md); passthrough tolerates
  // cross-service serialization drift.
  created_by: z.object({
    actor_type: AccessIdentityValueActorTypeEnum,
    actor_sid: z.string(),
    team_sid: z.string(),
    permissions: z.record(z.unknown()),
    request_sid: z.string().nullable().optional(),
    reason: z.string().nullable(),
  }).passthrough(),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
}).passthrough();

const SslCertificateCounts = z.object({}).passthrough();

const SslCertificateFilter = z.object({
  sid: filterOp(z.string(), ['eq', 'in']).optional(),
  domain: filterOp(z.string(), ['eq', 'in']).optional()
    .describe('Exact FQDN match (lowercased server-side); no full-text.'),
  status: filterOp(SslCertificateStatus, ['eq', 'ne', 'in', 'nin']).optional(),
  expires_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional()
    .describe('"Expiring soon" view = { lte: <+30d> }.'),
  created_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  deleted_at: filterOp(z.string(), ['is_null', 'gte', 'lte']).optional()
    .describe('Default scope is { is_null: true } (live rows).'),
}).partial();

// No 'domain', deliberately, and NOT because the entity cannot sort by it:
// research/gtm.service.id/entities/ssl_certificates.md §Sortable fields lists it
// and the column is indexed, but SslCertificateSearchRequest validates
// sort.field against in:"created_at","expires_at","status" and 422s on domain.
// Advertising a sort that always fails is worse than not advertising it; the
// backend's in: list is what actually runs, so this mirrors the list and the
// research/FormRequest disagreement is a backend finding, not a tool decision.
const SslCertificateSortable = z.enum(['created_at', 'expires_at', 'status']);

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
// Mutating tools go through the server preview→commit gate (dangerous). create /
// update / delete are idempotent; issue / renew request a fresh ACME authorization
// each call, so they are not.
const DANGER_IDEM = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
const DANGER = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

const base = {
  service: 'id',
  entity: 'ssl_certificates',
  mount: 'id.platform',
} as const;

export const sslCertificatesTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_ssl_certificates',
    description:
      "List the team's TLS certificates for custom email domains: which domains are registered, each status, issuer, issued_at, expires_at, and the redacted last_error for failures. Filter by status for live vs failed, by expires_at:{lte} for certificates expiring soon, or by domain for a specific FQDN. The certificate body and private key are never returned. Returns a counts block of predicate tallies; page_size:0 returns counts only.",
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/ssl-certificates/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    inputSchema: McpSearchRequestSchema(SslCertificateFilter, undefined, SslCertificateSortable)
      // The SearchRequest declares no include rule and the controller builds no
      // included block, so advertising the param would be a silent no-op.
      .omit({ include: true }),
    outputSchema: McpSearchResponse(SslCertificate, undefined, SslCertificateCounts),
    annotations: { title: 'Search SSL certificates', ...RO },
  },
  {
    ...base,
    name: 'get_ssl_certificate',
    description:
      "Fetch a single certificate by sid: status, issuer, validity window, redacted last_error, and the HTTP-01 challenge data while an attempt is in flight (status='challenge' on a first issuance, 'active' during a renewal). Poll this after issue/renew until challenge is null: a first issuance ends 'active' or 'failed' with last_error; a renewal stays 'active', with last_error null when the new certificate is live and set when it failed (the current one keeps serving). The cert body and key are never returned.",
    toolClass: 'trivial',
    route: { service: 'id', method: 'GET', pathTemplate: '/api/ssl-certificates/{sid}', sidParam: 'sid' },
    operation: 'get',
    envelope: 'get',
    availability: 'ga',
    dangerous: false,
    inputSchema: McpGetRequestSchema('id_sc_'),
    outputSchema: McpGetResponse(SslCertificate),
    annotations: { title: 'Get SSL certificate', ...RO },
  },
  {
    ...base,
    name: 'create_ssl_certificate',
    description:
      "Register a custom domain as a certificate row in status='pending'. Does NOT start ACME; call issue_ssl_certificate next to begin the HTTP-01 flow. Idempotent on the domain natural key, and already_exists says whether the row was left as found. true: the team's row is returned as it stands (pending, active, or an attempt in flight whatever the status), nothing was written. false: a new row, or a failed/expired row with nothing in flight or a soft-deleted row recreated in place (same sid, reset to pending, challenge and last_error cleared; read last_error with get_ssl_certificate first if the reason matters). A domain whose certificate is active in another team returns 409 conflict (domain_active_in_another_team). A domain another team has only registered is not refused: the first certificate to go active holds it.",
    toolClass: 'typical',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/ssl-certificates' },
    operation: 'create',
    envelope: 'create',
    availability: 'ga',
    dangerous: true,
    inputSchema: z.object({
      domain: z.string().max(253)
        .describe('FQDN, e.g. "track.client.com"; lowercased server-side; unique among live rows.'),
      ...usageMetaField,
    }),
    outputSchema: McpCreateResponse(SslCertificate),
    annotations: { title: 'Register SSL certificate', ...DANGER_IDEM },
  },
  {
    ...base,
    name: 'update_ssl_certificate',
    description:
      'Metadata-only partial update. No certificate-affecting field is mutable here: domain, status, challenge, issuer and validity are driven by the ACME actions and jobs, never by update. v1 has no client-mutable field, so any body returns 422 nothing_to_update; the endpoint exists for surface symmetry.',
    toolClass: 'typical',
    route: { service: 'id', method: 'PATCH', pathTemplate: '/api/ssl-certificates/{sid}', sidParam: 'sid' },
    operation: 'update',
    envelope: 'update',
    availability: 'ga',
    dangerous: true,
    inputSchema: z.object({ sid: SID, ...usageMetaField }),
    outputSchema: McpUpdateResponse(SslCertificate),
    annotations: { title: 'Update SSL certificate', ...DANGER_IDEM },
  },
  {
    ...base,
    name: 'delete_ssl_certificate',
    description:
      'Remove a custom domain\'s certificate. DESTRUCTIVE. Revokes the certificate at the CA (best-effort), removes the on-disk serving files, and soft-deletes the row. The CA-revoke and file-removal are external side effects, not a DB cascade, so this is a simple delete. No recovery: re-create + re-issue to restore.',
    toolClass: 'typical',
    route: { service: 'id', method: 'DELETE', pathTemplate: '/api/ssl-certificates/{sid}', sidParam: 'sid' },
    operation: 'delete',
    envelope: 'delete_simple',
    availability: 'ga',
    dangerous: true,
    inputSchema: McpSimpleDeleteRequestSchema('id_sc_'),
    outputSchema: McpSimpleDeleteResponse,
    annotations: { title: 'Delete SSL certificate', ...DANGER_IDEM },
  },
  {
    ...base,
    name: 'issue_ssl_certificate',
    description:
      "Start the ACME HTTP-01 flow for a registered domain. ASYNC: synchronously requests authorization from Let's Encrypt, stores the token + key-authorization, flips status→challenge, and returns the challenge data + a pending ref; the platform then self-checks, validates, finalizes and flips status→active in the background (poll get_ssl_certificate, or await the ssl-certificates.issued / .failed webhook). Use after create. Not idempotent: each call requests a fresh authorization. 409 conflict if the domain is already active (use renew), while an attempt is in flight (issuance_already_in_progress), or while another team's certificate for the domain is active (domain_active_in_another_team: nothing was started and retrying cannot help). An attempt already in flight when that happens ends failed, with last_error opening with the same reason.",
    toolClass: 'complex',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/ssl-certificates/{sid}/issue', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action_async',
    availability: 'ga',
    dangerous: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: SID, ...usageMetaField }),
    outputSchema: McpAsyncActionResponse(SslCertificate),
    annotations: { title: 'Issue SSL certificate', ...DANGER },
  },
  {
    ...base,
    name: 'renew_ssl_certificate',
    description:
      'Force a re-issue of an existing certificate, ignoring the 30-day expiry window (operator-forced). ASYNC: same HTTP-01 path as issue and the auto-renew job, on the same row. On an active certificate the row STAYS active (it keeps serving and routing) while challenge carries the attempt: on success the persisted leaf / full chain / key are replaced and issued_at / expires_at re-stamped, on failure last_error is set and the current certificate keeps serving. On a pending/failed/expired row nothing is serving, so it flips status→challenge and ends active or failed like issue. Poll get_ssl_certificate until challenge is null, or await ssl-certificates.renewed / .failed. Use after a CA chain fix, to retry a failing renewal once its cause is fixed, or to recover a failed/expired certificate. 409 conflict while an attempt is in flight (issuance_already_in_progress, e.g. the renew job\'s) or while another team\'s certificate for the domain is active (domain_active_in_another_team, retrying cannot help).',
    toolClass: 'complex',
    route: { service: 'id', method: 'POST', pathTemplate: '/api/ssl-certificates/{sid}/renew', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action_async',
    availability: 'ga',
    dangerous: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: SID, ...usageMetaField }),
    outputSchema: McpAsyncActionResponse(SslCertificate),
    annotations: { title: 'Renew SSL certificate', ...DANGER },
  },
];
