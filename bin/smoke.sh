#!/usr/bin/env bash
# Post-deploy smoke for a DEPLOYED worker. Six checks, in the order that a
# failure is cheapest to read.
#
#   MCP_JWT=… pnpm smoke                        # https://mcp.gtm-api.com
#   MCP_JWT=… pnpm smoke <url>                  # a version preview URL, pre-promotion
#   MCP_JWT=… pnpm smoke <url> --skip-dangerous # config + read half only
#
# WHY THIS EXISTS. This repo has no staging env, deliberately (the reasoning is
# at the top of apps/worker/wrangler.toml: a staging worker would have pointed
# at the SAME beta backends, so every write it made would have been a production
# write). What a staging env was actually good for here was not being isolated,
# it was not letting the first `wrangler deploy` this project ever runs be the
# public one. That job is done by a VERSION plus this script: `wrangler versions
# upload --env production` uploads the production config WITHOUT deploying it
# and prints a preview URL carrying those exact vars, bindings and secrets, and
# this script smokes that URL before anything is promoted (DEPLOY.md step 9).
#
# READ THIS BEFORE POINTING IT AT A PREVIEW URL. A version preview is not a
# sandbox. It runs the production bindings: the production KV namespace, the
# production rate-limit counters, and the production backends. The only reason
# every check below is safe to run against it is that they were chosen to be:
# the read call reads three rows, and the dangerous call is confirmed against an
# account sid that does not exist, so the write path is exercised end to end and
# the backend answers "not found" instead of doing anything.
#
# WHAT CHECK 6 IS FOR. The preview -> confirm gate mints an HMAC commit token on
# call 1 and touches NOTHING; KV is written on call 2, and read on a replay of
# the same token. So a preview alone proves the secret is set, and nothing else.
# The KV round trip is proven by replaying the token and being told it was
# already used, which can only come from a real read of a real write. That path
# has never run anywhere: `pnpm test` has no KV, and `pnpm e2e` deliberately
# stops at the preview step. If this script has one reason to exist, it is
# check 6.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TOML="$ROOT/apps/worker/wrangler.toml"

BASE="https://mcp.gtm-api.com"
SKIP_DANGEROUS=0
for arg in "$@"; do
  case "$arg" in
    --skip-dangerous) SKIP_DANGEROUS=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    http://*|https://*) BASE="${arg%/}" ;;
    *) echo "usage: $(basename "$0") [https://worker-url] [--skip-dangerous]" >&2; exit 2 ;;
  esac
done

TOKEN="${MCP_JWT:-}"
TEAM_SID="${MCP_TEAM_SID:-}"

# The mount, the tool names and the deliberately nonexistent account.
# tests/e2e/smoke-mounts.ts names the same three; check 5 asserts they are still
# on the mount before calling them, so a rename fails with "not on the mount"
# rather than with an unreadable JSON-RPC error.
READ_MOUNT="/mcp/linkedin/accounts"
READ_TOOL="search_linkedin_accounts"
DANGEROUS_TOOL="reset_linkedin_account_sync"
ABSENT_SID="ln_ac_000000000000"

FAILURES=0
STEP_FAILURES=0
step() { STEP_FAILURES="$FAILURES"; printf '\n%s\n' "-> $1"; }
ok()   { echo "   ok: $1"; }
# A summary line worth printing only when the step it summarises passed. Without
# this a failing step still signs off with an "ok:", which is how a red run gets
# skim-read as a green one.
ok_if_clean() { [ "$FAILURES" -eq "$STEP_FAILURES" ] && ok "$1"; return 0; }
bad()  { echo "   FAIL: $1" >&2; FAILURES=$((FAILURES + 1)); }
die()  { echo "   FAIL: $1" >&2; echo "" >&2; echo "smoke: stopping here, later checks depend on this one." >&2; exit 1; }

# Read one value out of a JSON document on stdin, by dotted path. Node rather
# than jq: node is already a hard dependency of this repo and jq is not.
pick() {
  node -e '
    let raw = "";
    process.stdin.on("data", (d) => (raw += d)).on("end", () => {
      try {
        const value = process.argv[1]
          .split(".")
          .reduce((acc, key) => (acc == null ? acc : acc[key]), JSON.parse(raw));
        process.stdout.write(value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value));
      } catch { process.stdout.write(""); }
    });
  ' "$1"
}

BODY="$(mktemp)"
trap 'rm -f "$BODY"' EXIT

# GET; echoes the status code (000 when nothing answered), body into $BODY.
# curl prints 000 on a connection failure AND exits non-zero, so the `|| true`
# has to swallow the exit status rather than echo a second code of its own.
http_get() {
  local code
  code="$(curl -sS -m 20 -o "$BODY" -w '%{http_code}' -H 'accept: application/json' "$1" 2>/dev/null)" || true
  echo "${code:-000}"
}

# JSON-RPC POST to a mount; echoes the status code, leaves the body in $BODY.
rpc() {
  local path="$1" payload="$2" code
  code="$(curl -sS -m 45 -o "$BODY" -w '%{http_code}' \
    -X POST "$BASE$path" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -H "authorization: Bearer $TOKEN" \
    ${TEAM_SID:+-H "team-sid: $TEAM_SID"} \
    -d "$payload" 2>/dev/null)" || true
  echo "${code:-000}"
}

# What the repo says this deployment should be. Comparing the DEPLOYED document
# against the committed config is the point: a worker serving a resource URL
# that is not the one in wrangler.toml means someone deployed a different tree.
EXPECTED_RESOURCE="$(grep -E '^MCP_RESOURCE_URL[[:space:]]*=' "$TOML" | head -1 | sed -E 's/.*"([^"]*)".*/\1/')"
EXPECTED_ISSUER="$(grep -E '^AUTH_ISSUER[[:space:]]*=' "$TOML" | head -1 | sed -E 's/.*"([^"]*)".*/\1/')"

echo "smoke: $BASE"
echo "       expecting resource $EXPECTED_RESOURCE"

# ── 1. /health ─────────────────────────────────────────────────────────────
# The gate. Nothing below is worth reading until this is ok, and 'degraded' is
# not ok for a deploy: every degraded state here is a fail-closed piece of the
# write path missing.
step "1/6 /health"
code="$(http_get "$BASE/health")"
health="$(cat "$BODY")"
if [ "$code" = "000" ]; then
  die "nothing answered at $BASE/health. Before the first deploy the hostname does not resolve; right after it, the edge certificate can take a minute or two (a 525 or 1016 in that window is not a bad deploy)."
fi
[ "$code" = "200" ] || die "$BASE/health answered HTTP $code. 503 means the config is fatal, and the body names the var: $(printf '%s' "$health" | pick problems)"
status="$(printf '%s' "$health" | pick status)"
[ "$status" = "ok" ] || bad "status is '$status', not 'ok'. problems: $(printf '%s' "$health" | pick problems)"
for pair in "gate:armed" "commit_tokens:bound" "rate_limit.status:edge" "env:production" "auth_mode:jwt" "discovery:ok"; do
  field="${pair%%:*}"; want="${pair##*:}"
  got="$(printf '%s' "$health" | pick "$field")"
  [ "$got" = "$want" ] || bad "$field is '$got', expected '$want'."
done
ok_if_clean "$(printf '%s' "$health" | pick tools) tools across $(printf '%s' "$health" | pick mounts | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s||"[]").length)))') mounts"

# ── 2. the OAuth discovery document ────────────────────────────────────────
step "2/6 /.well-known/oauth-protected-resource"
code="$(http_get "$BASE/.well-known/oauth-protected-resource")"
prm="$(cat "$BODY")"
[ "$code" = "200" ] || die "answered HTTP $code. 503 here means AUTH_ISSUER or MCP_RESOURCE_URL is unusable."
resource="$(printf '%s' "$prm" | pick resource)"
as="$(printf '%s' "$prm" | pick authorization_servers.0)"
[ "$resource" = "$EXPECTED_RESOURCE" ] || bad "resource is '$resource', but wrangler.toml says '$EXPECTED_RESOURCE'. A client's token would carry the wrong aud."
[ "$as" = "$EXPECTED_ISSUER" ] || bad "authorization_servers[0] is '$as', but wrangler.toml says '$EXPECTED_ISSUER'."
ok_if_clean "resource $resource, authorization server $as"

# ── 3. that authorization server actually answers ──────────────────────────
# An MCP client bootstraps by following this link. A resource document that
# names a URL serving no RFC 8414 metadata is a dead end no client can recover
# from, and it is invisible from the worker's own /health.
step "3/6 the authorization server it names"
code="$(http_get "${as%/}/.well-known/oauth-authorization-server")"
meta="$(cat "$BODY")"
if [ "$code" != "200" ]; then
  bad "GET ${as%/}/.well-known/oauth-authorization-server answered HTTP $code. No MCP client can start an OAuth flow."
else
  published="$(printf '%s' "$meta" | pick issuer)"
  [ "$published" = "$as" ] || bad "it publishes issuer '$published' but is linked as '$as'. verifier.ts compares iss EXACTLY, so real tokens would 401 with 'issuer mismatch'."
  ok_if_clean "issuer $published, token endpoint $(printf '%s' "$meta" | pick token_endpoint)"
fi

# ── 4. the token's own claims ──────────────────────────────────────────────
# Decoded locally, before spending a round trip: a token minted by the wrong
# host, or before the id deploy that added the explicit issuer claim, fails the
# edge's exact-match iss check, and "401" on its own does not say which of the
# two sides is wrong.
if [ -z "$TOKEN" ]; then
  step "4/6 token claims"
  echo "   SKIPPED: MCP_JWT is not set."
  echo "   Checks 4 to 6 are the ones that prove the deploy works. Export a real token:"
  echo "     MCP_JWT=\$(…an id-minted access token for the team you want to read…) pnpm smoke $BASE"
  echo ""
  echo "smoke: INCOMPLETE. Nothing was called; the configuration half above reported $FAILURES failure(s)." >&2
  exit 1
fi
step "4/6 token claims"
claims="$(printf '%s' "$TOKEN" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=s.trim().split(".");if(p.length!==3)return process.stdout.write("{}");try{process.stdout.write(Buffer.from(p[1],"base64url").toString("utf8"))}catch{process.stdout.write("{}")}})')"
iss="$(printf '%s' "$claims" | pick iss)"
aud="$(printf '%s' "$claims" | pick aud)"
exp="$(printf '%s' "$claims" | pick exp)"
[ "$iss" = "$as" ] || bad "the token's iss is '$iss' but this worker verifies against '$as'. This is the pair that has never been checked against a real token."
if [ -n "$aud" ] && ! printf '%s' "$aud" | grep -qF "$resource"; then
  bad "the token's aud is '$aud', which does not include '$resource'. The edge rejects a present-but-wrong aud."
fi
if [ -n "$exp" ] && [ "$exp" -le "$(date +%s)" ]; then
  bad "the token expired at $exp (now $(date +%s))."
fi
ok_if_clean "iss $iss, aud ${aud:-(none)}"

# ── 5. one live read ───────────────────────────────────────────────────────
# Proves the whole path in one call: edge auth, the rate-limit gate, the gateway
# prefix, the backend, and the response budget on the way back.
step "5/6 a live read tool call"
code="$(rpc "$READ_MOUNT" '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')"
listed="$(cat "$BODY")"
[ "$code" = "200" ] || die "tools/list on $READ_MOUNT answered HTTP $code: $(head -c 300 "$BODY")"
for tool in "$READ_TOOL" "$DANGEROUS_TOOL"; do
  printf '%s' "$listed" | grep -qF "\"$tool\"" || die "'$tool' is not on $READ_MOUNT any more. This script names it directly; update it from tests/e2e/smoke-mounts.ts."
done
code="$(rpc "$READ_MOUNT" "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"$READ_TOOL\",\"arguments\":{\"page_size\":3}}}")"
read_body="$(cat "$BODY")"
if [ "$code" != "200" ]; then
  bad "HTTP $code. 401 means the token did not verify (the body says why: issuer mismatch, audience mismatch, expired): $(head -c 300 "$BODY")"
elif [ "$(printf '%s' "$read_body" | pick result.isError)" = "true" ]; then
  bad "the call returned an error envelope: $(printf '%s' "$read_body" | pick result.structuredContent.error)"
else
  ok_if_clean "$READ_TOOL answered: $(printf '%s' "$read_body" | pick result.structuredContent.pagination.total_count) row(s) visible to this token"
fi

# ── 6. the preview -> confirm -> replay round trip (the KV proof) ──────────
if [ "$SKIP_DANGEROUS" = "1" ]; then
  step "6/6 the dangerous-tool KV path"
  echo "   SKIPPED (--skip-dangerous). The commit-token write path stays unproven."
else
  step "6/6 the dangerous-tool KV path (preview, confirm, replay)"
  args="{\"sid\":\"$ABSENT_SID\",\"types\":[\"conversations\"]}"

  code="$(rpc "$READ_MOUNT" "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"$DANGEROUS_TOOL\",\"arguments\":$args}}")"
  preview="$(cat "$BODY")"
  commit_token="$(printf '%s' "$preview" | pick result.structuredContent.commit_token)"
  if [ -z "$commit_token" ]; then
    bad "the preview step minted no commit_token, so PREVIEW_TOKEN_SECRET is not armed on this deployment: $(head -c 300 "$BODY")"
  else
    ok "preview minted a token, valid for $(printf '%s' "$preview" | pick result.structuredContent.expires_in_seconds)s (nothing executed)"

    # The confirm. The gate writes the token's jti to KV BEFORE dispatching, so
    # the KV write happens even though the account does not exist and the
    # backend answers not-found. That is the whole reason this sid was chosen.
    confirm_args="{\"sid\":\"$ABSENT_SID\",\"types\":[\"conversations\"],\"commit_token\":\"$commit_token\"}"
    code="$(rpc "$READ_MOUNT" "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"$DANGEROUS_TOOL\",\"arguments\":$confirm_args}}")"
    confirm="$(cat "$BODY")"
    text="$(printf '%s' "$confirm" | pick result.content.0.text)"
    case "$text" in
      *'store is unavailable'*)
        bad "the gate refused fail-closed: the COMMIT_TOKENS KV binding does not resolve. Check the kv_namespaces id for env.production." ;;
      *'Could not record the confirmation token'*)
        bad "the gate could not WRITE to KV (fail-closed). The binding resolves but the namespace id is not one this account owns." ;;
      *)
        code_answered="$(printf '%s' "$confirm" | pick result.structuredContent.error.code)"
        if [ "$code_answered" = "not_found" ]; then
          ok "confirm passed the gate and reached the backend, which answered not_found for $ABSENT_SID (nothing was reset)"
        else
          ok "confirm passed the gate and dispatched; the backend answered '${code_answered:-a success envelope}' rather than not_found for $ABSENT_SID. Worth a look, but the gate is what this step measures."
        fi ;;
    esac

    # The replay. This is the assertion: only a real read of a real write can
    # answer "already used". KV is eventually consistent across colos, so give
    # it a few seconds rather than calling one miss a failure.
    replayed=""
    for attempt in 1 2 3 4 5; do
      code="$(rpc "$READ_MOUNT" "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\"params\":{\"name\":\"$DANGEROUS_TOOL\",\"arguments\":$confirm_args}}")"
      replayed="$(printf '%s' "$(cat "$BODY")" | pick result.content.0.text)"
      case "$replayed" in
        *'already used'*) break ;;
      esac
      sleep 2
    done
    case "$replayed" in
      *'already used'*)
        ok "the replayed token was rejected as already used: KV write AND read are live" ;;
      *)
        bad "the replayed commit token was NOT rejected (answer: ${replayed:-empty}). Single use is enforced by KV alone, so a token can currently be redeemed twice." ;;
    esac
  fi
fi

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "smoke: GREEN against $BASE"
  exit 0
fi
echo "smoke: $FAILURES check(s) FAILED against $BASE" >&2
exit 1
