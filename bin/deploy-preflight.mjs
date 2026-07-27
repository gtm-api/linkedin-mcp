#!/usr/bin/env node
// Refuse to deploy a worker that cannot serve.
//
//   pnpm deploy:preflight
//
// ONE environment, `production`. There is no staging (the reasoning is at the
// top of apps/worker/wrangler.toml), so this takes no argument; passing one is
// an error rather than a silently ignored word.
//
// `apps/worker/package.json` runs it ahead of every `wrangler deploy`, so the
// only way to ship an unfilled config is to bypass the script on purpose.
//
// WHY IT EXISTS. wrangler validates TOML syntax, not meaning: it will happily
// publish `LINKEDIN_BASE_URL = "https://TODO-linkedin-prod-url"` to the public
// internet. The worker then boots, serves a catalog of 250 tools built from the
// env-independent registry, and fails every single call at dispatch. The
// failure is also expensive to read from outside, because a 503 from
// config.ts's fatal path looks the same as a worker that is down.
//
// THREE PHASES, and the ordering is the whole design.
//
//   1. OFFLINE   the TOML alone: placeholders, the vars config.ts treats as
//                fatal, the KV id, the rate-limit invariant, and the custom
//                domain / MCP_RESOURCE_URL agreement. Every one of these runs
//                FIRST and the script exits before touching the network if any
//                fail, which is what lets it answer "not ready" on a laptop
//                with no `wrangler login`, no CLOUDFLARE_API_TOKEN and no
//                network at all. That is when you most want to ask.
//   2. EDGE      what the config POINTS AT, over plain HTTPS: does each backend
//                prefix actually answer at app.gtm-api.com, does the id host
//                publish the issuer this worker will exact-match, and is
//                mcp.gtm-api.com free for wrangler to claim as a custom domain.
//                These are the runbook's cross-repo dependencies (the ansible
//                gateway re-run, the id deploy), and they are the ones that
//                otherwise fail AFTER the deploy, as a green /health with every
//                call 502ing or every token 401ing.
//   3. ACCOUNT   the two things only Cloudflare knows: is PREVIEW_TOKEN_SECRET
//                set on this env, and does the configured KV namespace id exist
//                in this account. A pasted-wrong id is silent until the first
//                commit token is written, which is the one path nothing else
//                exercises.
//
// Phases 2 and 3 both run before reporting, so one invocation tells the whole
// story rather than one blocker per round trip. "I could not check" is reported
// as a blocker, never as a pass: those are different answers and only one of
// them should let a deploy through.
//
// It deliberately re-derives the placeholder rule from
// apps/worker/src/config.ts (`/todo/i`) rather than sharing code with it: this
// script is a plain .mjs that must run with no build step and no dependencies,
// and the rule is one regex. The REPLACE_ME spelling is added because that is
// the marker the ansible repo uses, and a value copied across from there keeps
// its own placeholder spelling.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { lookup } from 'node:dns/promises';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER_TOML = join(ROOT, 'apps', 'worker', 'wrangler.toml');
const WORKER_DIR = join(ROOT, 'apps', 'worker');

const env = 'production';
if (process.argv.length > 2) {
  console.error(
    `preflight: takes no arguments (got '${process.argv.slice(2).join(' ')}'). This repo deploys ONE environment,\n` +
      'env.production. The staging env was deleted on purpose; see the header of apps/worker/wrangler.toml.',
  );
  process.exit(2);
}

/** Per-request budget for every networked check. Generous, but never hangs. */
const NET_TIMEOUT_MS = 8000;

// The same rule config.ts applies, plus the ansible repo's marker.
const isPlaceholder = (value) => /todo/i.test(value) || /REPLACE_ME/.test(value);

// ---------------------------------------------------------------------------
// A deliberately small wrangler.toml reader.
//
// Node has no built-in TOML parser and this script must stay dependency-free,
// so rather than pull one in it scans for exactly the two shapes this file
// uses: a section header, and a `key = <scalar>` line. Quoted values are
// captured by regex, which drops any trailing `# comment` for free. Anything it
// cannot recognise is ignored rather than guessed at, and every value it needs
// is asserted present below, so a shape it failed to read surfaces as a
// blocker and never as a silent pass.
// ---------------------------------------------------------------------------
function readToml(path) {
  // name -> array of entries. A plain `[table]` holds exactly one entry; an
  // `[[array of tables]]` holds one per occurrence.
  const sections = new Map();
  let entry = null;

  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const header = line.match(/^\[(\[?)([^\]]+)\]/);
    if (header) {
      const name = header[2].trim();
      if (!sections.has(name)) sections.set(name, []);
      const bucket = sections.get(name);
      // `[[x]]` always opens a new entry; `[x]` reuses the one it already has.
      if (header[1] === '[' || bucket.length === 0) bucket.push({});
      entry = bucket[bucket.length - 1];
      continue;
    }

    if (!entry) continue; // a key before any header: not a shape this file uses
    const quoted = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"/);
    if (quoted) {
      entry[quoted[1]] = quoted[2];
      continue;
    }
    // Unquoted scalar (`true`, `9901`, an inline table). Trailing `#` comment
    // stripped by hand, which quoted values get for free from the regex above.
    const bare = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
    if (bare) entry[bare[1]] = bare[2].split('#')[0].trim();
  }
  return sections;
}

/** Flatten a plain `[section]` into one key/value object. */
const tableOf = (sections, name) => Object.assign({}, ...(sections.get(name) ?? []));
/** Every entry of an `[[array of tables]]`. */
const arrayOf = (sections, name) => sections.get(name) ?? [];

const blockers = [];
const notes = [];
const block = (key, detail) => blockers.push({ key, detail });

let sections;
try {
  sections = readToml(WRANGLER_TOML);
} catch (error) {
  console.error(`preflight: cannot read ${WRANGLER_TOML}: ${error.message}`);
  process.exit(2);
}

const vars = tableOf(sections, `env.${env}.vars`);
if (Object.keys(vars).length === 0) {
  block(`env.${env}.vars`, `no [env.${env}.vars] block found in apps/worker/wrangler.toml.`);
}

// ── 1. placeholders in vars ────────────────────────────────────────────────
// Every var, not a hardcoded list: a var added later is covered without anyone
// remembering to add it here.
for (const [key, value] of Object.entries(vars)) {
  if (isPlaceholder(value)) {
    block(key, `still the unfilled placeholder '${value}'. See the comment above it in wrangler.toml for who supplies it.`);
  }
}

// ── 2. the vars config.ts treats as fatal ──────────────────────────────────
const REQUIRED_URLS = ['LINKEDIN_BASE_URL', 'ID_BASE_URL', 'ORCHESTRATION_BASE_URL', 'AUTH_ISSUER', 'MCP_RESOURCE_URL'];
for (const key of REQUIRED_URLS) {
  const value = vars[key];
  if (value === undefined || value.trim() === '') {
    block(key, 'is not set. config.ts treats this as fatal: /health and every mount answer 503.');
    continue;
  }
  if (isPlaceholder(value)) continue; // already reported, do not double-report
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    block(key, `'${value}' is not a URL.`);
    continue;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    block(key, `'${value}' is not an absolute http(s) URL.`);
  } else if (parsed.protocol === 'http:') {
    notes.push(`${key} is plain http. Cloudflare's edge will carry it, but the leg is in the clear.`);
  }
}

if (vars.AUTH_MODE !== 'jwt') {
  block(
    'AUTH_MODE',
    `is '${vars.AUTH_MODE ?? 'unset'}', and a deployed env must be 'jwt'. AUTH_MODE=dev accepts a server-side bearer in place of a client token; config.ts refuses to serve when it sees it outside a local ENV_NAME.`,
  );
}
if (vars.ENV_NAME !== env) {
  block('ENV_NAME', `is '${vars.ENV_NAME ?? 'unset'}' in the [env.${env}] block, which should say '${env}'.`);
}

// ── 3. the KV namespace id ─────────────────────────────────────────────────
// Unfilled this is only a WARNING to the worker (dangerous tools fail closed),
// but it is a BLOCKER here: shipping a deploy whose write path is dead the
// moment anyone tries to confirm one is not a deploy anybody wanted.
const kvEntries = arrayOf(sections, `env.${env}.kv_namespaces`);
const commitTokens = kvEntries.find((entry) => entry.binding === 'COMMIT_TOKENS');
if (!commitTokens) {
  block('COMMIT_TOKENS', `no [[env.${env}.kv_namespaces]] entry binds COMMIT_TOKENS.`);
} else if (!commitTokens.id || isPlaceholder(commitTokens.id)) {
  block(
    'COMMIT_TOKENS.id',
    `is '${commitTokens.id ?? 'unset'}'. Create it with \`wrangler kv namespace create COMMIT_TOKENS --env ${env}\` and paste the id. Without it every dangerous tool refuses at the confirm step.`,
  );
}

// ── 4. the rate-limit invariant ────────────────────────────────────────────
// wrangler.toml states these MUST stay equal: the binding enforces, the var is
// the ceiling quoted back to the agent. Drift is silent and only shows up as an
// agent retrying against a wall it was told it had room under.
const rateLimits = arrayOf(sections, `env.${env}.ratelimits`);
const limitOf = (name) => {
  const entry = rateLimits.find((candidate) => candidate.name === name);
  if (!entry?.simple) return null;
  const match = entry.simple.match(/limit\s*=\s*(\d+)/);
  return match ? Number(match[1]) : null;
};
for (const [bindingName, varName] of [
  ['RATE_LIMIT_CALLS', 'RATE_LIMIT_CALLS_PER_WINDOW'],
  ['RATE_LIMIT_WRITES', 'RATE_LIMIT_WRITES_PER_WINDOW'],
]) {
  const bound = limitOf(bindingName);
  const declared = vars[varName] === undefined ? null : Number(vars[varName]);
  if (bound === null) {
    block(bindingName, `no [[env.${env}.ratelimits]] entry named ${bindingName}, so the gate falls back to an isolate-local counter and a distributed caller is uncapped.`);
  } else if (declared !== null && declared !== bound) {
    block(varName, `says ${declared} but the ${bindingName} binding enforces ${bound}. The agent would be told a ceiling that is not the real one.`);
  }
}

// ── 5. the public entrance ─────────────────────────────────────────────────
// The custom domain, MCP_RESOURCE_URL and workers_dev describe ONE hostname
// between them, and nothing else notices when they stop agreeing. The worker
// would serve happily while publishing a `resource` nobody can reach and
// rejecting every token whose `aud` names the URL the client actually called.
const production = tableOf(sections, `env.${env}`);
const routes = production.routes ?? '';
const domainPattern = routes.match(/pattern\s*=\s*"([^"]+)"/)?.[1] ?? null;
const isCustomDomain = /custom_domain\s*=\s*true/.test(routes);

if (!domainPattern) {
  block(
    'routes',
    `[env.${env}] declares no route. With none the worker answers on nothing (workers_dev is off), so the deploy succeeds and the hostname 1016s.`,
  );
} else if (!isCustomDomain) {
  block(
    'routes',
    `'${domainPattern}' is declared as a ROUTE, not a custom domain. A route puts a Worker in front of an EXISTING origin and creates no DNS, so this hostname would keep resolving to whatever it resolved to before (or to nothing). This worker IS the server on its own hostname: it needs \`custom_domain = true\`.`,
  );
} else if (/[/*]/.test(domainPattern)) {
  block(
    'routes',
    `a custom domain takes a bare hostname, and '${domainPattern}' carries a path or a wildcard. wrangler rejects it at deploy time.`,
  );
}

const resourceUrl = vars.MCP_RESOURCE_URL ?? '';
if (domainPattern && resourceUrl && !isPlaceholder(resourceUrl)) {
  let resourceHost = null;
  try {
    resourceHost = new URL(resourceUrl).host;
  } catch {
    /* already blocked as a non-URL above */
  }
  if (resourceHost && resourceHost !== domainPattern) {
    block(
      'MCP_RESOURCE_URL',
      `names host '${resourceHost}' but the worker is deployed on '${domainPattern}'. That pair is the OAuth resource identity: the discovery document would advertise a URL this worker does not answer on, and every token whose \`aud\` is the real URL would be rejected with 'audience mismatch'.`,
    );
  }
}

if (production.workers_dev !== 'false') {
  block(
    'workers_dev',
    `is '${production.workers_dev ?? 'unset'}' in [env.${env}] and must be false. Otherwise the worker ALSO answers on gtm-mcp.<account>.workers.dev, a second public entrance that is not the URL MCP_RESOURCE_URL names, so a client reaching it gets a discovery document describing a different origin.`,
  );
}
if (production.preview_urls !== 'true') {
  block(
    'preview_urls',
    `is '${production.preview_urls ?? 'unset'}' in [env.${env}] and must be true. It is what makes \`wrangler versions upload\` print a preview URL, which is the pre-production rehearsal this repo has instead of a staging env (DEPLOY.md step 9). Without it there is no way to smoke the production bindings before they are live.`,
  );
}

// ---------------------------------------------------------------------------
// Everything above is offline. Stop here if any of it failed, so that a machine
// with no Cloudflare credentials and no network still gets a straight answer.
// ---------------------------------------------------------------------------
function report() {
  for (const note of notes) console.log(`  note: ${note}`);
  console.error(`\npreflight: NOT READY to deploy env.${env}. ${blockers.length} blocker(s):\n`);
  for (const { key, detail } of blockers) console.error(`  ${key}\n      ${detail}\n`);
  console.error(`Fix them in apps/worker/wrangler.toml, then re-run. Walkthrough: DEPLOY.md\n`);
}

if (blockers.length) {
  report();
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Phase 2: the edge. What the config points at, over plain HTTPS.
// ---------------------------------------------------------------------------

/** GET with a hard timeout. Never throws: the failure IS the answer. */
async function get(url, accept = 'application/json') {
  try {
    const response = await fetch(url, {
      headers: { accept, 'user-agent': 'gtm-mcp-preflight' },
      signal: AbortSignal.timeout(NET_TIMEOUT_MS),
      redirect: 'manual',
    });
    const text = await response.text().catch(() => '');
    return { ok: true, status: response.status, text };
  } catch (error) {
    return { ok: false, status: 0, text: '', error: String(error.message ?? error) };
  }
}

// 6. Each backend prefix answers at the edge, AND the thing answering is the
// service.
//
// This is the check that catches an ordering error nothing else can see: the
// gateway route for a service is published by a DIFFERENT repo (ansible), on a
// different day, by a different command. /live is the right probe:
// unauthenticated on all three services (src/routes/health.php), and behind the
// prefix-stripping gateway it lands as GET /live on the Laravel app itself.
//
// The STATUS CODE ALONE IS NOT ENOUGH, and this is not a hypothetical: measured
// on 2026-07-27, https://app.gtm-api.com/orchestration/v4/live answered 200
// with the SPA's index.html. An unpublished prefix does not necessarily 404 at
// this edge, because the front-end catch-all serves index.html for any path it
// does not recognise, and a 200 full of HTML would have been read as "the route
// is live" by every check that stops at the code. So the body has to say
// `{"status":"alive"}`, which only the Laravel HealthController produces.
const LIVE_BODY = /"status"\s*:\s*"alive"/;
const SERVICE_URL_VARS = [
  ['LINKEDIN_BASE_URL', 'linkedin'],
  ['ID_BASE_URL', 'id'],
  ['ORCHESTRATION_BASE_URL', 'orchestration'],
];
for (const [varName, service] of SERVICE_URL_VARS) {
  const base = (vars[varName] ?? '').replace(/\/$/, '');
  const probe = `${base}/live`;
  const result = await get(probe);
  const gatewayHint =
    'The gateway route is published by `gateway_routes` in the ansible repo (host_vars/id-beta.yml) and applied by ' +
    '`provision-id.yml --tags gateway`.';
  if (!result.ok) {
    block(varName, `could not be reached: GET ${probe} failed (${result.error}). Check the network, then that the host is up. A base URL nothing answers means every '${service}' tool fails at dispatch.`);
  } else if (result.status >= 500) {
    block(
      varName,
      `GET ${probe} answers ${result.status}: the prefix is routed but nothing healthy is behind it (the app is not deployed on that host, or it is down). Deploy the service first, then re-run.`,
    );
  } else if (result.status === 404) {
    block(varName, `GET ${probe} answers 404: the edge has no such prefix. ${gatewayHint} Until that runs, every '${service}' tool 404s at dispatch under a green /health.`);
  } else if (!LIVE_BODY.test(result.text)) {
    const shape = /^\s*</.test(result.text) ? 'HTML (the SPA catch-all, which serves index.html for any unrouted path)' : `${result.text.slice(0, 60).replace(/\s+/g, ' ')}...`;
    block(
      varName,
      `GET ${probe} answers ${result.status} but the body is not the service's health document: ${shape}. Something other than gtm.service.${service} owns that prefix at the edge, so every '${service}' tool would dispatch into it. ${gatewayHint}`,
    );
  }
}

// 7. The issuer this worker will exact-match is the one the id host publishes.
//
// verifier.ts does `payload.iss !== auth.issuer`, no normalisation, no
// trailing-slash tolerance. The id service now mints from config('jwt.issuer')
// and publishes the same key as its RFC 8414 `issuer`, so the metadata document
// is a faithful proxy for what a token will carry: if the string here differs
// from AUTH_ISSUER by so much as a slash, every real token 401s.
const issuer = (vars.AUTH_ISSUER ?? '').replace(/\/$/, '');
const metadataUrl = `${issuer}/.well-known/oauth-authorization-server`;
const metadata = await get(metadataUrl);
if (!metadata.ok) {
  block('AUTH_ISSUER', `could not be verified: GET ${metadataUrl} failed (${metadata.error}). That document is the authorization server an MCP client bootstraps from; a client cannot start an OAuth flow against a URL that does not answer.`);
} else if (metadata.status !== 200) {
  block('AUTH_ISSUER', `GET ${metadataUrl} answers ${metadata.status}. The id host publishes no RFC 8414 metadata at the URL this worker will advertise, so no MCP client can bootstrap OAuth against it.`);
} else {
  let published = null;
  try {
    published = JSON.parse(metadata.text).issuer ?? null;
  } catch {
    block('AUTH_ISSUER', `GET ${metadataUrl} answered 200 with a body that is not JSON. Something other than the id service is serving that path.`);
  }
  if (published !== null && published !== vars.AUTH_ISSUER) {
    block(
      'AUTH_ISSUER',
      `is '${vars.AUTH_ISSUER}' but the id host publishes issuer '${published}'. verifier.ts compares \`payload.iss\` to this string EXACTLY, so every token that host mints would 401 with 'issuer mismatch'. Either the id deploy carrying the explicit issuer claim has not shipped, or JWT_ISSUER / APP_URL on that host says something else.`,
    );
  }
}

// 8. mcp.gtm-api.com is free for wrangler to claim, or already ours.
//
// "You cannot create a Custom Domain on a hostname with an existing CNAME DNS
// record" is a hard Cloudflare rule, and it fails mid-deploy: the version is
// uploaded, the domain is not attached, and the operator is left reading an API
// error. Cheap to ask beforehand. A hostname that already resolves is only a
// problem if the thing answering is not this worker.
if (domainPattern) {
  let resolved = true;
  try {
    await lookup(domainPattern);
  } catch (error) {
    if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') resolved = false;
  }
  if (!resolved) {
    notes.push(`${domainPattern} does not resolve yet. Expected before the first deploy: wrangler creates the proxied record and the certificate itself.`);
  } else {
    const health = await get(`https://${domainPattern}/health`);
    const isThisWorker = health.ok && /"mounts"\s*:/.test(health.text) && /"tools"\s*:/.test(health.text);
    if (isThisWorker) {
      notes.push(`${domainPattern} already answers this worker's /health. This is a redeploy, not a first deploy.`);
    } else {
      block(
        'routes',
        `${domainPattern} already resolves, and what answers it is not this worker (GET /health -> ${health.ok ? `HTTP ${health.status}` : health.error}). Cloudflare refuses to attach a custom domain to a hostname that already has a record, so the deploy would fail half-applied. Delete the existing DNS record for ${domainPattern} in the gtm-api.com zone first.`,
      );
    }
  }
}

// 9. Optional: a real token, checked against the two claims the edge enforces.
//
// The one thing no configuration check can prove on its own is that a token the
// id host actually mints passes this worker's iss + aud checks, and that pair
// has never run against a real token (the unit tests use a synthetic issuer
// that matches by construction; the live e2e runs in AUTH_MODE=dev, where the
// iss check is relaxed). Export MCP_JWT and this becomes a decisive check
// rather than a post-deploy surprise. Absent, it is a note: `pnpm smoke`, which
// the runbook requires against the version preview URL BEFORE promoting, makes
// the same check with a token in hand.
const jwt = (process.env.MCP_JWT ?? '').trim();
if (!jwt) {
  notes.push('MCP_JWT is not set, so the iss/aud pair was checked against configuration only. `pnpm smoke` (DEPLOY.md step 9) checks it against a real token before anything is promoted.');
} else {
  const segments = jwt.split('.');
  let payload = null;
  if (segments.length === 3) {
    try {
      payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
    } catch {
      payload = null;
    }
  }
  if (!payload) {
    block('MCP_JWT', 'is set but is not a decodable three-segment JWT. Unset it or export a real token.');
  } else {
    if (payload.iss !== vars.AUTH_ISSUER) {
      block(
        'MCP_JWT',
        `carries iss '${payload.iss}', and AUTH_ISSUER is '${vars.AUTH_ISSUER}'. verifier.ts compares them exactly, so this token would 401 with 'issuer mismatch'. This is the check that has never run against a real token.`,
      );
    }
    const audience = payload.aud;
    const audienceOk =
      audience === undefined ||
      (Array.isArray(audience) ? audience.includes(vars.MCP_RESOURCE_URL) : audience === vars.MCP_RESOURCE_URL);
    if (!audienceOk) {
      block(
        'MCP_JWT',
        `carries aud '${JSON.stringify(audience)}', which does not include MCP_RESOURCE_URL '${vars.MCP_RESOURCE_URL}'. The edge rejects a present-but-wrong aud with 'audience mismatch'.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 3: the account. The two facts only Cloudflare holds.
// ---------------------------------------------------------------------------

/** Run a wrangler subcommand and parse the JSON it prints. */
function wranglerJson(args) {
  try {
    const raw = execFileSync('pnpm', ['exec', 'wrangler', ...args], {
      cwd: WORKER_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const start = raw.indexOf('[');
    if (start === -1) return { ok: false, error: 'no JSON in the output' };
    return { ok: true, data: JSON.parse(raw.slice(start)) };
  } catch (error) {
    return { ok: false, error: String(error.stderr || error.message).trim().split('\n').slice(-3).join(' ') };
  }
}

// 10. PREVIEW_TOKEN_SECRET is a wrangler secret, not a var, so it is not in the
// TOML and there is no way to know it is set without asking the account.
const secrets = wranglerJson(['secret', 'list', '--env', env]);
if (!secrets.ok) {
  block(
    'PREVIEW_TOKEN_SECRET',
    `could not be verified: \`wrangler secret list --env ${env}\` failed (${secrets.error}). Run \`wrangler login\` (or export CLOUDFLARE_API_TOKEN) and re-run.`,
  );
} else if (!secrets.data.some((entry) => entry.name === 'PREVIEW_TOKEN_SECRET')) {
  block(
    'PREVIEW_TOKEN_SECRET',
    `is not set on env.${env}. Set it with \`wrangler secret put PREVIEW_TOKEN_SECRET --env ${env}\`. Without it the preview gate is off and every dangerous tool refuses to execute.`,
  );
}

// 11. The configured KV id is a namespace that EXISTS in this account.
//
// A non-placeholder id is not the same as a real one, and the difference is
// invisible until the first commit token is written: a binding to an id nothing
// owns resolves at deploy time and throws at the first put(), which is the one
// path neither the tests nor the live e2e reach (no commit step ever runs).
if (commitTokens?.id && !isPlaceholder(commitTokens.id)) {
  const namespaces = secrets.ok
    ? wranglerJson(['kv', 'namespace', 'list'])
    : { ok: false, error: 'skipped: the account could not be reached (see PREVIEW_TOKEN_SECRET above)' };
  if (!namespaces.ok) {
    block('COMMIT_TOKENS.id', `could not be verified: ${namespaces.error}.`);
  } else if (!namespaces.data.some((entry) => entry.id === commitTokens.id)) {
    const titles = namespaces.data.map((entry) => `${entry.title} = ${entry.id}`).join('\n        ') || '(none)';
    block(
      'COMMIT_TOKENS.id',
      `'${commitTokens.id}' is not a KV namespace in this account. Every dangerous tool would fail at the confirm step with a KV error. Namespaces that do exist:\n        ${titles}`,
    );
  }
}

if (blockers.length) {
  report();
  process.exit(1);
}

for (const note of notes) console.log(`  note: ${note}`);
console.log(`preflight: env.${env} is ready to deploy.`);
