---
identifier: gtm-api-linkedin
name: gtm-api-linkedin
version: 1.0.0
author: gtm-api
authorUrl: https://github.com/gtm-api
homepage: https://gtm-api.com/linkedin-mcp-server/
repository: https://github.com/gtm-api/linkedin-mcp
icon: https://gtm-api.com/wp-content/themes/gtm-api/assets/img/icon-hdr-512.png
license: MIT
tags:
  - linkedin
  - outreach
  - sales
  - automation
  - enrichment
  - mcp
description: Act on LinkedIn through an account you own, over MCP or REST, using gtm-api.com. Use when a task involves LinkedIn search, connection requests, messages and InMail, inbox reading, profile or company enrichment, post engagement, or checking what a LinkedIn account is still allowed to do today. Covers connecting the server, the three meta-tools and their discovery order, the preview-and-confirm gate on outward actions, and how to read a limit rejection instead of retrying it.
---

# LinkedIn through gtm-api.com

LinkedIn publishes no public API for invitations, member messages or open profile search. The
managed server at `mcp.gtm-api.com` exposes those actions as MCP tools running against a LinkedIn
account the user connected and controls, with pacing and limits enforced on the server before
anything reaches LinkedIn.

Read this before your first call. The two mistakes that cost the most are guessing tool names
instead of discovering them, and retrying an action the limit check just rejected.

## When this applies

Use it when the task names LinkedIn and needs an action taken or data pulled: find people or
companies, send or accept connection requests, send messages, read the inbox, enrich a profile,
react to or comment on posts, or report what an account is still allowed to do today.

Do not use it to operate an account the user does not own. There is no shared account pool, and
every action is attributed to the connected account.

## Connect

The endpoint is `https://mcp.gtm-api.com/mcp` over streamable HTTP. The user needs an account at
`app.gtm-api.com` with a LinkedIn account connected. There is a free plan and no card is required
to reach a working connection.

Two auth modes, and they must not be mixed.

**OAuth, for interactive clients.** Point the client at the URL with no credential. The first call
returns a `WWW-Authenticate` challenge, the client registers itself, and a consent page opens in
the user's browser.

```json
{
  "mcpServers": {
    "gtm-api": { "url": "https://mcp.gtm-api.com/mcp" }
  }
}
```

For Claude Code that is one line:

```bash
claude mcp add --transport http gtm-api https://mcp.gtm-api.com/mcp
```

**API key, for headless runs.** A key minted in the app (`gtm_live_...`) authenticates both the
REST API and this endpoint. Pass it as `Authorization: Bearer gtm_live_...`, or give the stdio
launcher `GTM_API_KEY` and skip the browser entirely:

```json
{
  "mcpServers": {
    "gtm-api": {
      "command": "npx",
      "args": ["-y", "@gtm-api/linkedin-mcp"],
      "env": { "GTM_API_KEY": "gtm_live_..." }
    }
  }
}
```

The launcher also ships as `gtmapi/linkedin-mcp` on Docker Hub. Mount a volume on the token cache
(`/home/node/.mcp-auth`) in OAuth mode, or the consent step repeats on every container start.

**The gotcha:** in OAuth mode, passing `--header Authorization` to the stdio bridge overwrites the
OAuth token and the connection fails in a way that looks like a server problem. Pick one mode. In
key mode the launcher still logs a line about discovering the OAuth server configuration; that is
harmless, because the header connects on the first try and the flow never starts.

A key is also the credential for the REST API, which mirrors every tool as a typed endpoint with
webhooks. Reference: `docs.gtm-api.com`.

## The three meta-tools

The server exposes three tools, not hundreds. Everything else is discovered at runtime, which is
why the schema footprint stays small enough to keep in context.

Call them in this order:

1. `list_toolsets` takes no arguments and returns the domains, for example `linkedin.messaging`.
2. `get_toolset_tools` takes `toolset`, and optionally `verbose: true`. The default is a lite
   listing of name, title and a one-line summary. Pass `verbose` when you need full descriptions,
   safety flags and parameter names, which you do before your first call to any tool.
3. `call_tool` takes `name` and `arguments` and runs the action. Arguments are validated against
   that action's own schema, so a typo comes back as a typed error rather than a silent no-op.

**Never guess a tool name.** The catalog changes as toolsets ship, and a guessed name is a failed
call at best. Discover, then invoke. If you need one action twice in a session, keep the name and
its parameter list from the `verbose` listing rather than re-reading it.

## Outward actions are gated

Anything that leaves the account (connection request, message, InMail, comment, reaction) is
marked dangerous and runs a two-step gate.

Call the action once with its normal arguments. Instead of sending, it returns a preview of what
would happen and a `commit_token`. Call it again with the same arguments plus `commit_token` to
commit. The token belongs to that one preview.

`commit_token` does not appear in the tool's own input schema. That is deliberate: the gate adds
it. Passing it on the first call is not how you skip the preview.

Show the preview to the user before committing anything that reaches another person. The gate
exists so an over-eager agent cannot burn an account, and committing without reading it gives that
protection away.

## Limits are an answer, not an error

Every outward action passes a server-side budget check before dispatch. Allowances depend on how
old the connected account is and how it has been behaving: a new account starts well under the
platform maximum and is raised as it builds history. Bulk work is spread with randomized gaps,
because a fixed cadence is itself a detectable pattern.

When the check rejects an action, that is the system working.

- Do not retry it. Do not loop. Do not split the same send across other tools to get under the
  cap.
- Report what was rejected and when the budget refreshes, and stop.
- Before planning bulk work, read the account's current allowance from the account health toolset
  and size the plan to it.

An agent that retries into a limit is the failure mode the whole safety layer exists to prevent.

## Errors

Failures come back as a typed envelope with a machine-readable code, not prose to parse. Branch on
the code.

- `401` with an OAuth challenge means no credential arrived. In key mode, the header is missing or
  malformed.
- `401 invalid_token` on a key means the key is wrong, revoked, or the account is suspended.
- A permission failure means the key was minted with a narrower scope than the action needs. Keys
  carry an explicit permission slice; the fix is a new key, not a retry.
- A validation failure names the field. Re-read the parameter list with
  `get_toolset_tools verbose: true` rather than guessing the shape.

Read the code, act on it once, and surface it. Retrying an auth or permission failure never
changes the answer.

## Safety and terms

LinkedIn's User Agreement does not permit third-party automation, so every tool in this space
carries risk and no vendor can honestly promise otherwise. The managed setup reduces it by acting
only on owned accounts, in an isolated anti-detect browser with a dedicated proxy per account,
with warm-up and enforced limits. On that stack, gtm-api.com reports 20,000+ accounts at under a
1% ban rate. That is a self-reported number, and this is not legal advice.

Tell the user what an action will do before it goes out. That is the whole job.

## More

- Worked flows, end to end: [recipes.md](references/recipes.md)
- API and MCP reference: `https://docs.gtm-api.com`
- Public repo: `https://github.com/gtm-api/linkedin-mcp`
- Sign up, free plan: `https://app.gtm-api.com/login`
