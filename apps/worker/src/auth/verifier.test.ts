import { describe, expect, it } from 'vitest';
import { makeVerifier } from './verifier';
import type { AuthConfig } from '../config';

// Claim checks for JWTs are exercised end-to-end (tests/e2e); this file pins
// the shape-routing decision the verifier makes BEFORE any JWT logic: an
// opaque `gtm_live_…` api-key bearer is forwarded for the backend guard to
// verify, never rejected as a malformed JWT (the pre-2026-08-18 behavior).

const auth: AuthConfig = {
  mode: 'jwt',
  issuer: 'https://app.gtm-api.com/id/v4',
  resource: 'https://mcp.gtm-api.com/mcp',
  devBearer: null,
} as AuthConfig;

function requestWithBearer(bearer: string, extra: Record<string, string> = {}): Request {
  return new Request('https://mcp.gtm-api.com/mcp', {
    headers: { Authorization: `Bearer ${bearer}`, ...extra },
  });
}

describe('api-key bearers', () => {
  const key = 'gtm_live_' + 'a'.repeat(40);

  it('passes an api-key bearer through as an api_key actor', () => {
    const result = makeVerifier(auth)(requestWithBearer(key));

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.scope.token).toBe(key);
    expect(result.scope.actor).toEqual({ type: 'api_key', sid: null });
    expect(result.scope.tokenTeamSid).toBeNull();
  });

  it('keeps the Team-SID header visible to the scope', () => {
    const result = makeVerifier(auth)(requestWithBearer(key, { 'Team-SID': 'ts_tm_dev000000000' }));

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.scope.teamSid).toBe('ts_tm_dev000000000');
  });

  it('still rejects a non-jwt, non-key bearer as malformed', () => {
    const result = makeVerifier(auth)(requestWithBearer('not-a-jwt-and-not-a-key'));

    expect(result.kind).toBe('fail');
    if (result.kind !== 'fail') return;
    expect(result.error).toBe('invalid_token');
  });
});

describe('X-Trace-Id canonicalization', () => {
  const key = 'gtm_live_' + 'a'.repeat(40);
  const DASHED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  function scopeFor(extra: Record<string, string> = {}) {
    const result = makeVerifier(auth)(requestWithBearer(key, extra));
    expect(result.kind).toBe('ok');
    return result.kind === 'ok' ? result.scope : (undefined as never);
  }

  it('renders a bare 32-hex OTel trace id in the dashed canonical form', () => {
    // The 2026-08-21 live break: forwarded verbatim, the backends validated it
    // as a UUID and answered 422 on every call carrying an OTel id.
    const scope = scopeFor({ 'X-Trace-Id': '1d98e7585b07a4dc6f9d4f0bae2b7a88' });
    expect(scope.traceId).toBe('1d98e758-5b07-a4dc-6f9d-4f0bae2b7a88');
  });

  it('passes a dashed uuid through, case folded', () => {
    const scope = scopeFor({ 'X-Trace-Id': '1D98E758-5B07-A4DC-6F9D-4F0BAE2B7A88' });
    expect(scope.traceId).toBe('1d98e758-5b07-a4dc-6f9d-4f0bae2b7a88');
  });

  it('mints a fresh id for garbage instead of forwarding it', () => {
    const scope = scopeFor({ 'X-Trace-Id': 'not-a-trace-id' });
    expect(scope.traceId).toMatch(DASHED);
    expect(scope.traceId).not.toContain('not-a');
  });

  it('mints a fresh id for the all-zero W3C invalid-trace sentinel', () => {
    const scope = scopeFor({ 'X-Trace-Id': '0'.repeat(32) });
    expect(scope.traceId).toMatch(DASHED);
    expect(scope.traceId).not.toBe('00000000-0000-0000-0000-000000000000');
  });

  it('mints a fresh id when the header is absent', () => {
    expect(scopeFor().traceId).toMatch(DASHED);
  });
});
