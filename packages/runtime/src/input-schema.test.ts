import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { callableSchema, registeredShape, unknownKeyHint } from './input-schema';
import type { ToolDefinition } from './types';

// restOnlyInputs (2026-11-13): a field the REST route takes and the tool does
// not offer. Both entry points read the tool's contract from this module, so
// dropping the field here is what keeps a password out of tools/list and out of
// a facade call alike.

function tool(over: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'reconnect_thing', description: 'd', service: 'email', entity: 'e', mount: 'm',
    route: { service: 'email', method: 'POST', pathTemplate: '/api/things/{sid}/reconnect' },
    operation: 'action', envelope: 'action', availability: 'ga', dangerous: false,
    inputSchema: z.object({
      sid: z.string(),
      success_redirect_url: z.string().optional(),
      imap_password: z.string().optional(),
      smtp_password: z.string().optional(),
      _meta: z.any().optional(),
    }),
    outputSchema: z.any(),
    annotations: { title: 't', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    restOnlyInputs: ['imap_password', 'smtp_password'],
    ...over,
  };
}

describe('restOnlyInputs', () => {
  it('leaves the REST-only fields out of the shape a client is shown', () => {
    expect(Object.keys(registeredShape(tool())).sort()).toEqual(['_meta', 'sid', 'success_redirect_url']);
  });

  it('keeps every field of a tool that names none', () => {
    expect(Object.keys(registeredShape(tool({ restOnlyInputs: undefined })))).toContain('imap_password');
  });

  it('adds the commit token of a dangerous tool beside what is left', () => {
    const dangerous = tool({ dangerous: true, annotations: { title: 't', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } });
    expect(Object.keys(registeredShape(dangerous)).sort()).toEqual(['_meta', 'commit_token', 'sid', 'success_redirect_url']);
  });

  it('refuses a REST-only field a caller sends anyway, and says why', () => {
    const parsed = callableSchema(tool()).safeParse({ sid: 'x', imap_password: 'secret' });
    expect(parsed.success).toBe(false);
    expect(unknownKeyHint(tool(), [], 'imap_password')).toMatch(/a secret never passes through a model/);
  });

  it('still accepts the call without them', () => {
    expect(callableSchema(tool()).safeParse({ sid: 'x', success_redirect_url: 'https://a.test/' }).success).toBe(true);
  });
});
