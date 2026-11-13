import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { buildRegistry } from './registry';
import type { ToolDefinition, ToolPackage } from './types';

function tool(over: Partial<ToolDefinition>): ToolDefinition {
  return {
    name: 'search_things', description: 'd', service: 'linkedin', entity: 'e', mount: 'm',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/things/search' },
    operation: 'search', envelope: 'search', availability: 'ga',
    dangerous: false,    inputSchema: z.object({ _meta: z.any().optional() }), outputSchema: z.any(),
    annotations: { title: 't', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    ...over,
  };
}

function pkg(tools: ToolDefinition[]): ToolPackage {
  return { id: 'mcp.linkedin/e', service: 'linkedin', entity: 'e', tools };
}

function actionTool(over: Partial<ToolDefinition> = {}): ToolDefinition {
  return tool({
    name: 'send_thing', operation: 'action', envelope: 'action',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/things/{sid}/send' },
    annotations: { title: 't', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    ...over,
  });
}

describe('buildRegistry invariants', () => {
  it('accepts a valid package', () => {
    const r = buildRegistry([pkg([tool({})])]);
    expect(r.byName.has('search_things')).toBe(true);
  });

  it('rejects duplicate tool names', () => {
    expect(() => buildRegistry([pkg([tool({}), tool({})])])).toThrow(/duplicate/i);
  });

  it('rejects a read-only op without readOnlyHint', () => {
    expect(() => buildRegistry([pkg([tool({ annotations: { title: 't', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } })])])).toThrow(/readOnlyHint/);
  });

  it('rejects a dangerous tool without destructiveHint', () => {
    expect(() => buildRegistry([pkg([tool({
      name: 'delete_thing', operation: 'delete', envelope: 'delete_simple', dangerous: true,
      route: { service: 'linkedin', method: 'DELETE', pathTemplate: '/api/things/{sid}' },
      annotations: { title: 't', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    })])])).toThrow(/destructiveHint/);
  });

  it('rejects an unbound path param', () => {
    expect(() => buildRegistry([pkg([tool({
      name: 'get_thing_child', operation: 'get', envelope: 'get',
      route: { service: 'linkedin', method: 'GET', pathTemplate: '/api/things/{sid}/{childId}' },
    })])])).toThrow(/unbound path param/i);
  });

  it('rejects an input schema missing _meta', () => {
    expect(() => buildRegistry([pkg([tool({ inputSchema: z.object({ q: z.string() }) })])])).toThrow(/_meta/);
  });

  it('accepts a schedule-paced bulk action', () => {
    const r = buildRegistry([pkg([actionTool({ massAction: true, scheduleRequired: true })])]);
    expect(r.byName.get('send_thing')?.tool.massAction).toBe(true);
  });

  it('rejects massAction on a non-action op', () => {
    expect(() => buildRegistry([pkg([tool({ massAction: true })])])).toThrow(/massAction requires operation/);
  });

  it('rejects a read-only tool declaring massAction', () => {
    expect(() => buildRegistry([pkg([actionTool({
      massAction: true,
      annotations: { title: 't', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    })])])).toThrow(/read-only tool cannot be massAction/);
  });

  // stepEligible is the other half of the §R4 pair, and it is independent:
  // linkedin-connection-requests.send is a strictly single-target public verb
  // that orchestration still runs as a plan step, so it carries stepEligible
  // WITHOUT massAction.
  it('accepts a step-eligible verb that is not a mass-action', () => {
    const r = buildRegistry([pkg([actionTool({ stepEligible: true })])]);
    expect(r.byName.get('send_thing')?.tool.stepEligible).toBe(true);
    expect(r.byName.get('send_thing')?.tool.massAction).toBeUndefined();
  });

  it('rejects stepEligible on a non-action op', () => {
    expect(() => buildRegistry([pkg([tool({ stepEligible: true })])])).toThrow(/stepEligible requires operation/);
  });

  it('rejects a read-only tool declaring stepEligible', () => {
    expect(() => buildRegistry([pkg([actionTool({
      stepEligible: true,
      annotations: { title: 't', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    })])])).toThrow(/read-only tool cannot be stepEligible/);
  });

  it('rejects scheduleRequired on a verb that is neither bulk fact', () => {
    expect(() => buildRegistry([pkg([actionTool({ scheduleRequired: true })])]))
      .toThrow(/scheduleRequired implies massAction or stepEligible/);
  });

  // email-messages.send is the live case: paced, step-eligible, massAction false.
  it('accepts scheduleRequired carried by stepEligible alone', () => {
    const r = buildRegistry([pkg([actionTool({ stepEligible: true, scheduleRequired: true })])]);
    expect(r.byName.get('send_thing')?.tool.scheduleRequired).toBe(true);
  });
});

// CLAUDE.md bans the em/en dash in published text. Every string below is built
// from an escape so this test file itself stays dash-free in source.
const EM = '\u2014';
const EN = '\u2013';

describe('buildRegistry dash ban', () => {
  it('rejects an em dash in the tool description', () => {
    expect(() => buildRegistry([pkg([tool({ description: `Search things ${EM} the fast way.` })])]))
      .toThrow(/em\/en dash/);
  });

  it('rejects an en dash in the tool description', () => {
    expect(() => buildRegistry([pkg([tool({ description: `Search things ${EN} fast.` })])]))
      .toThrow(/em\/en dash/);
  });

  it('rejects an em dash in annotations.title', () => {
    expect(() => buildRegistry([pkg([tool({
      annotations: { title: `Search ${EM} things`, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    })])])).toThrow(/annotations\.title contains an em\/en dash/);
  });

  it('rejects an em dash in a field-level .describe()', () => {
    expect(() => buildRegistry([pkg([tool({
      inputSchema: z.object({
        q: z.string().describe(`Full-text query ${EM} matched against name and headline.`),
        _meta: z.any().optional(),
      }),
    })])])).toThrow(/field description contains an em\/en dash/);
  });

  // The walk has to reach through the optional/array/object wrappers a real
  // filter schema is built from, not just the top-level shape.
  it('rejects an em dash nested inside an optional array of objects', () => {
    expect(() => buildRegistry([pkg([tool({
      inputSchema: z.object({
        filter: z.object({
          targets: z.array(z.object({ sid: z.string().describe(`Target sid ${EN} one per row.`) })).optional(),
        }).optional(),
        _meta: z.any().optional(),
      }),
    })])])).toThrow(/field description contains an em\/en dash/);
  });

  it('rejects an em dash in an output-schema field description', () => {
    expect(() => buildRegistry([pkg([tool({
      outputSchema: z.object({ total: z.number().describe(`Row count ${EM} before paging.`) }),
    })])])).toThrow(/field description contains an em\/en dash/);
  });

  it('accepts a plain hyphen, a colon and parentheses', () => {
    const r = buildRegistry([pkg([tool({
      description: 'Search things: read-only, cursor-paged (see filter.q).',
      inputSchema: z.object({ q: z.string().describe('Full-text query - name and headline.'), _meta: z.any().optional() }),
    })])]);
    expect(r.byName.has('search_things')).toBe(true);
  });

  // route.headerParams: an input that travels as a request header (2026-11-13,
  // the Email-Box-SID of gtm.service.email).
  describe('headerParams', () => {
    const withHeader = (headerParams: Record<string, string>, shape: z.ZodRawShape = { email_box_sid: z.string().optional() }) =>
      tool({
        route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/things/search', headerParams },
        inputSchema: z.object({ ...shape, _meta: z.any().optional() }),
      });

    it('accepts a header bound to an input the tool declares', () => {
      expect(() => buildRegistry([pkg([withHeader({ 'Email-Box-SID': 'email_box_sid' })])])).not.toThrow();
    });

    it('rejects a binding to an input the schema does not declare', () => {
      expect(() => buildRegistry([pkg([withHeader({ 'Email-Box-SID': 'email_box_sid' }, {})])])).toThrow(/does not declare/);
    });

    it('rejects a header the runtime sets itself, in any case', () => {
      for (const header of ['Authorization', 'team-sid', 'X-Trace-Id', 'Content-Type']) {
        expect(() => buildRegistry([pkg([withHeader({ [header]: 'email_box_sid' })])]), header).toThrow(/sets itself/);
      }
    });

    it('rejects a name that is not a header name', () => {
      expect(() => buildRegistry([pkg([withHeader({ 'Email Box: SID': 'email_box_sid' })])])).toThrow(/not a header name/);
    });

    it('rejects a key that already travels in the path, as _meta or as the commit token', () => {
      expect(() => buildRegistry([pkg([tool({
        name: 'get_thing', operation: 'get', envelope: 'get',
        route: { service: 'linkedin', method: 'GET', pathTemplate: '/api/things/{sid}', headerParams: { 'X-Thing': 'sid' } },
        inputSchema: z.object({ sid: z.string(), _meta: z.any().optional() }),
      })])])).toThrow(/already travels elsewhere/);
      expect(() => buildRegistry([pkg([withHeader({ 'X-Meta': '_meta' })])])).toThrow(/already travels elsewhere/);
    });

    it('holds a previewRoute to the same rules', () => {
      expect(() => buildRegistry([pkg([actionTool({
        dangerous: true,
        annotations: { title: 't', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        previewRoute: { service: 'linkedin', method: 'POST', pathTemplate: '/api/things/{sid}/preview-send', headerParams: { Authorization: 'sid' } },
        inputSchema: z.object({ sid: z.string(), _meta: z.any().optional() }),
      })])])).toThrow(/previewRoute\.headerParams/);
    });
  });

  // restOnlyInputs: a field of the REST route the tool does not offer (a password).
  describe('restOnlyInputs', () => {
    const withSecret = (restOnlyInputs: string[], shape: z.ZodRawShape) =>
      actionTool({ restOnlyInputs, inputSchema: z.object({ sid: z.string(), ...shape, _meta: z.any().optional() }) });

    it('accepts an optional field the schema declares', () => {
      expect(() => buildRegistry([pkg([withSecret(['imap_password'], { imap_password: z.string().optional() })])])).not.toThrow();
    });

    it('rejects a field the schema does not declare', () => {
      expect(() => buildRegistry([pkg([withSecret(['imap_password'], {})])])).toThrow(/does not declare/);
    });

    it('rejects a required field: a tool that cannot be called without its secret is surface api', () => {
      expect(() => buildRegistry([pkg([withSecret(['imap_password'], { imap_password: z.string() })])])).toThrow(/surface api/);
    });
  });
});
