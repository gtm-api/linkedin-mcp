import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Cross-service step-eligibility gate.
//
// `#[ApiMethod(..., stepEligible: true)]` (SERVICE_CONVENTIONS §R4) says the
// mass-action engine on gtm.service.orchestration may run that verb as a plan
// step: it mints one item per target and calls the OWNING service's verb over
// its `/internal/*` hop, once per item. The claim therefore has two halves - an
// arm in the executor, and the internal route that arm calls - and they live in
// different repositories.
//
// This is the only gate that sees every service at once, which is why it reads
// the fixture DIRECTORY rather than a hardcoded list: a service whose backend
// declares a step-eligible verb is checked here whether or not it has an MCP
// package yet. gtm.service.email is exactly that case today - no @gtm/mcp-email,
// but `email-messages.send` is the platform's paced bulk-send verb - so
// email.contract.json exists for this gate.
//
// What is checked, all of it derivable from the dumps:
//   1. a step-eligible route is a public /api ACTION (the flag is a no-op
//      anywhere else, and an internal route cannot be a plan step's target verb);
//   2. it has its internal twin in the SAME dump, marked #[InternalMethod] -
//      without it the run dies per item on the hop. The hop is flat
//      `internal/{group}/{verb}`, spelled like the vocabulary name, which the
//      public REST path is NOT once it carries a sid or drops the verb: so the
//      spelling comes from the dumped `step_tool` and falls back to the path
//      only for the flat verbs where the two coincide;
//   3. the step-tool name is unique across services, since a plan names one
//      string and exactly one verb may answer to it.
//
// NOT checked here, deliberately, because no dump carries it: that the executor
// actually has an arm for the verb. That half is pinned in the backend, twice -
// `MassActionStepToolEnum` in gtm.lib.common (one case per arm) and the per-service
// architecture tests (tests/Unit/Architecture/StepEligibilityTest) that compare
// each service's declarations against it. Asserting it here would mean shipping a
// hand-written copy of the vocabulary into this repo, which is the mirror the
// whole oracle setup exists to remove.
//
// Cheap and offline: committed JSON only, no registry import, no backend calls.

type OracleRoute = {
  method: string;
  uri: string;
  controller: string;
  action: string;
  operation: string | null;
  mass_action: boolean;
  step_eligible: boolean;
  step_tool: string | null;
  schedule_required: boolean;
  internal: boolean;
};
type Contract = { service: string; entities: Record<string, unknown>; routes: OracleRoute[] };

const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/contract-oracle/', import.meta.url));

const contracts: Contract[] = readdirSync(FIXTURE_DIR)
  .filter((file) => file.endsWith('.contract.json'))
  .sort()
  .map((file) => JSON.parse(readFileSync(FIXTURE_DIR + file, 'utf8')) as Contract);

const routeKey = (route: OracleRoute) => `${route.method} ${route.uri}`;
/**
 * The plan step's `tool`. Declared (`stepTool:`) wherever the public path is not
 * already the spelling - which is every sid-scoped or create-shaped verb, since
 * the hop is flat `{group}/{verb}` and REST is not. The path fallback covers the
 * flat verbs, e.g. 'api/email-messages/send' -> 'email-messages.send'.
 */
const stepToolName = (route: OracleRoute) =>
  route.step_tool ?? route.uri.slice('api/'.length).replace(/\//g, '.');

describe('cross-service step-eligibility', () => {
  it('reads every committed contract fixture', () => {
    // A dropped fixture would silently stop checking a whole service, and the
    // empty check would still read green.
    expect(contracts.length).toBeGreaterThanOrEqual(4);
    expect(contracts.map((contract) => contract.service).sort()).toEqual(
      ['email', 'id', 'linkedin', 'orchestration'],
    );
    for (const contract of contracts) {
      expect(contract.routes.every((route) => typeof route.step_eligible === 'boolean'), `${contract.service}.contract.json predates the step_eligible field - run \`pnpm oracle:refresh\``).toBe(true);
    }
  });

  const declared = contracts.flatMap((contract) =>
    contract.routes
      .filter((route) => route.step_eligible)
      .map((route) => ({ service: contract.service, route })),
  );

  it('the platform declares at least one step-eligible verb', () => {
    // Guard the guard: every assertion below is vacuous on an empty set.
    /* eslint-disable-next-line no-console */
    console.log(
      `step-eligible verbs: ${declared.map(({ service, route }) => `${service}: ${routeKey(route)}`).join(', ') || 'NONE'}`,
    );
    expect(declared.length).toBeGreaterThan(0);
  });

  it('every step-eligible verb is a public /api action', () => {
    const violations = declared
      .filter(({ route }) => !route.uri.startsWith('api/') || route.internal || route.operation !== 'action')
      .map(({ service, route }) => `${service}: ${routeKey(route)} is operation '${route.operation}', internal=${route.internal}`);

    expect(
      violations,
      'stepEligible is only meaningful on a public McpOperation::ACTION (§R4). Fix the declaration, then `pnpm oracle:refresh`.',
    ).toEqual([]);
  });

  it('every step-eligible verb exposes the internal hop the executor calls', () => {
    const violations: string[] = [];

    for (const { service, route } of declared) {
      const contract = contracts.find((candidate) => candidate.service === service)!;
      const twinKey = `${route.method} internal/${stepToolName(route).replace(/\./g, '/')}`;
      const twin = contract.routes.find((candidate) => routeKey(candidate) === twinKey);

      if (!twin) {
        violations.push(`${service}: ${routeKey(route)} declares stepEligible but ${service} serves no ${twinKey}`);
      } else if (!twin.internal) {
        violations.push(`${service}: ${twinKey} exists but carries no #[InternalMethod], so it is not the internal hop`);
      }
    }

    expect(
      violations,
      'A mass-action run reaches a step-eligible verb over its /internal hop. Without the hop every item of that run fails on the wire.',
    ).toEqual([]);
  });

  it('no two services claim the same step-tool name', () => {
    const owners = new Map<string, string[]>();
    for (const { service, route } of declared) {
      const tool = stepToolName(route);
      owners.set(tool, [...(owners.get(tool) ?? []), service]);
    }

    const collisions = [...owners]
      .filter(([, services]) => services.length > 1)
      .map(([tool, services]) => `${tool} is claimed by ${services.join(' and ')}`);

    expect(
      collisions,
      "A plan step names one `tool` string; two services answering to it means the engine's arm is ambiguous.",
    ).toEqual([]);
  });
});
