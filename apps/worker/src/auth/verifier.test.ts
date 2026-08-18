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
