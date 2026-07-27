# Deploying gtm.mcp to Cloudflare

ONE deployable environment.

| Env | Command | Lands on |
|---|---|---|
| default | `pnpm dev` | `wrangler dev` on :8788, no cloud bindings, no account needed |
| `production` | `pnpm deploy:production` | **https://mcp.gtm-api.com** (custom domain) |

Local development is unaffected by everything below: the default env has no cloud
bindings, talks to the Docker backends on :8020 / :8021 / :8025, and the support KB
serves from the bundled BM25 index.

**There is no staging env, on purpose.** It used to exist as a second worker on
workers.dev and it was the wrong shape: it pointed at the same beta backends as
production, because there is no backend staging tier, so every write it made was a
production write, which is the one thing a staging env is supposed to protect you from.
Eugene's decision (2026-07-27) is that local development keeps using local services,
which leaves nobody who would have developed against it. The one job it did do here,
not letting the first `wrangler deploy` this project ever runs be the public one, is
done by step 9 instead: upload the production config as an **undeployed version**, smoke
its preview URL, then promote. That rehearses the bytes that go live rather than a
different worker resembling them.

> The production script is `deploy:production`, not `deploy`, because **`pnpm deploy`
> is a pnpm built-in** (it packs a workspace package into a deployable directory) and
> shadows a script of that name. `pnpm deploy` here does not run wrangler at all: it
> exits with `ERR_PNPM_NOTHING_TO_DEPLOY`. A colon-suffixed name has no such clash.

# First production release

**This is the only ordered list. Follow it top to bottom.** It spans four repositories,
because the worker cannot be the first thing deployed: three of its preconditions live in
`gtm.service.id`, the ansible repo and the orchestration host. Everything below was
prepared on 2026-07-27 by four parallel sessions and reconciled into one sequence here.

The steps numbered **1 to 20** are cross repo and run once, for this first release. The
steps numbered **W1 to W12** are the worker's own runbook, unchanged, and they keep the
numbers that `wrangler.toml`, `bin/smoke.sh` and `bin/deploy-preflight.mjs` refer to as
"DEPLOY.md step N": W4 is step 4 in [The runbook](#the-runbook), W9 is step 9, and so on.
Their detail sections live below and are worth reading; the list here is the order and the
pass/fail line for each.

## Why the order is the order

Four dependencies, each of which fails as something that looks unrelated when it is done
out of sequence:

| If you do this too early | What you see | What is actually wrong |
|---|---|---|
| Promote the worker before **gtm.service.id** is deployed | every real token 401s with `issuer mismatch` | `verifier.ts` compares `payload.iss` to `AUTH_ISSUER` with `!==`. A host on the old code mints a per-endpoint issuer (`https://app.gtm-api.com/auth/login`). |
| Deploy **linkedin or orchestration** before the permissions backfill | api keys and OAuth installation tokens get `403 forbidden / scope_missing` on tools that worked yesterday | permission enforcement now defaults **ON**, and `TeamService::ownerPermissions()` had been seeding team owners with the 19 id-owned tokens and **no channel tokens at all**. Step 6 is what fills them in. |
| Publish the `/orchestration/v4` gateway prefix before the orchestration app is deployed | `502` on the whole prefix | nginx has a route with nothing serving behind it. |
| Run the worker preflight or deploy before the prefix is published | `/health` 503 and **every** mount dead, not just the two orchestration mounts | `requiredBaseUrlServices()` includes `orchestration`, so an unusable `ORCHESTRATION_BASE_URL` is fatal to the whole worker. |

One thing that is **not** a dependency, and does not need a maintenance window: the web
app. `App\Auth\LoginTokenMinter` mints `tokens: ['*']` for every logged-in human, so a
browser session cannot be refused by the permission flip even in principle. The exposure
is api keys and OAuth grants only, which is exactly what step 5 counts.

## Already done, do not redo

Committed or in the working tree, verified, and needing nothing from Eugene.

| Area | State |
|---|---|
| **id issuer claim** | `config/jwt.php` gains `jwt.issuer` (`JWT_ISSUER` or `APP_URL`, trailing slash stripped); `App\Auth\IssuerClaimFactory` is bound over the package claim factory in `AppServiceProvider`, so login, `/auth/refresh`, all three OAuth grants, `jwt:fake` and `User::forIdentity()` all emit it; `OAuthFlowController::issuer()` reads the same key, so token `iss` = RFC 8414 `issuer` = RFC 9728 `authorization_servers[0]`. **No new env var**: `app_url` in `host_vars/id-beta.yml` is already `https://app.gtm-api.com/id/v4` and `roles/app_id/templates/overlay.j2` renders `APP_URL` from it. Live-verified end to end against the running id container. |
| **Worker auth config** | `AUTH_ISSUER = "https://app.gtm-api.com/id/v4"` and `ORCHESTRATION_BASE_URL = "https://app.gtm-api.com/orchestration/v4"` are filled in `wrangler.toml`. `verifier.ts` and `config.ts` needed no change. A new test block pins the production issuer shape and refuses six same-origin variants, including the three legacy per-endpoint issuers. |
| **Gateway route** | `/orchestration/v4` is uncommented in `gateway_routes` with `internal: "deny"`, pointing at `gateway_orchestration_backend: "65.109.84.210:80"`. The template was rendered against the live host_vars and emits the same three blocks as `/linkedin/v4`, plus the case-insensitive `$gtm_denied_internal` map entry. |
| **Vault schema** | `host_vars/id-beta.vault.example.yml` gains `vault_orchestration_access_key`; `host_vars/orchestration-beta.yml` gains `orchestration_access_key_previous_expires_at`. `orchestration-beta.vault.example.yml` needed no change. |
| **`sync-ansible-vault.sh`** | Real bug fixed before it bit: the MAP still emitted the retired flat `vault_linkedin_access_key` / `vault_emails_access_key`. Nothing reads those any more, and an unmapped key is skipped **silently**, so step 12 would have produced a vault with no `vault_cluster1_linkedin_access_key` and the failure would have shown up as `401 bad_access_key` per mass-action item on a live host. |
| **Permission enforcement** | `enforce` defaults **true** in linkedin and orchestration (`config/permissions.php`, with an empty-string guard so a bare `PERMISSIONS_ENFORCE=` cannot silently disarm it); `undeclared => 'closed'` in all three services; id keeps no `enforce` switch by design. 13 previously ungated id routes declared, 4 new tokens added, `PermissionCatalog` (47 live tokens, 2 retired) is now the single source for owner/admin/member presets, `permissions.refused` logging carries `identity_reason`, and a `PermissionDeclarationScan` test per service fails the build on an undeclared or off-catalog route. Coverage: id 81 routes (78 gated, 3 open by name), linkedin 150, orchestration 21, zero undeclared anywhere. |
| **`permissions:backfill`** | Command exists in gtm.service.id, dry-run proven, 10 tests. |
| **Worker deploy tooling** | Custom domain rather than a route, no staging env; `bin/deploy-preflight.mjs` rewritten into three phases with seven new checks; `bin/smoke.sh` written and exercised end to end against a local worker, including the KV commit-token replay, which had never been executed anywhere in this repo. |
| **Docs** | `RUNBOOK-orchestration.md`, `RUNBOOK-handover.md`, `gtm.deployment.ansible/README.md`, `inventory/beta.ini`, `run.txt` all updated off the real state. |

Nothing has been deployed. No Cloudflare resource exists yet, no ansible has run against a
host, no `wrangler login` has happened.

## Phase 0. Before anything is committed or pushed

### 1. Rescue 66 files staged as deleted (Eugene, before the commit)

The git index in three backend repos has files staged as **deleted** that are still on
disk, so a commit taken as is would delete them. Verified 2026-07-27: 62 in
`gtm.lib.common` (including `ContractOracle.php`, `ResponseMirror.php`,
`CheckPermissionsWhenEnabled.php`), 2 in `gtm.service.linkedin` and 2 in
`gtm.service.orchestration` (`config/permissions.php` + `PermissionEnforcementTest.php` in
each). The staged deletions in `gtm.service.id` (1) and `gtm.service.email` (67) are
**real**, those files are genuinely gone: do not touch them.

```bash
cd /Users/eugene/sites/gtm.ai/product/backend
for r in gtm.lib.common gtm.service.linkedin gtm.service.orchestration; do
  git -C $r diff --cached --name-only --diff-filter=D | while read f; do
    [ -f "$r/$f" ] && git -C $r add -- "$f"
  done
done
```

**Check.** Prints nothing:

```bash
git -C gtm.lib.common diff --cached --name-status --diff-filter=D | while read s f; do
  [ -f "gtm.lib.common/$f" ] && echo "STILL AT RISK: $f"
done
```

**If it differs.** A file listed that is genuinely gone is fine and belongs in the commit;
the loop only re-adds paths that still exist on disk, so it cannot resurrect a real
deletion.

**Rollback.** Index only, nothing is written to a tree. `git reset` and start again.

### 2. Push master on the four backend repos (Eugene, after the commit)

Every ansible deploy clones from Bitbucket at a pinned ref, and every one of them is
`master` (`service_ref` in each `host_vars`, `lib_ref` in `group_vars/all.yml`). Local
commits are invisible to a deploy. As of 2026-07-27 all four were ahead of `origin/master`
with the work above still uncommitted on top.

```bash
cd /Users/eugene/sites/gtm.ai/product/backend
for r in gtm.lib.common gtm.service.id gtm.service.linkedin gtm.service.orchestration; do
  git -C $r push origin master
done
```

**Check.** `git -C $r status -sb | head -1` says `## master...origin/master` with no
`ahead` for all four.

**If it differs.** A rejected push means someone else moved master: rebase, re-run the
service's own `composer test` and `phpstan`, then push. Do **not** deploy from a branch by
editing `service_ref`; the runbooks, the vault and the CI all assume master.

**Rollback.** None needed, this is the state every later step reads.

## Phase 1. gtm.service.id

The trust root goes first, both for the issuer and because the backfill command only
exists on a host running this code.

### 3. Deploy gtm.service.id (Eugene)

```bash
cd /Users/eugene/sites/gtm.ai/product/deployment/gtm.deployment.ansible
ansible-playbook deploy-id.yml -i inventory/beta.ini --limit id-beta \
  --ssh-common-args='-C -o ControlMaster=auto -o ControlPersist=900s -o StrictHostKeyChecking=accept-new' \
  --vault-password-file ~/.gtm-secrets/.vault_pass_gtm
```

**Expect.** Recap `0 failed`. The role clones both trees at master, renders `.env`,
composer installs, migrates, and runs `config:cache` last.

**If it differs.** An SSH hang means you are off the VPN: `mgmt_allowed_ips` in
`group_vars/all.yml` is the only source range `roles/security` opens SSH from. A composer
failure cloning `gtm.lib.common` means hero's key lost its Bitbucket read access.

**Rollback.** Re-deploy the previous commit by pinning `service_ref` to it and re-running.
Note there is **no** partial rollback of the issuer: the old value was the minting
endpoint's URL, which is per path and not reproducible from config.

### 4. Prove the issuer, three ways (Eugene)

```bash
curl -s https://app.gtm-api.com/id/v4/.well-known/oauth-authorization-server | jq -r .issuer
curl -s https://app.gtm-api.com/id/v4/.well-known/oauth-protected-resource | jq -r '.authorization_servers[0]'
```

**Expect.** Both print exactly `https://app.gtm-api.com/id/v4`, byte for byte, no trailing
slash. Then mint a real token and decode it:

```bash
# from any client that can log in, or on the host: php artisan jwt:fake --team-sid=…
echo "$TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null | jq -r .iss
```

That must print the same string.

**If it differs.** A per-endpoint value (`.../auth/login`) means the deploy did not carry
the new code, or `config:cache` was rebuilt from a stale tree: re-run step 3.
`https://gtm-api.com/id/v4` (the apex, which is the WordPress landing) means `app_url` was
overridden somewhere; `host_vars/id-beta.yml` line 333 is the source of truth and the role
default now agrees with it.

**Phase landed when** both documents and a real token all carry the identical string. This
is the exact value `AUTH_ISSUER` is already set to in `wrangler.toml`, and step W8 checks
it again from the laptop.

## Phase 2. Permissions data, before any channel deploy

Enforcement is already ON in the code that step 2 pushed. These four steps are what stops
that from being a visible outage for narrow bearers.

> **The one window in this runbook.** Deploying id (step 3) gates 10 previously ungated id
> routes (notifications, support requests, oauth authorizations) whose tokens nobody holds
> until step 6 runs. Humans are unaffected (login tokens carry `*`); an api key or an
> OAuth agent touching those routes gets a 403 in between. Do steps 3, 5 and 6 in one
> sitting, which is minutes.

### 5. Audit production, writing nothing (Eugene)

On the id host, as the deploy user, in the app directory:

```bash
php artisan permissions:backfill --json > /tmp/permissions-audit.json
```

**Expect.** JSON. Read three numbers: `team_members.changed`,
`api_keys.empty_permission_keys` and `oauth_authorizations.grants_below_member_preset`. On
the dev database this reported 5 rows changing, 0 api keys and 0 grants; that proves the
command, not your exposure. **Keep this file**, it is the only before state that exists.

**If it differs.** A non-zero grant count is the only thing the command cannot fix for
you, and it is step 7. `Command not found` means step 3 did not land.

**Rollback.** None, it writes nothing.

### 6. Backfill, and prove it converged (Eugene)

```bash
php artisan permissions:backfill --apply
php artisan permissions:backfill --json | python3 -c "import json,sys;print(json.load(sys.stdin)['team_members']['changed'])"
```

**Expect.** The second command prints `0`. Spot-check one owner: 47 tokens, and no
`can_view_access_grants` / `can_manage_access_grants` (those two are retired).

**If it differs.** A non-zero second reading means rows are being rewritten on every pass,
which is a bug and not a slow convergence: stop and read the JSON diff rather than
re-running.

**Rollback.** The command only adds tokens and drops the two retired ones, and it never
touches a wildcard row. To undo, restore each row's `permissions` from the step 5 file.
This is the reason step 5 is not optional.

### 7. Re-consent the OAuth grants the audit listed (Eugene, only if non-zero)

```bash
python3 -c "import json;d=json.load(open('/tmp/permissions-audit.json'));[print(r['sid'], r['user_sid'], r['oauth_client_sid'], len(r['needs_reconsent_for'])) for r in d['oauth_authorizations']['rows']]"
```

**Expect.** No rows, on the dev data there were none.

**If it differs.** Contact each grant's owner and have the app re-consent. **Do not edit
the grant in the database.** An installation token freezes its scope at mint, so widening
the consent record does not move a live token, and editing a consent record is forging
consent. The alternative is accepting that their agent 403s until they reconnect.

### 8. Decide the empty api keys (Eugene, only if non-zero)

Default is to leave them refused: a key nobody scoped is a key nobody meant to work.

```bash
php artisan permissions:backfill --apply --widen-empty-api-keys   # only if you disagree
```

**Expect.** It touches literally empty lists only. Re-run `--json` and diff `api_keys.rows`
against the step 5 file to confirm no scoped key moved.

**Phase landed when** `team_members.changed` is 0 and you have decided about grants and
empty keys rather than deferred them.

## Phase 3. gtm.service.linkedin

### 9. Deploy gtm.service.linkedin (Eugene)

`https://app.gtm-api.com/linkedin/v4/live` answered **502** on 2026-07-27. The prefix is
routed and nothing healthy is behind it. Most of the MCP tool surface dispatches into
linkedin, so this blocks a useful worker deploy on its own, independently of Cloudflare.

```bash
cd /Users/eugene/sites/gtm.ai/product/deployment/gtm.deployment.ansible
ansible-playbook deploy-linkedin.yml -i inventory/beta.ini --limit linkedin-beta \
  --ssh-common-args='-C -o ControlMaster=auto -o ControlPersist=900s -o StrictHostKeyChecking=accept-new' \
  --vault-password-file ~/.gtm-secrets/.vault_pass_gtm
curl -s https://app.gtm-api.com/linkedin/v4/live
```

**Expect.** Recap `0 failed`, and the curl prints `{"status":"alive"}`.

**If it differs.** A 502 that survives the deploy is php-fpm or the vhost, not the edge:
`svc-status` on the host. **HTML** rather than JSON means you hit the SPA catch-all, which
is what an unpublished prefix looks like on this edge, so never judge either prefix by its
status code alone.

**Rollback.** Re-deploy the previous `service_ref`.

### 10. Confirm the flip is on, then watch it for 30 minutes (Eugene)

```bash
grep -rn 'PERMISSIONS_ENFORCE' /etc/gtm/gtm.service.linkedin.secrets.env /var/www/gtm.service.linkedin/.env   # expect: nothing
php artisan tinker --execute="var_dump(config('permissions.enforce'), config('permissions.undeclared'));"
grep permissions.refused /var/log/gtm/*.log | tail -50
```

**Expect.** `bool(true)` and `"closed"`. Nothing on any host pins `PERMISSIONS_ENFORCE`
(verified across every overlay template and `.env.prod`), so the code default is what runs.
Refusal lines carry `reason`, `required_permission`, `route`, `actor_type`, `actor_sid`,
`team_sid`, `identity_reason`, `held_token_count` and `trace_id`.

**If it differs.** `identity_reason=oauth` or `actor_type=api_key` is an expected narrow
bearer: grant the token or have the app re-consent. **`identity_reason=login` means
something is wrong**, since login tokens carry `*` and cannot legitimately be refused.
`reason=route_not_declared` means a route shipped without a declaration.

**Rollback, per service, no redeploy.** `PERMISSIONS_ENFORCE=false` in the service `.env`,
then `php artisan config:cache` and restart php-fpm/supervisor. The flag is read per
request precisely so `route:cache` cannot freeze it, and OFF is byte for byte the old
behaviour. The fail-closed half has its own independent lever,
`PERMISSIONS_UNDECLARED=open`. gtm.service.id has no enforce lever by design.

## Phase 4. The orchestration host

Nine steps, all of them on a box that has never been provisioned. The vault is the only
real blocker; everything else is mechanical.

### 11. Fill the secrets layers (Eugene)

In `~/.gtm-secrets`, create `services/orchestration-beta.env` with this host's own
`APP_KEY`, `DB_USERNAME=gtm_orchestration_beta_dbuser_app`, `DB_PASSWORD`,
`DB_ROOT_PASSWORD`, `DB_RW_PASSWORD`, `AI_DB_PASSWORD`, `RABBIT_LOGIN`, `RABBIT_PASSWORD`,
`AWS_*`, `AMPLITUDE_API_KEY`, `BUGSNAG_API_KEY`, `ALLOY_CLOUD_TOKEN`,
`BITBUCKET_RUNNER_*`. Make sure `common.beta.env` carries `CLUSTER1_LINKEDIN_ACCESS_KEY`,
`ORCHESTRATION_ACCESS_KEY`, `ID_ACCESS_KEY`, `INTERNAL_ACCESS_KEY` and `JWT_SECRET`.

**Check.** `grep -c '^CLUSTER1_LINKEDIN_ACCESS_KEY=' ~/.gtm-secrets/common.beta.env` is 1.

**If it differs.** `JWT_SECRET` must be the same line id-beta reads. HS256 is symmetric: a
different secret means every token id mints is rejected by orchestration.

### 12. Render the vault (Eugene)

```bash
cd /Users/eugene/sites/gtm.ai
product/backend/bin/sync-ansible-vault.sh orchestration-beta
grep -c vault_cluster1_linkedin_access_key product/deployment/gtm.deployment.ansible/host_vars/orchestration-beta.vault.yml   # 1
grep -c REPLACE_ME product/deployment/gtm.deployment.ansible/host_vars/orchestration-beta.vault.yml                            # 0
```

**Expect.** Both greps as annotated.

**If it differs.** A key missing from `~/.gtm-secrets` is skipped **silently** (it is
deliberately not in the script's REQUIRED list, because REQUIRED emits a literal
`REPLACE_ME` that satisfies the roles' `length > 0` assert and then fails at runtime instead
of at deploy time). These two greps are the only thing between you and a 401 per
mass-action item.

### 13. Encrypt the vault (Eugene)

```bash
cd /Users/eugene/sites/gtm.ai/product/deployment/gtm.deployment.ansible
ansible-vault encrypt host_vars/orchestration-beta.vault.yml
head -1 host_vars/orchestration-beta.vault.yml   # $ANSIBLE_VAULT;1.1;AES256
```

**Rollback.** `ansible-vault decrypt` the same file. Never commit it decrypted.

### 14. Confirm the Bitbucket slug (Eugene)

`host_vars/orchestration-beta.yml` says `gs.service.orchestration` while the other two
hosts use `gtm.*`, and it has never been verified.

```bash
git ls-remote git@bitbucket.org:gtm-api/gs.service.orchestration.git HEAD
```

**Expect.** A sha.

**If it differs.** Fix `service_repo` in `host_vars/orchestration-beta.yml` **now**, or
step 18 fails at the clone after provisioning has already changed the box.

### 15. Preflight the host (Eugene)

```bash
ansible-playbook preflight.yml -i inventory/beta.ini --limit orchestration-beta \
  --ssh-common-args='-C -o ControlMaster=auto -o ControlPersist=900s -o StrictHostKeyChecking=accept-new' \
  --vault-password-file ~/.gtm-secrets/.vault_pass_gtm
```

**Expect.** Green, reaching 65.109.84.210 as root by key.

**If it differs.** A hang is the VPN, and this play exists to catch exactly that before
`roles/security` locks SSH to `mgmt_allowed_ips` mid-provision (recovery is the Hetzner
console). A host-key error on a recreated box: `ssh-keygen -R 65.109.84.210`.

### 16. Provision the host (Eugene)

```bash
ansible-playbook provision-orchestration.yml -i inventory/beta.ini --limit orchestration-beta \
  --ssh-common-args='-C -o ControlMaster=auto -o ControlPersist=900s -o StrictHostKeyChecking=accept-new' \
  --vault-password-file ~/.gtm-secrets/.vault_pass_gtm
```

**Expect.** Recap `0 failed`. nginx, MySQL 8.4, Redis, RabbitMQ, PHP 8.4-FPM, UFW, Alloy,
the ai user and the CI runner. No gateway, OpenResty, Supervisor or ACME roles here on
purpose. UFW ends up allowing 80/443 from the world, which is what the gateway uses, and
5672 only from `cluster_allowed_ips`.

**If it differs.** No firewall change is needed for the gateway to reach this backend and
none is added: `health_allow_cidr` already lists 65.109.60.209/32.

**Rollback.** This is the first irreversible step in phase 4, in that it creates databases
and users on a live box. Nothing points at the host yet (the edge prefix is unpublished
until step 20), so a bad run is re-runnable rather than user-visible.

### 17. Register hero's key on Bitbucket (Eugene)

```bash
ssh root@65.109.84.210 'sudo -u hero cat ~hero/.ssh/id_ed25519.pub'
# paste as a READ access key on BOTH gs.service.orchestration AND gtm.lib.common
ssh root@65.109.84.210 'sudo -u hero ssh -T git@bitbucket.org'
```

**Expect.** `logged in as ...` / authenticated. Composer clones `gtm.lib.common` from git,
so both repos are needed, not just the service.

### 18. Deploy the application (Eugene)

```bash
ansible-playbook deploy-orchestration.yml -i inventory/beta.ini --limit orchestration-beta \
  --ssh-common-args='-C -o ControlMaster=auto -o ControlPersist=900s -o StrictHostKeyChecking=accept-new' \
  --vault-password-file ~/.gtm-secrets/.vault_pass_gtm
```

**Expect.** Recap `0 failed`, and the worker must be active **and stay active**:

```bash
ssh -F /dev/null -o IdentitiesOnly=yes -i ~/.gtm-secrets/aiops_shared ai@65.109.84.210 \
  'svc-status gtm-orchestration-worker.service | grep Active; systemctl list-timers gtm-orchestration-scheduler.timer --no-pager'
```

**If it differs.** A crash loop with `No connector for [rabbitmq]` means
`vladimir-yuldashev/laravel-queue-rabbitmq` fell out of `composer.json` again.

### 19. Prove the origin serves, before publishing the edge (Eugene)

```bash
ansible orchestration-beta -i inventory/beta.ini -m uri -a 'url=http://127.0.0.1/live'
```

**Expect.** status 200. Probe from the box: `/live` is restricted to `health_allow_cidr`
plus loopback, so a management IP would get 403 and read like a failure.

**Phase landed when** the origin answers on loopback and the systemd worker has stayed
active for a few minutes. **Do not skip to phase 5 before this**, or the new public prefix
answers 502.

## Phase 5. Publish the edge prefix

### 20. Re-run the gateway role, then verify the public shape (Eugene)

This targets **id-beta**, not the orchestration host, and it loads the id vault, so it
still needs the vault password even with `--tags gateway`.

```bash
cd /Users/eugene/sites/gtm.ai/product/deployment/gtm.deployment.ansible
ansible-playbook provision-id.yml -i inventory/beta.ini --limit id-beta --tags gateway \
  --vault-password-file ~/.gtm-secrets/.vault_pass_gtm
```

**Expect.** The `Validate OpenResty configuration` task is ok and the reload handler fires.
Nothing else on id-beta is touched. Then:

```bash
curl -s -o /dev/null -w 'live=%{http_code}\n'  https://app.gtm-api.com/orchestration/v4/live
curl -s -o /dev/null -w 'ready=%{http_code}\n' https://app.gtm-api.com/orchestration/v4/ready
curl -s https://app.gtm-api.com/orchestration/v4/live
curl -s -o /dev/null -w 'no-accept=%{http_code}\n' -X POST https://app.gtm-api.com/orchestration/v4/api/mass-actions/search -d '{}'
curl -s -o /dev/null -w 'internal=%{http_code}\n'  -X POST https://app.gtm-api.com/orchestration/v4/internal/webhooks/emit -d '{}'
curl -s -o /dev/null -w 'Internal=%{http_code}\n'  -X POST https://app.gtm-api.com/orchestration/v4/Internal/webhooks/emit -d '{}'
```

**Expect.** `live=200`, `ready=200`, the body `{"status":"alive"}` (not HTML),
`no-accept=401`, and `internal=404` **and** `Internal=404`. 404 rather than 403 because the
prefix must not be advertised, and the mixed-case one exercises the `$gtm_denied_internal`
map, which is a separate mechanism from the prefix location, so both have to be checked.

**If it differs.** `502` means step 18 is not actually serving, go back to step 19. HTML
means the route did not render, so the play targeted the wrong host or the template did not
reload. A `500` on the no-accept probe (rather than 401) means the `auth` middleware alias
regressed to Laravel's default `Authenticate`.

**Rollback.** Re-comment the `/orchestration/v4` line in `gateway_routes` and re-run the
same command. The role runs `openresty -t` before any reload handler fires, so a bad route
stops the play instead of the live edge. Internal peers are unaffected either way: they
dial the origin `http://65.109.84.210/`, never this URL, which is why `/internal/*` can be
404 here.

Also watch orchestration's own refusals for 15 minutes, same command and same reading as
step 10, against the orchestration host.

**Phase landed when** all six probes read as above. `ORCHESTRATION_BASE_URL` in
`wrangler.toml` is already this exact prefix, and the worker preflight will now pass its
edge phase.

## Phase 6. The worker (W1 to W12)

Only now. Each of these has a detail section under [The runbook](#the-runbook) with the
same number; nothing about them changed in this consolidation.

| # | Who | Command | Expect / if it differs |
|---|---|---|---|
| **W1** | Eugene, once per machine | `cd apps/worker && pnpm exec wrangler login && pnpm exec wrangler whoami` | `whoami` prints the account that owns the `gtm-api.com` zone, on the Workers Paid plan. A different account means the custom domain fails at attach time with a confusing error. |
| **W2** | done | the upstream dependencies | This is phases 1 to 5 above. `pnpm deploy:preflight` re-checks both from the laptop at W8. |
| **W3** | any engineer, per deploy | `pnpm oracle:check && pnpm typecheck && pnpm test && pnpm e2e && node bin/build-kb-index.mjs` | All green, and `e2e` prints its coverage block. Needs the four Docker backends up. `oracle:check` first: a stale fixture takes the whole suite green with it. |
| **W4** | Eugene, once | `cd apps/worker && pnpm exec wrangler kv namespace create COMMIT_TOKENS --env production` | Prints a namespace id. **Paste it over `TODO_kv_namespace_id`** in `[[env.production.kv_namespaces]]` and commit it: an account-scoped resource id, not a secret. This is the one value that feeds a later step. A wrong id is worse than none, so the preflight also asks the account whether it exists. Rollback: `wrangler kv namespace delete`, though an unused namespace costs nothing. |
| **W5** | Eugene, once | `cd apps/worker && pnpm exec wrangler vectorize create gtm-kb --dimensions=1024 --metric=cosine` | `dimensions` must match `@cf/baai/bge-m3` (1024). Changing the model later means recreating the index and a `--full` re-embed. |
| **W6** | Eugene, once | `openssl rand -base64 48` then `cd apps/worker && pnpm exec wrangler secret put PREVIEW_TOKEN_SECRET --env production` | Real entropy, never committed. Unset means the preview gate is off and **every dangerous tool refuses**, which is safe but half the product does not work. Rotating it later invalidates outstanding commit tokens, whose TTL is 300s. |
| **W7** | Eugene, once | `dig +short mcp.gtm-api.com` | **No output.** Cloudflare refuses to attach a custom domain to a hostname that already has a record, and the deploy then fails half applied. Delete any `mcp` record in zone `gtm-api.com` first. Nothing to create: wrangler makes the proxied record and the certificate on the first deploy. |
| **W8** | any engineer, per deploy | `pnpm deploy:preflight` (or `MCP_JWT=<real token> pnpm deploy:preflight`) | Exit 0 = ready. Exit 1 lists every blocker: offline phase (placeholders, custom domain vs `MCP_RESOURCE_URL`, `workers_dev` false, `preview_urls` true, rate-limit drift), then edge (each `{base}/live` returns the **body** `{"status":"alive"}`, the id host publishes the exact `AUTH_ISSUER` string, `mcp.gtm-api.com` free or already ours), then account (`PREVIEW_TOKEN_SECRET` set, KV id owned). Today it exits 1 on the KV id alone, because the offline phase stops before touching the network. It takes **no arguments**; passing one exits 2. |
| **W9** | Eugene, per deploy | `cd apps/worker && pnpm exec wrangler versions upload --env production`, then `MCP_JWT=… MCP_TEAM_SID=… pnpm smoke https://<version>-gtm-mcp.<account>.workers.dev` | A Version ID plus a preview URL, and `smoke: GREEN`. Nothing is deployed, no route changes, `mcp.gtm-api.com` untouched. Wrangler warns that preview URLs are on while `workers_dev` is off: that is the intended state. The preview is **not** a sandbox (production KV, counters and backends), which is why the smoke reads three rows and confirms a dangerous tool against a nonexistent sid. |
| **W10** | Eugene, per deploy | `pnpm deploy:production` | Runs the preflight, then `wrangler deploy --env production`, which uploads, deploys **and attaches the custom domain**, creating the DNS record and certificate. A 525 or 1016 for a minute or two is certificate issuance. The **first** deploy must be this command: `wrangler versions deploy` does not apply triggers and `wrangler triggers deploy` is experimental. Later deploys can promote the rehearsed version. Rollback: `wrangler deployments list --env production` then `wrangler rollback <id> --env production`, which reverts code **and** the vars bundled with that version. Removing the hostname itself is a dashboard action (Workers, Domains and Routes), and it deletes the Workers-managed DNS record with it. |
| **W11** | Eugene, per deploy | `MCP_JWT=<token> MCP_TEAM_SID=<team sid> pnpm smoke` | Six checks against `https://mcp.gtm-api.com`, ending `smoke: GREEN`. Health `ok` with `rate_limit.status: "edge"`, the two discovery documents agreeing with `wrangler.toml`, the token's own `iss`/`aud`, one live read, and preview then confirm then **replay**, which must answer `This confirmation token was already used`. Without `MCP_JWT` it runs the configuration half and exits 1: a deploy nobody called a tool against is not a verified deploy. |
| **W12** | Eugene, after the first deploy | `export CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… && node bin/vectorize-kb.mjs --dry-run && node bin/vectorize-kb.mjs` | Chunks embedded and upserted, stale ids pruned, after which `search_knowledge` runs hybrid retrieval. Rollback: re-run with `--full`, or delete and recreate the index. |

**Release landed when** W11 is green against `https://mcp.gtm-api.com` and the same token
reaches a live read through the edge. Record the date, the commit and the `pnpm e2e`
parsed/total next to the release.

## Known gaps, none of them blocking

- `gtm.service.linkedin` and `gtm.service.email` both read
  `env('ORCHESTRATION_SERVICE_BASE_URL')` in `config/services.php` (linkedin's auto-scrape
  engine enrolls fresh leads into a standing mass action through it), but the key is in
  neither their `.env.prod` nor `roles/app_linkedin/templates/overlay.j2`, so it renders
  absent on a deployed host and that enrollment fails with `Env Variable is empty`. Wiring
  it is two coordinated edits plus the matching `vault_orchestration_access_key`.
- `host_vars/id-beta.vault.example.yml` is still missing `vault_data_access_key`,
  `vault_aws_bucket`, `vault_aws_default_region` and `vault_aws_url`, all of which the
  `app_id` templates read. Same class of gap as the one fixed above, unrelated to this
  release.
- `LoginTokenMinter` mints `tokens: ['*']` for every human, so `team_members.permissions`
  is still decorative for the web app and gates only OAuth. That is the one remaining
  reason this is not full enforcement, and its blast radius (every UI surface a narrow
  member touches) is strictly larger than the flip, so it is its own follow-up.
  `PERMISSIONS_MODEL.md` 6.7 item 1.
- id's protected-resource metadata is served path-appended
  (`https://app.gtm-api.com/id/v4/.well-known/oauth-authorization-server`) rather than in
  the strict RFC 8414 3.1 path-inserted form. The MCP auth spec's mandated client fallback
  chain includes the appended form, so this is fine for MCP; a strict non-MCP client would
  need a gateway location, not a code change.

## What this worker owns, and what it only points at

The worker is the whole server on `mcp.gtm-api.com`: it answers `/health`, both
`.well-known` documents and every `/mcp/*` mount, and there is no origin behind it.
That is why `wrangler.toml` declares a **custom domain** and not a route:

| Mechanism | What it does | Verdict |
|---|---|---|
| `routes = [{ pattern = "mcp.gtm-api.com", custom_domain = true }]` | Cloudflare creates the proxied, Workers-managed DNS record and the edge certificate itself, and sends every path on that hostname to this Worker. | **ours** |
| `{ pattern = "mcp.gtm-api.com/*", zone_name = "gtm-api.com" }` | puts a Worker **in front of an existing origin**, and creates no DNS. The hostname still needs a proxied record from somewhere, and with no origin behind it the usual trick is a dummy `AAAA 100::` record whose only purpose is to give the orange cloud something to attach to. | a second moving part that exists only to be ignored, and forgetting it is the classic "the route is configured and the hostname still 1016s" |

Routes are right for a Worker that intercepts paths on a hostname something else
serves, which is what `app.gtm-api.com` is (OpenResty, the Laravel gateway). That is
exactly why the MCP worker takes its own subdomain instead of a path there.

A custom domain takes a **bare hostname**: no path, no wildcard. `MCP_RESOURCE_URL` is
that hostname plus the unified facade mount (`https://mcp.gtm-api.com/mcp`), and the
preflight refuses a deploy where the two disagree, because that pair is the OAuth
resource identity: the discovery document advertises it and a token's `aud` has to
carry it. For the same reason `workers_dev` stays `false`: a second public entrance on
`gtm-mcp.<account>.workers.dev` would be a stable, guessable hostname that is not the
one the discovery document names.

## Two dependencies outside this repo

Neither is a Cloudflare step, both are deploy-order traps, and **the preflight checks
both for you** (step 8 GETs `{base}/live` on each service and compares the id host's
published issuer to `AUTH_ISSUER`). Read this so a red preflight is not a surprise.

| Dependency | Why it blocks | State on 2026-07-27 |
|---|---|---|
| **gtm.service.id deployed with the explicit issuer claim** | `verifier.ts` does an exact `payload.iss !== AUTH_ISSUER` match. id now mints from `config('jwt.issuer')` (defaults to `APP_URL`) at the claim factory (`App\Auth\IssuerClaimFactory`), so login, refresh, both OAuth grants, `jwt:fake` and job-restored identities all emit it, and `OAuthFlowController::issuer()` reads the same key: token `iss` = RFC 8414 `issuer` = RFC 9728 `authorization_servers[0]`. A host still running the older code mints a per-endpoint `iss` (`https://app.gtm-api.com/auth/login`), and every real token 401s with `issuer mismatch`. | code landed and live-verified against the running id container end to end (a real `/auth/login` token passed the `AUTH_MODE=jwt` edge and `get_credit_balance` returned real data). **The beta host has not been deployed.** |
| **The `/orchestration/v4` gateway prefix serving** | `/mcp/orchestration/webhooks` and `/mcp/orchestration/mass-actions` are mounted, so `requiredBaseUrlServices()` includes `orchestration` and an unusable `ORCHESTRATION_BASE_URL` is **fatal**: `/health` and every mount answer 503. Not a partial outage, a total one. | route uncommented in `host_vars/id-beta.yml`, **host not provisioned and `provision-id.yml --tags gateway` not re-run**. Measured: `GET https://app.gtm-api.com/orchestration/v4/live` answers **200 with the SPA's index.html**, so the prefix is not published and the front-end catch-all is answering. Sequence: `product/deployment/RUNBOOK-orchestration.md` § 3 |

Also measured the same day, not a Cloudflare problem either, and worth knowing before
you deploy: `GET https://app.gtm-api.com/linkedin/v4/live` answers **502**. The linkedin
prefix is routed but nothing healthy is behind it, and most of the tool surface
dispatches into that.

> **The status code alone is not enough** on this edge, which is why the preflight
> asserts the body says `{"status":"alive"}`. An unpublished prefix does not 404 here:
> the SPA catch-all serves `index.html` for any unrouted path, so a check that stops at
> the code reads a missing route as a healthy service.

## Account resources

| Resource | Binding | Created by | When |
|---|---|---|---|
| KV namespace | `COMMIT_TOKENS` | step 4, `wrangler kv namespace create` | once |
| Vectorize index `gtm-kb` | `VECTORIZE_KB` | step 5, `wrangler vectorize create` | once |
| Workers AI | `AI` | nothing to create (needs Workers Paid) | - |
| Rate limiter | `RATE_LIMIT_CALLS` | nothing to create | - |
| Rate limiter | `RATE_LIMIT_WRITES` | nothing to create | - |
| DNS record for `mcp.gtm-api.com` | - | **wrangler**, on the first deploy | once |

The two rate limiters need no provisioning step: `namespace_id` in the
`[[env.production.ratelimits]]` blocks is ours to choose and only has to be unique per
worker, and `period` accepts 10 or 60 and nothing else. With neither bound the gate
still runs, counting per isolate instead of per account, and `/health` reports
`rate_limit.status: "isolate_local"` so the difference is visible rather than assumed.
Their `simple.limit` and the `RATE_LIMIT_*_PER_WINDOW` vars have to change together:
the binding enforces, the var is what the agent is told. The preflight fails on drift
between them. Counters are per colo, so a caller spread over many colos gets a multiple
of the nominal limit; these numbers exist to stop a storm, not to meter billing.

The DNS record is not yours to create either. Cloudflare creates a proxied,
Workers-managed record and issues the certificate when the custom domain is attached.
Your one job is that **no record for `mcp.gtm-api.com` exists beforehand**: Cloudflare
refuses to attach a custom domain to a hostname that already has one, and the deploy
then fails half-applied. The zone's SSL/TLS mode, which caused the `app.gtm-api.com`
redirect loop in July, is irrelevant here: a custom domain has no origin to fetch from.

When `AI` + `VECTORIZE_KB` are bound, `search_knowledge` runs **hybrid** retrieval
(vector + BM25, RRF-fused) and degrades to BM25 on any vector-path error.

## The runbook

The steps below are the worker's own twelve, in order, and they are **W1 to W12** in
[First production release](#first-production-release), which is where the who, the
frequency and the cross repo dependencies live. Their numbers are the ones `wrangler.toml`,
`bin/smoke.sh` and `bin/deploy-preflight.mjs` mean when a comment says "DEPLOY.md step N".
What follows is the detail behind each: read it when a step is not obvious or when one
fails.

For a first release, do not start here. Steps 1 to 20 of the consolidated runbook come
first, and step 8 below refuses the deploy if they have not.

### Step 1. Account prerequisites (Eugene, once per machine)

1. The Cloudflare account is on the **Workers Paid** plan. Vectorize, Workers AI and
   the platform rate-limit bindings all need it.
2. Authenticate the CLI:
   ```bash
   cd apps/worker
   pnpm exec wrangler login       # opens a browser, grants the local CLI a token
   pnpm exec wrangler whoami
   ```
   `whoami` prints the account name and id. **Read it.** It is the only confirmation
   that the deploy lands in the account that owns the `gtm-api.com` zone, and a custom
   domain in the wrong account fails at attach time with a confusing error. Nothing
   before this step needs credentials, the preflight's offline phase included.
3. A separate API token for the KB pipeline (used by `bin/vectorize-kb.mjs`, **not** by
   the worker): account permissions **Workers AI: Run** + **Vectorize: Edit**. Store it
   as `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` in `~/.gtm-secrets`.

### Step 2. Deploy the two upstream dependencies (Eugene, once)

Both are in other repos and neither is a Cloudflare action. Background:
[Two dependencies outside this repo](#two-dependencies-outside-this-repo).

```bash
# a) gtm.service.id, so tokens carry the explicit issuer claim. Then, from anywhere:
curl -s https://app.gtm-api.com/id/v4/.well-known/oauth-authorization-server | jq -r .issuer
#    expect exactly: https://app.gtm-api.com/id/v4
#    and a real login token from that host must carry the same string in `iss`
#    (base64url-decode the payload, or let step 8 do it: MCP_JWT=… pnpm deploy:preflight)

# b) orchestration: provision + deploy the host, THEN publish the prefix.
#    product/deployment/RUNBOOK-orchestration.md § 3 is the sequence.
curl -s https://app.gtm-api.com/orchestration/v4/live
#    expect exactly: {"status":"alive"}
#    HTML here means the prefix is not published and the SPA catch-all answered

# c) while you are there, linkedin is 502 today and most tools need it:
curl -s https://app.gtm-api.com/linkedin/v4/live
#    expect: {"status":"alive"}
```

Order matters on (b): deploy the app first, then re-run `provision-id.yml --tags
gateway`. A published prefix with no app behind it answers 502, and an unresolvable
`proxy_pass` upstream fails `nginx -t` and takes the whole edge down.

### Step 3. Local gates (any engineer, per deploy)

```bash
pnpm oracle:check              # contract fixtures still match the live backends
pnpm typecheck && pnpm test    # the same suite CI runs, must be green
pnpm e2e                       # the LIVE arm: real worker, real backends, real envelopes
node bin/build-kb-index.mjs    # refresh the bundled BM25 index
```

`oracle:check` comes first because `pnpm test` cannot replace it: every contract gate
compares the committed `fixtures/contract-oracle/*.contract.json` against this repo's
TypeScript, so a fixture that went stale takes the whole suite green with it. It needs
Docker up for the four backends (`./dev up` in each), which is why it is not part of
`pnpm test` and why CI cannot run it either (see [CI](#ci-bitbucket-pipelines)). Skip
it only when no backend has moved since the last `pnpm oracle:refresh`.

`pnpm e2e` is the other gate CI cannot run, and the only one that holds a tool's
`outputSchema` against a response a backend really sent. What its coverage block means,
and what has to be green before a release, is [The live e2e arm](#the-live-e2e-arm).

### Step 4. Create the KV namespace (Eugene, once. Its output goes into wrangler.toml)

```bash
cd apps/worker
pnpm exec wrangler kv namespace create COMMIT_TOKENS --env production
```

It prints the created namespace and a config snippet containing an `id`. **Paste that
id** into `[[env.production.kv_namespaces]] id` in `apps/worker/wrangler.toml`, over
`TODO_kv_namespace_id`, and commit it. A KV namespace id is an account-scoped resource
id, not a secret.

Unfilled it is a warning to the worker (it serves reads, and every dangerous tool
refuses at the confirm step, fail-closed) and a blocker to the preflight. Filled with a
*wrong* id it is worse than either, because nothing notices until the first commit token
is written, so the preflight also asks the account whether that id exists.

### Step 5. Create the Vectorize index (Eugene, once)

```bash
cd apps/worker
pnpm exec wrangler vectorize create gtm-kb --dimensions=1024 --metric=cosine
```

`dimensions` MUST match the embedding model (`@cf/baai/bge-m3` is 1024). Create it
before the first deploy: `[[env.production.vectorize]]` binds `gtm-kb` by name, and a
binding is not the place to discover the index does not exist. Changing the model later
means recreating the index and a `--full` re-embed.

### Step 6. Set PREVIEW_TOKEN_SECRET (Eugene, once)

```bash
openssl rand -base64 48                                       # generate, then paste it
cd apps/worker
pnpm exec wrangler secret put PREVIEW_TOKEN_SECRET --env production
```

It is the HMAC key the preview gate signs commit tokens with, so it wants real entropy
(48 random bytes, not a passphrase) and it must never be committed: a secret in
`wrangler.toml` would make every commit token forgeable by anyone with repo access.
Unset, the gate is off and every dangerous tool refuses to execute, which is safe but
means half the product does not work. `config.ts` also treats a value matching `/todo/i`
as unset, so a placeholder cannot arm the gate while looking like it did.

Rotating it later invalidates outstanding commit tokens; their TTL is 300s, so the blast
radius is one agent being asked to preview again.

### Step 7. Clear the way for the DNS record (Eugene, once)

Nothing to create. Confirm in the Cloudflare dashboard, zone `gtm-api.com` > DNS, that
**no record exists for `mcp`**, and delete it if one does. From a shell:

```bash
dig +short mcp.gtm-api.com     # expect NO output before the first deploy
```

The first deploy creates the proxied Workers-managed record and the edge certificate.
The preflight makes the same check and, once the worker is live, recognises its own
`/health` and reports a redeploy instead of a conflict.

### Step 8. Preflight (any engineer, per deploy)

```bash
pnpm deploy:preflight
MCP_JWT=<a real id-minted token> pnpm deploy:preflight    # also checks iss/aud for real
```

Exit 0 means ready; exit 1 prints every blocker with the var name and what supplies it.
Three phases, in this order, and it stops after the offline one if anything failed
there, so it gives a straight answer on a laptop with no login and no network:

1. **offline**, the TOML alone: any var still carrying a `TODO` / `REPLACE_ME`
   placeholder, a base URL that is not absolute http(s), `AUTH_MODE` that is not `jwt`,
   an `ENV_NAME` that disagrees with the block it sits in, an unset or placeholder
   `COMMIT_TOKENS` id, a missing rate-limit binding, a `RATE_LIMIT_*_PER_WINDOW` var
   that disagrees with the limit its binding enforces, a route that is not a custom
   domain, a `MCP_RESOURCE_URL` whose host is not that domain, a `workers_dev` that is
   not false, and a `preview_urls` that is not true (step 9 depends on it).
2. **edge**: each backend prefix answers `{"status":"alive"}` at `app.gtm-api.com`, the
   id host publishes the exact `AUTH_ISSUER` string this worker will match against, and
   `mcp.gtm-api.com` is either free or already this worker. With `MCP_JWT` exported it
   also decodes that token and checks its `iss` and `aud`, which is the pair that has
   never run against a real token.
3. **account**: `PREVIEW_TOKEN_SECRET` is set on `env.production`, and the configured KV
   id is a namespace this account actually owns.

"I could not check" is reported as a blocker, never as a pass. `pnpm deploy:production`
runs it first, so a deploy cannot skip it by accident.

### Step 9. Rehearse on a version preview URL (Eugene, per deploy)

```bash
cd apps/worker
pnpm exec wrangler versions upload --env production
#   -> prints a Version ID and
#      https://<8-char-version>-gtm-mcp.<account>.workers.dev
```

That version carries the production vars, bindings and secrets and **is not deployed**:
no traffic, no route change, `mcp.gtm-api.com` untouched. Smoke it:

```bash
cd ../..
MCP_JWT=<token> MCP_TEAM_SID=<team sid> pnpm smoke https://<version>-gtm-mcp.<account>.workers.dev
```

Wrangler warns that preview URLs are enabled while `workers_dev` is disabled. **That
combination is deliberate**, it is what makes this step possible; the URL is unguessable
in practice and runs the same auth checks as production.

> A version preview is **not a sandbox**. It runs the production KV namespace, the
> production rate-limit counters and the production backends. `pnpm smoke` is safe
> against it because its checks were chosen to be: the read call reads three rows, and
> the dangerous call is confirmed against an account sid that does not exist.

### Step 10. Deploy (Eugene, per deploy)

```bash
pnpm deploy:production
```

That is `deploy-preflight.mjs && wrangler deploy --env production`. The `--env
production` is not optional decoration: without it wrangler publishes the **default
(dev) config**, a worker named `gtm-mcp-dev` with no rate-limit bindings and a KV id
that does not exist.

The first run is also what attaches the custom domain, which is why it is `wrangler
deploy` rather than a promotion of the step 9 version: `wrangler versions deploy`
changes which version serves and does **not** apply triggers (routes and domains), and
`wrangler triggers deploy`, which does, is still experimental. So the first deploy
re-uploads and its version id differs from the rehearsed one. Once `mcp.gtm-api.com`
exists, later deploys can promote the exact rehearsed bytes:

```bash
cd apps/worker && pnpm exec wrangler versions deploy --version-id <id from step 9> --env production
```

Expect the record and certificate to take a minute or two on the first deploy. A `525`
or `1016` in that window is the certificate not being issued yet, not a bad deploy.

### Step 11. Post-deploy smoke (Eugene, per deploy)

```bash
MCP_JWT=<token> MCP_TEAM_SID=<team sid> pnpm smoke
```

Defaults to `https://mcp.gtm-api.com`. Six checks; what each one proves is
[Post-deploy checks](#post-deploy-checks) below. A green run ends with `smoke: GREEN
against https://mcp.gtm-api.com`. Without `MCP_JWT` it runs the configuration half,
says so, and exits 1: a deploy nobody called a tool against is not a verified deploy.

### Step 12. Load the vector index (Eugene, after the first deploy)

```bash
export CLOUDFLARE_ACCOUNT_ID=…  CLOUDFLARE_API_TOKEN=…   # the step 1.3 token
node bin/vectorize-kb.mjs --dry-run    # shows embed/delete counts
node bin/vectorize-kb.mjs              # embeds changed chunks, upserts, prunes stale ids
```

Details in [Load the vector index](#load-the-vector-index).

## Post-deploy checks

`pnpm smoke [url]` runs all six. They are listed here with the manual equivalent,
because when one fails you will want to poke at it by hand.

```bash
WORKER=https://mcp.gtm-api.com
```

**1. Health.** The gate: nothing else is worth reading until it is `ok`.

```bash
curl -s "$WORKER/health" | jq '{status, problems, gate, commit_tokens, rate_limit, discovery}'
```

- `"status":"ok"` with `problems: []` means the deploy is done.
- `"status":"degraded"` with HTTP 200 means it serves with a fail-closed piece missing.
  Read `problems[]`; the usual causes are an unset `PREVIEW_TOKEN_SECRET` (step 6) or an
  unbound `COMMIT_TOKENS` (step 4), both of which make dangerous tools refuse rather
  than misbehave. The smoke treats degraded as a failure: for a deploy, it is one.
- **HTTP 503** means it is not serving at all, and `problems[]` names the exact var.
- `rate_limit.status` must be `"edge"`. `"isolate_local"` means the `[[ratelimits]]`
  bindings did not resolve, so a distributed caller is uncapped.

**2. The OAuth discovery document.** What an MCP client bootstraps from.

```bash
curl -s "$WORKER/.well-known/oauth-protected-resource" | jq
```

`resource` must equal `MCP_RESOURCE_URL` and `authorization_servers[0]` must equal
`AUTH_ISSUER`. The smoke compares against the committed `wrangler.toml`, so a worker
serving something else means a different tree was deployed.

**3. The authorization server it names actually answers.**

```bash
curl -s "$(curl -s "$WORKER/.well-known/oauth-protected-resource" | jq -r '.authorization_servers[0]')/.well-known/oauth-authorization-server" \
  | jq '{issuer, token_endpoint}'
```

`issuer` must be byte-identical to the URL that linked here. `verifier.ts` compares
`payload.iss` to it with `!==`: no normalisation, no trailing-slash tolerance.

**4. The token's own claims**, decoded locally before spending a round trip. A token
minted by the wrong host, or before the id deploy, fails the exact-match `iss` check,
and a bare 401 does not say which side is wrong.

**5. One live read tool call.** Reads only: no preview, no confirm, no writes.

```bash
curl -s -X POST "$WORKER/mcp/linkedin/accounts" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $MCP_JWT" -H "Team-SID: $TEAM_SID" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_linkedin_accounts","arguments":{"page_size":3}}}' | jq
```

A 401 with `WWW-Authenticate` means the token did not verify, and the body says which
check failed. A result proves the whole path: edge auth, the rate-limit gate, the
gateway prefix, the backend, and the response budget on the way back.

**6. The dangerous-tool round trip, which is the only proof of the KV path.**

This one deserves its own paragraph, because a preview alone does not prove what it
looks like it proves. The gate mints an HMAC commit token on call 1 and **touches no
storage at all**; KV is written on the confirm call, and read when a token is replayed.
So the sequence is preview, confirm, replay:

```
a) preview reset_linkedin_account_sync for sid ln_ac_000000000000
   -> structuredContent.commit_token, expires_in_seconds > 0, nothing executed
b) confirm: the SAME arguments plus that commit_token
   -> the gate writes the token's jti to KV BEFORE dispatching, so the write happens
      and the backend then answers not_found. Nothing is reset: that sid does not exist,
      which is why it was chosen
c) replay: send the same commit_token a second time
   -> "This confirmation token was already used."
```

Step (c) is the assertion. Only a real read of a real write can produce it, and until
that line appears the KV commit-token path has never been exercised anywhere: `pnpm
test` has no KV binding, and `pnpm e2e` deliberately stops at the preview step. If (a)
passes and (c) does not, the gate is signing tokens that can be redeemed twice.

If (b) answers `the preview-gate store is unavailable`, the binding did not resolve. If
it answers `Could not record the confirmation token`, the binding resolved but the
namespace id is not one this account owns. KV is eventually consistent across colos, so
`bin/smoke.sh` retries (c) a few times before calling it a failure.

Optionally the in-worker support KB, which needs no backend at all and so isolates a
backend problem from a worker problem:

```bash
curl -s -X POST "$WORKER/mcp/support/knowledge" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $MCP_JWT" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_knowledge","arguments":{"query":"connect linkedin account"}}}'
```

A hybrid response is indistinguishable from BM25 in shape; to confirm the vector path is
live, check `wrangler tail --env production`: a `support_kb_vector_fallback` event means
the vector path failed and BM25 answered.

## Rollback

```bash
cd apps/worker
pnpm exec wrangler deployments list --env production
pnpm exec wrangler rollback <deployment-id> --env production
```

Config-only mistakes (a wrong var) are faster to fix forward: edit `wrangler.toml`,
`pnpm deploy:production`. A rollback reverts the code **and** the vars bundled with that
version, so it also undoes a var you meant to keep.

## Reference: what config.ts refuses

`apps/worker/src/config.ts` checks the environment on every request and splits the
outcome in two:

| Outcome | HTTP | When |
|---|---|---|
| `fail` | **503** on `/health`, on both `.well-known` documents and on every mount | a base URL missing or still a TODO; `AUTH_MODE` unset/unknown; `AUTH_MODE=jwt` without `AUTH_ISSUER` or `MCP_RESOURCE_URL`; `AUTH_MODE=dev` in a deployed `ENV_NAME`; a non-numeric `BACKEND_TIMEOUT_MS` |
| `degraded` | 200, body `"status":"degraded"` | it serves, with a fail-closed piece missing: no `PREVIEW_TOKEN_SECRET`, no `COMMIT_TOKENS` binding, no platform rate-limit binding |

The fatal case carries the status code so a Cloudflare Health Check (and any uptime
monitor) alerts with no body matching configured; the body carries `status` and an
itemised `problems[]` so a monitor can also alert on `degraded`, which is not a
code-worthy outage. Curl `/health` right after a deploy and read `problems` before
anything else.

The auth pair is not optional paperwork: with `AUTH_MODE=jwt` and no issuer the edge
would have nothing to compare `iss` and `aud` against, so both checks would pass
everything. That configuration is refused rather than served.

## Load the vector index

```bash
export CLOUDFLARE_ACCOUNT_ID=…  CLOUDFLARE_API_TOKEN=…   # the step 1.3 token
node bin/vectorize-kb.mjs --dry-run    # shows embed/delete counts
node bin/vectorize-kb.mjs              # embeds changed chunks, upserts, prunes stale ids
```

The script is incremental (manifest in `bin/.vectorize-manifest.json`, gitignored):
only new/changed chunks are embedded, ids that disappeared from the corpus are deleted.
`--full` forces a complete re-embed (e.g. after changing the embedding model; keep
`EMBEDDING_MODEL` in `vector-retriever.ts` and `vectorize-kb.mjs` in lockstep, and
recreate the index if dimensions change).

## KB update loop (after every article edit)

```bash
node bin/build-kb-index.mjs    # bundled index (dev + prod fallback)
pnpm deploy:production         # ships the new BM25 fallback
node bin/vectorize-kb.mjs      # embeddings (incremental)
```

Order matters only in that the deploy ships the new BM25 fallback; vectorize can run
before or after. Costs: bge-m3 embedding of the whole current corpus is fractions of a
cent; Vectorize storage/query at this scale is effectively free tier.

## CI (Bitbucket Pipelines)

`bitbucket-pipelines.yml` at the repo root. It runs on every pull request and on
every push to `master`, three steps in parallel on a pinned `node:24-bookworm`
(full image, not `-slim`: git has to be there, and Node 24 strips TypeScript types
natively, which the OpenAPI generator runs on).

| Step | Command | What it holds |
|---|---|---|
| Typecheck | `pnpm typecheck` | `tsc` over every workspace package |
| Gates (vitest) | `pnpm test` | contract-parity, oracle-freshness, coverage-gate, step-eligibility, research-parity, openapi-public-drift, dash-lint, worker-boot, the worker's own config + edge tests (`apps/worker/src/*.test.ts`), plus the runtime unit tests |
| OpenAPI public drift | `SKIP_VALIDATE=1 pnpm openapi:public:check` | the committed public spec still matches the Zod registry |

Every step starts with `bash ci/setup.sh`: it pins pnpm to the `packageManager`
field in `package.json` and runs `pnpm install --frozen-lockfile` with the store at
`/opt/pnpm-store` (cached, keyed on `pnpm-lock.yaml`). The store stays outside the
clone on purpose, because `dash-lint` walks every text file under the repo root.

There is no deploy step. Cloudflare deploys stay manual (the runbook above) until a
first production deploy has actually happened.

### What CI does not run, and who does

| Not in CI | Why | Where it runs instead |
|---|---|---|
| `pnpm oracle:check` | regenerates the contract fixtures from four LIVE backends (Docker, DBs). No reviewer could fix that failure from the diff | workstation: step 3, and named by the pre-push hook |
| `pnpm e2e` | `RUN_E2E=1` calls every safe read tool through a running worker against live backends with a seeded team. CI has no Docker, no seeded database and no worker on :8788, so it structurally cannot | workstation: [The live e2e arm](#the-live-e2e-arm) below |
| `pnpm smoke` | needs a DEPLOYED worker and a real token | workstation: steps 9 and 11 |
| `pnpm lint` | identical work to `pnpm typecheck` (every package's `lint` is the same `tsc --noEmit`) | nowhere, deliberately |
| the OAS validator | `bin/openapi-public.sh` normally ends with `gtm.openapi.tech/_tools/validate.py`; that validator, its `requirements.txt` and its venv live in a third repo | workstation: `pnpm openapi:public` validates in write mode and refuses to run without it, so the spec is validated whenever it is generated |

The fixture staleness that CI cannot see is the one that hurts most: every contract
gate reads `fixtures/contract-oracle/*.contract.json`, so a fixture that went stale
against a backend that moved makes all of them green for the wrong reason. **Run
`pnpm oracle:check` locally before you push anything that follows a backend
change**, and `pnpm oracle:refresh` when it reports drift.

### The live e2e arm

```bash
pnpm e2e                  # backends -> token -> worker -> suites -> coverage -> teardown
pnpm e2e --keep-worker    # same, but leave the worker up to debug a failure
```

**Who runs it:** the engineer cutting the release, on their workstation, as the last
gate before `wrangler deploy`. It has no other owner and no schedule, because there is
nowhere else it can run.

**What must be green before a release:**

| Gate | Command | Runs where |
|---|---|---|
| offline suite | `pnpm typecheck && pnpm test` | CI on every PR, and the pre-push hook |
| contract fixtures are current | `pnpm oracle:check` | workstation, step 3 |
| **the live arm** | `pnpm e2e` | **workstation only, this section** |
| the deployed surface | `pnpm smoke` | workstation, steps 9 and 11 |

**Why CI cannot run it, structurally.** The suites drive a real `wrangler dev` worker
over HTTP against three Laravel services on Docker, each with its own MySQL, seeded
with the DevSeeder identity, and they authenticate with a JWT minted by
`artisan jwt:fake` inside the linkedin container. A Pipelines runner has none of that,
and none of it can be faked without deleting the only thing the arm proves. This is not
"we have not got round to it": a mocked backend cannot tell you that a tool's
`outputSchema` matches what the backend actually returns, and that check exists nowhere
else in this repo. Every other gate compares TypeScript against TypeScript or against a
committed fixture.

**What one green run covers.** `bin/e2e.sh` prints it rather than leaving you to infer
it from a pass count:

- how many of the registered tools were called live, and how many of the domain mounts
  were smoked (the mount half is also gated offline: `tests/e2e/smoke-mounts.ts` fails
  collection if a mount in `mounts.config.ts` has no smoke row, so a new mount cannot
  ship unexercised);
- the read surface split four ways: **outputSchema parsed** (the real assertion),
  **needs-args** (the tool wanted a required filter and returned a clean error
  envelope), **no-data** (nothing seeded to read), **other-error**;
- what was not called, and why: mutating, creditable and outward tools are never run
  against a live tenant. One dangerous tool is driven to its PREVIEW step; no commit
  step ever runs, which is exactly the gap check 6 of the smoke fills.

Read `needs-args` and `no-data` as coverage debt, not as passes. They mean the call was
well formed and the error envelope was valid, which is worth something, but the
contract itself went unchecked. The way to move those into the parsed column is to seed
rows for them, not to call more tools.

**Record the result.** A green run is only evidence if someone can date it, so put the
date, the commit and the parsed/total from the coverage block next to the release. The
run leaves the full report at `tests/.e2e-coverage.json` (gitignored) if you want to
paste numbers rather than retype them.

**When it is red, nothing ships.** Re-run with `--keep-worker` and grep the dispatch
log it names; every call carries a `trace_id`.

The script is idempotent in both directions. A worker already listening on :8788 is
reused and left running; a worker the script started is stopped on success, on failure
and on Ctrl-C alike, by killing the whole process group (killing the wrapper alone
orphans `wrangler`, which then holds the port and makes the next run "reuse" a worker
built from the previous checkout).

### The pre-push hook

```bash
pnpm hooks:install       # git config core.hooksPath bin/hooks
```

`bin/hooks/pre-push` runs `pnpm typecheck && pnpm test` (a couple of seconds, the
same offline gates as CI) and then prints the `pnpm oracle:check` reminder. Opt in
per clone, versioned in the repo, `git push --no-verify` bypasses it once,
`git config --unset core.hooksPath` turns it off.

### The umbrella corpus (cross repo input)

Two gates read files this repo does not own, resolved relative to the repo root
because a workstation has gtm.mcp checked out at `<umbrella>/product/mcp/gtm.mcp`:

| Path | Read by |
|---|---|
| `../../research` | `tests/research-parity.test.ts` (the design side of every tool) |
| `../../openapi/gtm.openapi.public` | `tests/openapi-public-drift.test.ts`, `bin/openapi-public.sh` |

Both live in the umbrella repo `gtm-api/gtm.ai`. A CI clone has only gtm.mcp, so
`ci/fetch-corpus.sh` sparse clones the umbrella and symlinks those two paths into
the same relative offset (on a workstation it finds them already there and does
nothing). It needs read access to `gtm.ai`, one of:

- an SSH key on this repo (Repository settings > SSH keys), public half added to
  `gtm.ai` as an access key, or
- a read-scoped repository access token in the secured repo variable
  `UMBRELLA_TOKEN`.

It fails loudly when it cannot get the corpus rather than skipping: a gate that
quietly stops reading its inputs is worse than a red one.

**Ordering rule.** A change here that also needs a research edit or a regenerated
public spec goes green only once the umbrella side is on `gtm.ai` master. Land it
there first (`pnpm openapi:public`, commit the regenerated
`product/openapi/gtm.openapi.public`), then push here.

## Not yet wired (deliberate)

- **Deploy from CI**: `build-kb-index -> deploy-preflight -> wrangler deploy ->
  vectorize-kb` maps onto one more Pipelines step with `CLOUDFLARE_API_TOKEN` as a repo
  secret. Left manual until a first production deploy has actually happened, and until
  someone decides what the CI equivalent of step 9 is (a version upload plus `pnpm
  smoke` against the preview URL would work, but it needs a long-lived token that can
  read a real team).
- **Analytics Engine**: a later stage. `/health` and the dispatch log carry the same
  facts today, one request at a time.
- **A backend staging tier**: `inventory/staging.ini` is a skeleton with every
  `ansible_host` still `REPLACE_ME`, and the playbooks pin the beta hosts. Standing one
  up is an ansible-side change, and it is the precondition for a worker staging env ever
  being worth having.
