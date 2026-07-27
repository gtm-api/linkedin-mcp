import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ToolDefinition, ToolPackage } from '@gtm/mcp-runtime/types';
import { linkedinPackages } from '@gtm/mcp-linkedin';
import { idPackages } from '@gtm/mcp-id';
import { orchestrationPackages } from '@gtm/mcp-orchestration';
import { supportPackages } from '@gtm/mcp-support';

// Research parity gate: the registry against the DESIGN, not against the backend.
//
// Every other gate in this directory pins the registry to the running services.
// coverage-gate and oracle-freshness compare it to the route dump, contract-parity
// to the PHP attributes, step-eligibility to the internal hops. All of them measure
// the same thing from the same side: does the tool match the code that shipped.
//
// Nothing measured the other side. product/research/gtm.service.{svc}/entities/*.md
// is where a tool is DESIGNED, and it is the input the pipeline (research-to-backend,
// research-to-mcp) reads. A tool could drift from its research file in either
// direction and no gate would notice: a documented `mcp` action with no tool, a
// shipped tool no file admits to, a research bulk marker that contradicts the flag
// the tool carries. That is the half this file builds.
//
// The bulk-marker check is the third leg of a triangle. The PHP attribute and the
// oracle dump are already pinned to each other (contract-parity), and the oracle is
// already pinned to the registry. Adding research closes it, so a research file that
// lies about `Mass-action:` becomes visible instead of quietly seeding a wrong tool
// the next time the pipeline runs.
//
// WHAT THIS GATE DOES NOT COVER, and must never be mistaken for:
//   - It does NOT read the prose. Nothing here grades whether a description is
//     accurate, well written, useful for tool routing, or faithful to the research
//     file's Business context. Every description check below is mechanical: length,
//     emptiness, a banned character, a required prefix. A description that is fluent
//     and completely wrong passes.
//   - It does NOT check the request/response SHAPE against the research file's typed
//     contract (fields, filters, enums, envelopes). That is the oracle's job and it
//     is already covered from the backend side.
//   - It does NOT check permissions, credits, error tables, events, or anything else
//     the research file specifies.
//   - It does NOT know whether the research file is RIGHT. A file and a tool that are
//     wrong in exactly the same way read green here. This gate proves they AGREE.
// Semantic review stays a human act. Green here means nothing about design quality.
//
// Parsing is defensive because the research corpus is hand written and its Endpoints
// registry appears in at least five header shapes (see SHAPES below). Rows that could
// not be resolved are COUNTED and printed by the coverage guard rather than silently
// dropped, so a parser that quietly stopped seeing a file shows up as a number that
// moved, not as a gate that went green.
//
// Offline: markdown files plus the in-process registry, no backend calls.

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const RESEARCH_ROOT = fileURLToPath(new URL('../../../research/', import.meta.url));
const BASELINE_PATH = fileURLToPath(new URL('../fixtures/research-parity/baseline.json', import.meta.url));

/** §4.32 description budget, flat. The per-class caps (trivial 200 / typical 500 /
 *  complex 1500) are the doctrine, but `toolClass` is optional on ToolDefinition,
 *  so a flat pair is the only budget every tool can be held to. SOFT is a printed
 *  warning, HARD is a failure. Measured on the AUTHORED `description`: the runtime
 *  appends the bulk affordance marker (packages/runtime/src/tool-description.ts)
 *  deterministically, and a tool must not be charged for a string it did not write. */
const SOFT_BUDGET = 500;
const HARD_BUDGET = 1024;

/** CLAUDE.md bans both as punctuation. Escaped so this file stays clean itself. */
const DASH_RE = /[\u2013\u2014]/;

/** The prefix a not-yet-shipped tool must lead with, so an agent reading tools/list
 *  sees the 501 before it plans a call. Optional leading marker emoji. */
const STUB_PREFIX_RE = /^\s*(⛔\s*)?NOT SHIPPED YET\b/;

/** The six canonical CRUD verbs of §4.26. Anything else in an Endpoints registry is
 *  a Custom Action, and only Custom Actions carry a bulk marker (massAction and
 *  stepEligible are ACTION only, enforced by buildRegistry). Classifying by the verb
 *  NAME rather than by which table the row sat in survives the files that never split
 *  the registry into two tables at all. */
const CANONICAL_ACTIONS = new Set(['search', 'get', 'create', 'update', 'delete', 'metrics', 'group-by', 'group by', 'group_by']);

type ServiceSpec = {
  name: string;
  /** Directory under product/research, or null when the service has no research at
   *  all. A null dir is not a failure: it makes every tool of that service a printed
   *  SKIP, which is the honest reading of "we cannot check this". */
  researchDir: string | null;
  packages: ToolPackage[];
};

const SERVICES: ServiceSpec[] = [
  { name: 'linkedin', researchDir: 'gtm.service.linkedin', packages: linkedinPackages },
  { name: 'id', researchDir: 'gtm.service.id', packages: idPackages },
  { name: 'orchestration', researchDir: 'gtm.service.orchestration', packages: orchestrationPackages },
  // gtm.service.support is a worker-local knowledge surface with no backend service
  // and no research directory. Carried explicitly so its tools are reported as skips
  // with a reason instead of vanishing from the tool side of the count.
  { name: 'support', researchDir: null, packages: supportPackages },
];

// ---------------------------------------------------------------------------
// Markdown parsing
// ---------------------------------------------------------------------------

// SHAPES observed in the corpus, all of them handled by resolving columns by NAME
// rather than by position:
//   1. | Action | Method + Path | Status | Request type | Response type | Notes |   (87 tables)
//   2. | Tool | HTTP | Class | Supported | Note |                                   (id/oauth_authorizations)
//   3. | Action | Path | Ledger method | Plugin verb | Cost | Matrix row | Notes |   (linkedin/linkedin_scraping, no status column)
//   4. | Operation | Method | Path | Notes |                                        (linkedin/linkedin_account_sync_run, no status column)
//   5. | Operation | Route | State |                                                (id/support_requests)
// A sixth shape appearing tomorrow does not break the gate: it lands in the unparsed
// count, which the coverage guard prints and holds.

const ACTION_COL_RE = /^(action|tool|verb|operation|endpoint)$/;
const PATH_COL_RE = /^(method \+ path|method\+path|path|http|route|method|endpoint|uri)$/;
const STATUS_COL_RE = /^(status|supported|class|state)$/;
const HTTP_METHOD_RE = /\b(GET|POST|PUT|PATCH|DELETE)\b/;
const HTTP_PATH_RE = /\/(?:api|internal|external)\/[A-Za-z0-9_\-{}/.]+/;

const stripMd = (text: string): string => text.replace(/`|\*\*|__/g, '').trim();
/** Header cells reduce to letters, spaces and '+', so 'Method + Path' and
 *  'Ledger method (`DataRequestMethodEnum`)' both become comparable tokens. */
const headerKey = (text: string): string => stripMd(text).toLowerCase().replace(/[^a-z+ ]/g, '').trim();

type Section = { line: number; level: number; title: string; parent: string | null; body: string[] };
type Table = { line: number; headers: string[]; rows: { line: number; cells: string[] }[] };

function sections(lines: string[]): Section[] {
  const heads: { line: number; level: number; title: string }[] = [];
  lines.forEach((line, index) => {
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (match) heads.push({ line: index, level: match[1].length, title: match[2].trim() });
  });
  return heads.map((head, index) => {
    let end = lines.length;
    for (const next of heads.slice(index + 1)) {
      if (next.level <= head.level) { end = next.line; break; }
    }
    let parent: string | null = null;
    for (let back = index - 1; back >= 0; back -= 1) {
      if (heads[back].level < head.level) { parent = heads[back].title; break; }
    }
    return { line: head.line, level: head.level, title: head.title, parent, body: lines.slice(head.line + 1, end) };
  });
}

/** Every GitHub-flavoured table in a block: a pipe row followed by a separator row. */
function tables(body: string[], baseLine: number): Table[] {
  const out: Table[] = [];
  let index = 0;
  while (index < body.length) {
    const isHeader = body[index].trimStart().startsWith('|')
      && index + 1 < body.length
      && /^\s*\|[\s:|-]+\|\s*$/.test(body[index + 1]);
    if (!isHeader) { index += 1; continue; }
    const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
    const headers = cells(body[index]).map(headerKey);
    const rows: Table['rows'] = [];
    let cursor = index + 2;
    while (cursor < body.length && body[cursor].trimStart().startsWith('|')) {
      rows.push({ line: baseLine + cursor, cells: cells(body[cursor]) });
      cursor += 1;
    }
    out.push({ line: baseLine + index, headers, rows });
    index = cursor;
  }
  return out;
}

type RowStatus = 'mcp' | 'internal' | 'external' | 'not_supported' | 'undeclared' | 'unknown';

/** Collapse whatever status vocabulary the file uses onto the §4.26 tri-state plus the
 *  two escapes the corpus actually contains ('external', 'planned'). Negatives are
 *  tested FIRST because several shapes spell the negative inside a cell that also
 *  carries the word 'mcp' or a tick. */
function readStatus(text: string): RowStatus {
  const value = stripMd(text).toLowerCase();
  if (!value) return 'undeclared';
  if (/not supported|not-supported|⛔|❌|never|planned|deferred/.test(value)) return 'not_supported';
  if (value.includes('internal')) return 'internal';
  if (value.includes('external')) return 'external';
  if (value.includes('mcp')) return 'mcp';
  if (value.includes('✅')) return 'mcp';
  return 'unknown';
}

type ResearchRow = {
  service: string;
  file: string;
  line: number;
  action: string;
  method: string | null;
  path: string | null;
  status: RowStatus;
  /** Whole row text, joined. The bulk marker lives in a Notes column whose position
   *  differs per shape, so it is matched against the row, not against a column. */
  raw: string;
  isCustom: boolean;
};

type ParsedFile = { file: string; rows: ResearchRow[]; unparsed: string[] };

function parseResearchFile(service: string, dir: string, fileName: string): ParsedFile {
  const path = `${RESEARCH_ROOT}${dir}/entities/${fileName}`;
  const label = `${service}/${fileName}`;
  const lines = readFileSync(path, 'utf8').split('\n');
  const unparsed: string[] = [];
  const rows: ResearchRow[] = [];
  const all = sections(lines);

  // The tri-state registry lives under `#### Endpoints`. Preferring its Standard /
  // Custom Actions SUBSECTIONS keeps the per-tool detail blocks of `#### MCP Tools`
  // (which repeat both headings, with per-tool tables underneath) out of scope. Files
  // that never split the registry fall back to the Endpoints section itself.
  const isEndpoints = (title: string | null) => !!title && /^Endpoints\b/.test(stripMd(title));
  const split = all.filter((s) => /^\**\s*(Standard|Custom) Actions/i.test(s.title) && isEndpoints(s.parent));
  const scope = split.length ? split : all.filter((s) => isEndpoints(s.title));

  if (!scope.length) {
    unparsed.push(`${label}: no Endpoints section and no Standard/Custom Actions section, whole file skipped`);
    return { file: label, rows, unparsed };
  }

  for (const section of scope) {
    for (const table of tables(section.body, section.line + 1)) {
      const actionIndex = table.headers.findIndex((h) => ACTION_COL_RE.test(h));
      const pathIndexes = table.headers.map((h, i) => (PATH_COL_RE.test(h) && i !== actionIndex ? i : -1)).filter((i) => i >= 0);
      const statusIndexes = table.headers.map((h, i) => (STATUS_COL_RE.test(h) ? i : -1)).filter((i) => i >= 0);

      if (actionIndex < 0 || !pathIndexes.length) {
        // Not an endpoint registry (permissions, notes, matrices). Only worth a note
        // when it half looks like one, which is the shape a new dialect would take.
        if (actionIndex >= 0 || pathIndexes.length) {
          unparsed.push(`${label}:${table.line + 1}: table '${table.headers.join('|')}' has no action+path column pair, ${table.rows.length} rows skipped`);
        }
        continue;
      }
      if (!statusIndexes.length) {
        unparsed.push(`${label}:${table.line + 1}: table '${table.headers.join('|')}' has no status column, ${table.rows.length} rows anchor tools but cannot demand one`);
      }

      const widest = Math.max(actionIndex, ...pathIndexes, ...statusIndexes);
      for (const row of table.rows) {
        if (row.cells.length <= widest) {
          unparsed.push(`${label}:${row.line + 1}: row has ${row.cells.length} cells, needs ${widest + 1}`);
          continue;
        }
        const routeText = pathIndexes.map((i) => row.cells[i]).join(' ');
        const method = HTTP_METHOD_RE.exec(routeText);
        const routePath = HTTP_PATH_RE.exec(routeText);
        const action = stripMd(row.cells[actionIndex]);
        const status = statusIndexes.length ? readStatus(statusIndexes.map((i) => row.cells[i]).join(' ')) : 'undeclared';
        if (status === 'mcp' && !routePath) {
          unparsed.push(`${label}:${row.line + 1}: '${action}' is Status mcp but carries no /api path, so it cannot be matched to a tool`);
        }
        rows.push({
          service,
          file: label,
          line: row.line + 1,
          action,
          method: method ? method[1] : null,
          path: routePath ? routePath[0] : null,
          status,
          raw: row.cells.join(' | '),
          isCustom: !CANONICAL_ACTIONS.has(action.toLowerCase()),
        });
      }
    }
  }
  if (!rows.length) unparsed.push(`${label}: Endpoints section found but no action rows parsed out of it`);
  return { file: label, rows, unparsed };
}

// ---------------------------------------------------------------------------
// Research corpus
// ---------------------------------------------------------------------------

const entityFiles = (dir: string): string[] => {
  const base = `${RESEARCH_ROOT}${dir}/entities/`;
  if (!existsSync(base)) return [];
  return readdirSync(base).sort().filter((file) => file.endsWith('.md') && file !== 'README.md');
};

type Corpus = {
  service: string;
  rows: ResearchRow[];
  unparsed: string[];
  files: number;
  /** entity file stem -> the paths it documents, for the tool -> research direction. */
  pathsByEntity: Map<string, Set<string>>;
  /** Every path the service documents anywhere, so a tool filed under a neighbouring
   *  entity reads as "documented elsewhere" rather than as an orphan. */
  allPaths: Set<string>;
  entityStems: Set<string>;
};

function loadCorpus(spec: ServiceSpec): Corpus {
  const empty: Corpus = {
    service: spec.name, rows: [], unparsed: [], files: 0,
    pathsByEntity: new Map(), allPaths: new Set(), entityStems: new Set(),
  };
  if (!spec.researchDir) return empty;
  const files = entityFiles(spec.researchDir);
  if (!files.length) return empty;

  const parsed = files.map((file) => parseResearchFile(spec.name, spec.researchDir as string, file));
  const rows = parsed.flatMap((p) => p.rows);
  const pathsByEntity = new Map<string, Set<string>>();
  const allPaths = new Set<string>();
  for (const row of rows) {
    if (!row.path) continue;
    const stem = row.file.split('/')[1].replace(/\.md$/, '');
    if (!pathsByEntity.has(stem)) pathsByEntity.set(stem, new Set());
    pathsByEntity.get(stem)!.add(row.path);
    allPaths.add(row.path);
  }
  return {
    service: spec.name,
    rows,
    unparsed: parsed.flatMap((p) => p.unparsed),
    files: files.length,
    pathsByEntity,
    allPaths,
    entityStems: new Set(files.map((f) => f.replace(/\.md$/, ''))),
  };
}

const CORPUS = new Map(SERVICES.map((spec) => [spec.name, loadCorpus(spec)]));

// Every registered tool, keyed by route. Direction 1 resolves ACROSS services on
// purpose: an entity that was re-homed (account_shares moved from linkedin to id)
// still has a research file in the old service's directory, and the tool that answers
// it lives in the new one. Matching per service would report that as missing.
const ALL_TOOLS: { service: string; entity: string; tool: ToolDefinition }[] = SERVICES.flatMap((spec) =>
  spec.packages.flatMap((pkg) => pkg.tools.map((tool) => ({ service: spec.name, entity: pkg.entity, tool }))),
);
const TOOLS_BY_ROUTE = new Map<string, ToolDefinition[]>();
const TOOLS_BY_PATH = new Map<string, ToolDefinition[]>();
for (const { tool } of ALL_TOOLS) {
  const route = `${tool.route.method} ${tool.route.pathTemplate}`;
  TOOLS_BY_ROUTE.set(route, [...(TOOLS_BY_ROUTE.get(route) ?? []), tool]);
  TOOLS_BY_PATH.set(tool.route.pathTemplate, [...(TOOLS_BY_PATH.get(tool.route.pathTemplate) ?? []), tool]);
}

/** The tool a research row claims, or null. A row whose shape carried no HTTP method
 *  (shape 3 states the method in prose above the table) falls back to path only. */
const toolForRow = (row: ResearchRow): ToolDefinition | null => {
  if (!row.path) return null;
  const exact = row.method ? TOOLS_BY_ROUTE.get(`${row.method} ${row.path}`) : undefined;
  if (exact?.length) return exact[0];
  if (!row.method) {
    const byPath = TOOLS_BY_PATH.get(row.path);
    if (byPath?.length) return byPath[0];
  }
  return null;
};

/** Package entity -> research file stem. The two vocabularies agree everywhere except
 *  a plural/singular slip, so one fallback each way covers it; anything else is a
 *  printed skip, never a silent pass. */
function researchStem(corpus: Corpus, entity: string): string | null {
  const candidates = [entity, entity.endsWith('s') ? entity.slice(0, -1) : `${entity}s`];
  return candidates.find((c) => corpus.entityStems.has(c)) ?? null;
}

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

type Baseline = {
  missing_tools: { key: string; reason: string }[];
  orphan_tools: { key: string; reason: string }[];
  marker_mismatches: { key: string; reason: string }[];
  description_issues: { key: string; reason: string }[];
};

const baseline: Baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
const BUCKETS = ['missing_tools', 'orphan_tools', 'marker_mismatches', 'description_issues'] as const;
type Bucket = (typeof BUCKETS)[number];

const waived = new Map<Bucket, Set<string>>(BUCKETS.map((b) => [b, new Set(baseline[b].map((e) => e.key))]));
const observed = new Map<Bucket, Set<string>>(BUCKETS.map((b) => [b, new Set<string>()]));

/** Record every finding, return the ones nobody waived. Recording happens for waived
 *  findings too: that is what lets the hygiene test fail a waiver that stopped
 *  applying, which is the whole reason the file can only shrink. */
function unwaived(bucket: Bucket, findings: { key: string; message: string }[]): string[] {
  const out: string[] = [];
  for (const finding of findings) {
    observed.get(bucket)!.add(finding.key);
    if (!waived.get(bucket)!.has(finding.key)) out.push(finding.message);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

const MASS_MARKER_RE = /\*\*\s*Mass-action:\s*([^*]*?)\s*\*\*/i;
const STEP_MARKER_RE = /\*\*\s*step-eligible:\s*([^*]*?)\s*\*\*/i;

type Finding = { key: string; message: string };
type ServiceReport = {
  missing: Finding[];
  orphan: Finding[];
  markers: Finding[];
  descriptions: Finding[];
  softWarnings: string[];
  skips: string[];
  /** Rows whose Custom-Action marker the file never stated, and rows whose marker is
   *  qualified '(TARGET)', meaning the file is describing where the design is going
   *  rather than what shipped. Neither is a mismatch; both are printed so a file that
   *  stopped stating its markers is visible. */
  markerNotStated: number;
  markerTarget: number;
};

function report(spec: ServiceSpec): ServiceReport {
  const corpus = CORPUS.get(spec.name)!;
  const out: ServiceReport = {
    missing: [], orphan: [], markers: [], descriptions: [],
    softWarnings: [], skips: [], markerNotStated: 0, markerTarget: 0,
  };

  // 1a. research -> tool. Only `mcp` rows on the public /api surface make a claim.
  for (const row of corpus.rows) {
    if (row.status !== 'mcp' || !row.path?.startsWith('/api/')) continue;
    if (toolForRow(row)) continue;
    const route = `${row.method ?? 'METHOD?'} ${row.path}`;
    out.missing.push({
      key: `${row.file} ${route}`,
      message: `${row.file}:${row.line} '${row.action}' is Status \`mcp\` at ${route} but no registry tool serves that route`,
    });
  }

  // 1b. tool -> research.
  for (const pkg of spec.packages) {
    if (!spec.researchDir) {
      out.skips.push(`${spec.name}/${pkg.entity}: service has no product/research/gtm.service.${spec.name} directory, ${pkg.tools.length} tools unchecked`);
      continue;
    }
    const stem = researchStem(corpus, pkg.entity);
    if (!stem) {
      out.skips.push(`${spec.name}/${pkg.entity}: no research file named ${pkg.entity}.md (or its singular/plural), ${pkg.tools.length} tools unchecked`);
      continue;
    }
    const documented = corpus.pathsByEntity.get(stem) ?? new Set<string>();
    for (const tool of pkg.tools) {
      const path = tool.route.pathTemplate;
      if (documented.has(path)) continue;
      const elsewhere = corpus.allPaths.has(path) ? ' (a different entity file in this service documents it, so one of the two files is filed wrong)' : '';
      out.orphan.push({
        key: `${spec.name} ${tool.name} ${tool.route.method} ${path}`,
        message: `${spec.name}: tool '${tool.name}' serves ${tool.route.method} ${path} but ${stem}.md has no Endpoints row for it${elsewhere}`,
      });
    }
  }

  // 2. bulk marker parity, Custom Actions only (massAction and stepEligible are
  //    ACTION only, enforced by buildRegistry).
  for (const row of corpus.rows) {
    if (row.status !== 'mcp' || !row.isCustom) continue;
    const tool = toolForRow(row);
    if (!tool) continue;
    const mass = MASS_MARKER_RE.exec(row.raw);
    const step = STEP_MARKER_RE.exec(row.raw);

    if (!mass) {
      out.markerNotStated += 1;
    } else if (/target/i.test(mass[1])) {
      out.markerTarget += 1;
    } else {
      const claimsMass = /^yes/i.test(mass[1].trim());
      const claimsSchedule = /schedule required/i.test(mass[1]);
      if (claimsMass !== (tool.massAction ?? false)) {
        out.markers.push({
          key: `${row.file} ${row.action} massAction`,
          message: `${row.file}:${row.line} '${row.action}' says **Mass-action: ${mass[1].trim()}** but tool '${tool.name}' carries massAction=${tool.massAction ?? false}`,
        });
      }
      if (claimsSchedule !== (tool.scheduleRequired ?? false)) {
        out.markers.push({
          key: `${row.file} ${row.action} scheduleRequired`,
          message: `${row.file}:${row.line} '${row.action}' marker schedule-required=${claimsSchedule} but tool '${tool.name}' carries scheduleRequired=${tool.scheduleRequired ?? false}`,
        });
      }
    }

    // step-eligible is an OPTIONAL note. Absent means the file says nothing, which is
    // not the same as saying 'no', so absence asserts nothing and is counted instead.
    if (!step) continue;
    if (/target/i.test(step[1])) { out.markerTarget += 1; continue; }
    const claimsStep = /^yes/i.test(step[1].trim());
    if (claimsStep !== (tool.stepEligible ?? false)) {
      out.markers.push({
        key: `${row.file} ${row.action} stepEligible`,
        message: `${row.file}:${row.line} '${row.action}' says **step-eligible: ${step[1].trim()}** but tool '${tool.name}' carries stepEligible=${tool.stepEligible ?? false}`,
      });
    }
  }

  // 3. description health, mechanical only.
  for (const pkg of spec.packages) {
    for (const tool of pkg.tools) {
      const text = tool.description;
      if (!text.trim()) {
        out.descriptions.push({ key: `${tool.name} empty`, message: `${tool.name}: description is empty` });
        continue;
      }
      if (text.length > HARD_BUDGET) {
        out.descriptions.push({
          key: `${tool.name} over_hard_budget`,
          message: `${tool.name}: description is ${text.length} chars, over the ${HARD_BUDGET} hard budget (§4.32)`,
        });
      } else if (text.length > SOFT_BUDGET) {
        out.softWarnings.push(`${tool.name} ${text.length} chars`);
      }
      if (DASH_RE.test(text)) {
        out.descriptions.push({ key: `${tool.name} dash`, message: `${tool.name}: description carries an em or en dash (banned by CLAUDE.md)` });
      }
      const hasPrefix = STUB_PREFIX_RE.test(text);
      if (tool.availability === 'stub_501' && !hasPrefix) {
        out.descriptions.push({
          key: `${tool.name} missing_stub_prefix`,
          message: `${tool.name}: availability is stub_501 but the description does not open with the NOT SHIPPED YET prefix, so an agent plans a call that 501s`,
        });
      }
      if (tool.availability === 'ga' && hasPrefix) {
        out.descriptions.push({
          key: `${tool.name} stray_stub_prefix`,
          message: `${tool.name}: availability is ga but the description still opens with the NOT SHIPPED YET prefix`,
        });
      }
    }
  }

  return out;
}

const REPORTS = new Map(SERVICES.map((spec) => [spec.name, report(spec)]));

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

for (const spec of SERVICES) {
  describe(`research parity: ${spec.name}`, () => {
    const corpus = CORPUS.get(spec.name)!;
    const found = REPORTS.get(spec.name)!;
    const tools = spec.packages.flatMap((p) => p.tools);

    it('reads a research corpus that actually carries endpoint rows', () => {
      // Guard the guard: every assertion below reads green against an empty corpus,
      // and an empty corpus is exactly what a moved directory or a broken parser
      // produces. Skips are printed rather than silently absorbed.
      /* eslint-disable-next-line no-console */
      console.log(
        `${spec.name}: ${tools.length} tools vs ${corpus.rows.length} research rows in ${corpus.files} files `
        + `(${corpus.rows.filter((r) => r.status === 'mcp').length} mcp, ${corpus.unparsed.length} unparsed notes, `
        + `${found.markerNotStated} custom rows state no bulk marker, ${found.markerTarget} markers are TARGET-qualified).`,
      );
      for (const skip of found.skips) {
        /* eslint-disable-next-line no-console */
        console.log(`${spec.name}: SKIP ${skip}`);
      }
      if (!spec.researchDir) {
        expect(corpus.rows.length, 'a service declared with no research directory must carry no rows').toBe(0);
        return;
      }
      expect(corpus.files, `no entity markdown under product/research/${spec.researchDir}/entities`).toBeGreaterThan(0);
      expect(corpus.rows.length, `parsed no endpoint rows from ${spec.researchDir}: the Endpoints tables changed shape, so this gate checked nothing`).toBeGreaterThan(0);
    });

    it('every research row marked `mcp` has a registry tool', () => {
      const open = unwaived('missing_tools', found.missing);
      expect(
        open,
        `${spec.name}: the research says these are MCP surfaces and the registry has no tool for them. `
        + 'Either ship the tool or correct the row Status (§4.26 tri-state). '
        + `To accept the gap on purpose, add its key to ${'fixtures/research-parity/baseline.json'} with a reason:\n${open.join('\n')}`,
      ).toEqual([]);
    });

    it('every registry tool traces back to a research row', () => {
      const open = unwaived('orphan_tools', found.orphan);
      expect(
        open,
        `${spec.name}: these tools exist with nothing in the research to design them. `
        + 'The research file is the source of truth the pipeline reads, so a tool it does not mention will be dropped or rebuilt wrong on the next pass. '
        + `Add the Endpoints row, or waive it in ${'fixtures/research-parity/baseline.json'}:\n${open.join('\n')}`,
      ).toEqual([]);
    });

    it('research bulk markers agree with the tool flags', () => {
      const open = unwaived('marker_mismatches', found.markers);
      expect(
        open,
        `${spec.name}: the Custom-Actions bulk marker and the tool disagree. `
        + 'The PHP attribute and the oracle are already pinned to each other, so this is the leg that catches a research file lying about fan-out:\n'
        + open.join('\n'),
      ).toEqual([]);
    });

    it('tool descriptions are mechanically sound', () => {
      if (found.softWarnings.length) {
        /* eslint-disable-next-line no-console */
        console.log(`${spec.name}: ${found.softWarnings.length} descriptions over the ${SOFT_BUDGET} char soft target (warning only): ${found.softWarnings.join(', ')}`);
      }
      const open = unwaived('description_issues', found.descriptions);
      expect(
        open,
        `${spec.name}: description problems that need no reading to see. `
        + 'This checks length, emptiness, the banned dash and the stub prefix ONLY: it says nothing about whether the prose is right.\n'
        + open.join('\n'),
      ).toEqual([]);
    });
  });
}

describe('research parity: gate hygiene', () => {
  it('parse coverage is reported, not assumed', () => {
    const notes = SERVICES.flatMap((spec) => CORPUS.get(spec.name)!.unparsed);
    const files = SERVICES.reduce((sum, spec) => sum + CORPUS.get(spec.name)!.files, 0);
    const rows = SERVICES.reduce((sum, spec) => sum + CORPUS.get(spec.name)!.rows.length, 0);
    /* eslint-disable-next-line no-console */
    console.log(`research corpus: ${files} entity files, ${rows} endpoint rows parsed, ${notes.length} parse notes.`);
    for (const note of notes) {
      /* eslint-disable-next-line no-console */
      console.log(`  unparsed: ${note}`);
    }
    // Not an assertion on the note COUNT: hand written markdown grows new dialects and
    // a note is a fact to read, not a failure. What is asserted is that the corpus was
    // read at all, which is the failure mode that would make every check above vacuous.
    expect(files, 'no research entity files were read').toBeGreaterThan(20);
    expect(rows, 'no endpoint rows were parsed from any file').toBeGreaterThan(200);
  });

  it('the baseline only shrinks: no waiver survives the drift it waived', () => {
    const stale: string[] = [];
    for (const bucket of BUCKETS) {
      for (const entry of baseline[bucket]) {
        if (!observed.get(bucket)!.has(entry.key)) {
          stale.push(`${bucket}: '${entry.key}' no longer drifts. Delete the line.`);
        }
      }
    }
    /* eslint-disable-next-line no-console */
    console.log(
      `baseline: ${BUCKETS.map((b) => `${b}=${baseline[b].length}`).join(' ')} `
      + `(observed ${BUCKETS.map((b) => `${b}=${observed.get(b)!.size}`).join(' ')}).`,
    );
    expect(
      stale,
      'A waiver that stopped applying must be removed in the same change that fixed it, '
      + 'which is what keeps fixtures/research-parity/baseline.json a ledger of debt rather than a place drift goes to hide.',
    ).toEqual([]);
  });

  it('every waiver key is unique inside its bucket', () => {
    const dupes: string[] = [];
    for (const bucket of BUCKETS) {
      const seen = new Set<string>();
      for (const entry of baseline[bucket]) {
        if (seen.has(entry.key)) dupes.push(`${bucket}: duplicate key '${entry.key}'`);
        seen.add(entry.key);
      }
      for (const entry of baseline[bucket]) {
        if (!entry.reason?.trim()) dupes.push(`${bucket}: '${entry.key}' carries no reason`);
      }
    }
    expect(dupes, 'a waiver without a unique key and a reason is not reviewable').toEqual([]);
  });
});
