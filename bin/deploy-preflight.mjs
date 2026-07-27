#!/usr/bin/env node
// Refuse to deploy a worker that cannot serve.
//
//   pnpm deploy:preflight            # checks env.production
//   pnpm deploy:preflight:staging    # checks env.staging
//
// `apps/worker/package.json` runs this ahead of every `wrangler deploy`, so the
// only way to ship an unfilled config is to bypass the script on purpose.
//
// WHY IT EXISTS. wrangler validates TOML syntax, not meaning: it will happily
// publish `LINKEDIN_BASE_URL = "https://TODO-linkedin-prod-url"` to the public
// internet. The worker then boots, serves a catalog of 250 tools built from the
// env-independent registry, and fails every single call at dispatch. The
// failure is also expensive to read from outside, because a 503 from
// config.ts's fatal path looks the same as a worker that is down.
//
// ORDERING IS THE WHOLE DESIGN. Every offline check runs FIRST and the script
// exits before touching the network if any of them fail. That is what lets it
// answer "not ready" on a laptop with no `wrangler login`, no
// CLOUDFLARE_API_TOKEN and no network at all, which is when you most want to
// ask. The one check that genuinely needs the account (is PREVIEW_TOKEN_SECRET
// set on this env) runs last, and only when everything else already passed.
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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER_TOML = join(ROOT, 'apps', 'worker', 'wrangler.toml');
const WORKER_DIR = join(ROOT, 'apps', 'worker');

const env = process.argv[2] ?? 'production';
if (!['production', 'staging'].includes(env)) {
  console.error(`preflight: unknown environment '${env}'. Use 'production' or 'staging'.`);
  process.exit(2);
}

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

// ---------------------------------------------------------------------------
// Everything above is offline. Stop here if any of it failed, so that a machine
// with no Cloudflare credentials still gets a straight answer.
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

// ── 5. the deploy secret (the only networked check) ────────────────────────
// PREVIEW_TOKEN_SECRET is a wrangler secret, not a var, so it is not in the
// TOML and there is no way to know it is set without asking the account.
// Unreachable or unauthenticated is reported as a blocker rather than a pass:
// "I could not check" and "it is fine" are different answers, and only one of
// them should let a deploy through.
let secretNames;
try {
  const raw = execFileSync('pnpm', ['exec', 'wrangler', 'secret', 'list', '--env', env], {
    cwd: WORKER_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const json = raw.slice(raw.indexOf('['));
  secretNames = JSON.parse(json).map((entry) => entry.name);
} catch (error) {
  const detail = String(error.stderr || error.message).trim().split('\n').slice(-3).join(' ');
  block(
    'PREVIEW_TOKEN_SECRET',
    `could not be verified: \`wrangler secret list --env ${env}\` failed (${detail}). Run \`wrangler login\` (or export CLOUDFLARE_API_TOKEN) and re-run. Everything checkable offline already passed.`,
  );
}

if (secretNames && !secretNames.includes('PREVIEW_TOKEN_SECRET')) {
  block(
    'PREVIEW_TOKEN_SECRET',
    `is not set on env.${env}. Set it with \`wrangler secret put PREVIEW_TOKEN_SECRET --env ${env}\`. Without it the preview gate is off and every dangerous tool refuses to execute.`,
  );
}

if (blockers.length) {
  report();
  process.exit(1);
}

for (const note of notes) console.log(`  note: ${note}`);
console.log(`preflight: env.${env} is ready to deploy.`);
