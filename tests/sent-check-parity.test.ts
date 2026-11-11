import { describe, it, expect } from 'vitest';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import { linkedinPackages } from '@gtm/mcp-linkedin';
import { idPackages } from '@gtm/mcp-id';
import { orchestrationPackages } from '@gtm/mcp-orchestration';
import { supportPackages } from '@gtm/mcp-support';

// Sent-check gate (2026-11-11).
//
// A send that carries the caller's client_reference has a tool that answers what
// it came to without sending, and a send this worker's fuse cut is in doubt, not
// failed. The timeout answer hands the caller that call, filled with the send's
// own linkedin_account_sid and key (error-map.ts timeoutAdvice), and it can only
// name what the definition declares in `sentCheck`. So every keyed send declares
// one, and each is a call a caller can really make: a served tool that asks by the
// account and the key, with fixed arguments its own schema takes.

const tools: ToolDefinition[] = [...linkedinPackages, ...idPackages, ...orchestrationPackages, ...supportPackages].flatMap(
  (pkg) => pkg.tools,
);
const byName = new Map(tools.map((tool) => [tool.name, tool]));
const takes = (tool: ToolDefinition, key: string): boolean => key in (tool.inputSchema.shape ?? {});
const required = (tool: ToolDefinition, key: string): boolean =>
  takes(tool, key) && !(tool.inputSchema.shape[key] as { isOptional(): boolean }).isOptional();

// A send is an outward write (the preview gate's dangerous) that takes a key.
const keyedSends = tools.filter((tool) => tool.dangerous && takes(tool, 'client_reference'));
const declared = tools.filter((tool) => tool.sentCheck !== undefined);

describe('sentCheck', () => {
  it('is declared on every keyed send', () => {
    expect(keyedSends.length).toBeGreaterThan(0);
    expect(keyedSends.filter((tool) => tool.sentCheck === undefined).map((tool) => tool.name)).toEqual([]);
  });

  it('is declared on keyed sends only', () => {
    expect(declared.filter((tool) => !keyedSends.includes(tool)).map((tool) => tool.name)).toEqual([]);
  });

  it('names a served tool that asks by the account and the key, and sends nothing itself', () => {
    const wrong = declared.flatMap((send) => {
      const check = byName.get(send.sentCheck!.tool);
      if (!check) return [`${send.name}: ${send.sentCheck!.tool} is not in the registry`];
      const problems: string[] = [];
      if ((check.surface ?? 'both') !== 'both' || check.availability !== 'ga') problems.push('is not served');
      if (!required(check, 'linkedin_account_sid')) problems.push('does not take linkedin_account_sid');
      if (!takes(check, 'client_reference')) problems.push('does not take client_reference');
      if (check.dangerous || check.sentCheck) problems.push('is a send of its own');
      return problems.map((problem) => `${send.name}: ${check.name} ${problem}`);
    });

    expect(wrong).toEqual([]);
  });

  it('can be filled from the send: the send requires the account the check asks by', () => {
    expect(declared.filter((send) => !required(send, 'linkedin_account_sid')).map((send) => send.name)).toEqual([]);
  });

  it('carries fixed arguments the check tool accepts as they are filled in', () => {
    const refused = declared.flatMap((send) => {
      const check = byName.get(send.sentCheck!.tool)!;
      const call = { linkedin_account_sid: 'ln_ac_aaaaaaaaaaaa', client_reference: 'key-1', ...send.sentCheck!.args };
      const parsed = check.inputSchema.safeParse(call);
      return parsed.success ? [] : [`${send.name}: ${parsed.error.issues.map((issue) => issue.path.join('.') + ' ' + issue.message).join('; ')}`];
    });

    expect(refused).toEqual([]);
  });

  // check_linkedin_posting_sent asks "by the client_reference and its verb", and
  // the verb is the send's own route: comment, create-post, repost.
  it('asks the posting check by the verb of the send route', () => {
    const posting = declared.filter((send) => send.sentCheck!.tool === 'check_linkedin_posting_sent');

    expect(posting.length).toBeGreaterThan(0);
    expect(
      posting
        .filter((send) => send.sentCheck!.args?.verb !== send.route.pathTemplate.split('/').pop())
        .map((send) => `${send.name}: ${send.sentCheck!.args?.verb}`),
    ).toEqual([]);
  });
});
