import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';

// Live end-to-end for the multi-team capability (2026-08-20): a REAL OAuth
// installation minted through the full flow (DCR → authorize → consent →
// code exchange), then driven through the running worker's /mcp facade.
//
// What this proves that the unit suites cannot: the edge's team-scope
// middleware and the id AS actually agree on the RFC 8693 access-subject
// exchange wire shape, the sibling token passes the real backend guard chain
// in the sibling team, meta.team_sid/actor_type ride real envelopes, the
// refresh continuation stays un-re-pointed, and the preview gate's team
// binding holds across a live mint/verify round trip.
//
// Opt-in (RUN_E2E=1), needs: the id backend up (./dev up), the worker up
// (pnpm dev), and the DevSeeder identities - the seeded user owns TWO teams,
// which is exactly the multi-team shape this suite needs.

const RUN = process.env.RUN_E2E === '1';
const BASE = process.env.MCP_URL ?? 'http://localhost:8788';
const ID = process.env.ID_URL ?? 'http://localhost:8021';
const ID_DIR = process.env.ID_DIR ?? '/Users/eugene/sites/gtm.ai/product/backend/gtm.service.id';

const USER = 'us_mb_seeddev00001';
const TEAM_A = 'ts_tm_seeddev00001'; // the seeded user's default team
const TEAM_B = 'ts_tm_xGKWWK2Tsoaz'; // second team the same user is an active member of
const TEAM_FOREIGN = 'ts_tm_zzzzzzzzzzzz'; // well-formed, no membership

// RFC 7636 Appendix-B canonical PKCE pair (same one the backend tests use).
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const REDIRECT = 'http://localhost:9999/e2e-callback';

let installationToken = '';
let grantRefresh = '';

/** JSON-RPC into the facade mount with the OAuth installation token. */
async function rpcCallTool(params: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${installationToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'call_tool', arguments: params } }),
  });
  const json = (await res.json()) as { result?: unknown; error?: unknown };
  if (!json.result) throw new Error(`facade rpc failed: ${JSON.stringify(json).slice(0, 300)}`);
  return json.result;
}

/** The seeded user's login-shaped JWT, for the /oauth/consent leg only. */
function mintConsentJwt(): string {
  const out = execSync(
    `docker exec gtm_id_app_dev php artisan jwt:fake --team-sid=${TEAM_A} --actor-sid=${USER} --ttl=600`,
    { cwd: ID_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const found = out.match(/eyJ[A-Za-z0-9_.-]{40,}/g);
  if (!found?.length) throw new Error(`jwt:fake printed no JWT:\n${out.slice(0, 300)}`);
  return found[found.length - 1];
}

/** Full connect flow against the live id AS; returns the initial tokens. */
async function connectInstallation(): Promise<{ access: string; refresh: string; team: string }> {
  const reg = await fetch(`${ID}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'e2e team-scope', redirect_uris: [REDIRECT] }),
  });
  const client = (await reg.json()) as { client_id?: string };
  if (!client.client_id) throw new Error(`DCR failed: ${JSON.stringify(client).slice(0, 300)}`);

  const authorize = await fetch(
    `${ID}/oauth/authorize?` +
      new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        response_type: 'code',
        code_challenge: CHALLENGE,
        code_challenge_method: 'S256',
        state: 'e2e-state',
        scope: 'can_view_teams can_view_linkedin_accounts can_manage_sessions',
      }),
    { redirect: 'manual' },
  );
  const consentUrl = authorize.headers.get('location') ?? '';
  const requestId = new URL(consentUrl, ID).searchParams.get('request_id');
  if (!requestId) throw new Error(`authorize did not park a consent session: ${authorize.status} ${consentUrl.slice(0, 200)}`);

  const consentJwt = mintConsentJwt();
  const consent = await fetch(`${ID}/oauth/consent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${consentJwt}`, 'Team-SID': TEAM_A },
    body: JSON.stringify({ request_id: requestId, approve: true, team_scope_mode: 'all_my_teams' }),
  });
  const consented = (await consent.json()) as { redirect_to?: string };
  if (!consented.redirect_to) throw new Error(`consent failed: ${consent.status} ${JSON.stringify(consented).slice(0, 300)}`);
  const code = new URL(consented.redirect_to).searchParams.get('code');
  if (!code) throw new Error(`consent redirect carries no code: ${consented.redirect_to.slice(0, 200)}`);

  const token = await fetch(`${ID}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: VERIFIER, client_id: client.client_id }),
  });
  const minted = (await token.json()) as { access_token?: string; refresh_token?: string; team_sid?: string };
  if (!minted.access_token || !minted.refresh_token) throw new Error(`code exchange failed: ${token.status} ${JSON.stringify(minted).slice(0, 300)}`);
  return { access: minted.access_token, refresh: minted.refresh_token, team: minted.team_sid ?? '' };
}

beforeAll(async () => {
  if (!RUN) return;
  const flow = await connectInstallation();
  expect(flow.team).toBe(TEAM_A); // initial install team = the user's default team
  installationToken = flow.access;
  grantRefresh = flow.refresh;
}, 30_000);

const suite = RUN ? describe : describe.skip;

suite('e2e team scope (live worker + id AS, real OAuth installation)', () => {
  it('whoami without team_sid runs in the token team and meta says so', async () => {
    const r = await rpcCallTool({ name: 'get_current_user', arguments: {} });
    expect(r.isError).toBeUndefined();
    const sc = r.structuredContent as { item: { sid: string; default_team_sid: string }; meta: { team_sid: string; actor_type: string } };
    expect(sc.item.sid).toBe(USER);
    expect(sc.meta.team_sid).toBe(TEAM_A);
    expect(sc.meta.actor_type).toBe('agent'); // DCR client → actor_kind=agent → agent actor
  });

  it('top-level team_sid exchanges to a sibling team for one call', async () => {
    const r = await rpcCallTool({ name: 'get_current_user', arguments: {}, team_sid: TEAM_B });
    expect(r.isError).toBeUndefined();
    const sc = r.structuredContent as { item: { default_team_sid: string }; meta: { team_sid: string } };
    // The very confusion of the 2026-08-19 incident, now legible in one response:
    // profile default team vs the team the call actually ran in.
    expect(sc.item.default_team_sid).toBe(TEAM_A);
    expect(sc.meta.team_sid).toBe(TEAM_B);
  });

  it('the natural gesture (team_sid inside arguments) is lifted and works too', async () => {
    const r = await rpcCallTool({ name: 'search_teams', arguments: { team_sid: TEAM_B, page_size: 5 } });
    expect(r.isError).toBeUndefined();
    const sc = r.structuredContent as { applied_filters: Record<string, unknown>; meta: { team_sid: string } };
    expect(sc.meta.team_sid).toBe(TEAM_B);
    // And it is transport, not a filter: the backend never saw the key.
    expect(sc.applied_filters).not.toHaveProperty('team_sid');
  });

  it('is per-call, not sticky: the next plain call is back in the token team', async () => {
    const r = await rpcCallTool({ name: 'get_current_user', arguments: {} });
    expect((r.structuredContent as { meta: { team_sid: string } }).meta.team_sid).toBe(TEAM_A);
  });

  it('a team outside the grant/membership is refused with a forbidden envelope', async () => {
    const r = await rpcCallTool({ name: 'get_current_user', arguments: {}, team_sid: TEAM_FOREIGN });
    expect(r.isError).toBe(true);
    const err = (r.structuredContent as { error: { code: string; suggestion: string } }).error;
    expect(err.code).toBe('forbidden');
    expect(err.suggestion).toContain('consent');
  });

  it('the refresh continuation still mints the ORIGINAL team after cross-team calls', async () => {
    const res = await fetch(`${ID}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: grantRefresh }),
    });
    const json = (await res.json()) as { team_sid?: string; access_token?: string; refresh_token?: string };
    expect(res.status).toBe(200);
    expect(json.team_sid).toBe(TEAM_A); // default_install_team_sid was NOT re-stamped by the edge exchanges
    // The rotation handed back a fresh pair; keep using them so later tests
    // (and reruns) hold the live credential.
    installationToken = json.access_token ?? installationToken;
    grantRefresh = json.refresh_token ?? grantRefresh;
  });

  it('a dangerous preview binds the team: committing into another team is refused', async () => {
    const sid = 'id_se_e2eteamscope'; // well-formed, nonexistent - nothing can actually be revoked
    const preview = await rpcCallTool({ name: 'revoke_session', arguments: { sid }, team_sid: TEAM_B });
    const psc = preview.structuredContent as { preview: boolean; team_sid: string; commit_token: string };
    expect(psc.preview).toBe(true);
    expect(psc.team_sid).toBe(TEAM_B);

    const wrongTeam = await rpcCallTool({ name: 'revoke_session', arguments: { sid, commit_token: psc.commit_token } });
    expect(wrongTeam.isError).toBe(true);
    expect(String(wrongTeam.content?.[0]?.text)).toContain('team changed');

    // Committed in the RIGHT team the gate passes and the call reaches the
    // backend, which answers not_found for the nonexistent sid - full path,
    // zero side effects.
    const rightTeam = await rpcCallTool({ name: 'revoke_session', arguments: { sid, commit_token: psc.commit_token }, team_sid: TEAM_B });
    expect(rightTeam.isError).toBe(true);
    expect((rightTeam.structuredContent as { error: { code: string } }).error.code).toBe('not_found');
  });
});
