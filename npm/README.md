# @gtm-api/linkedin-mcp

Launcher for [gtm-api: LinkedIn MCP Server](https://github.com/gtm-api/linkedin-mcp), the managed LinkedIn MCP server for AI agents. It bridges a stdio MCP client (Claude Desktop, Cursor, anything that spawns a command) to the hosted streamable-http endpoint at `https://mcp.gtm-api.com/mcp` via [mcp-remote](https://www.npmjs.com/package/mcp-remote). No server logic runs locally; every tool executes on the hosted server, where account safety is enforced: warm-up, server-side daily limits, preview-then-confirm on outward actions. gtm-api reports 20,000+ LinkedIn accounts running at under 1% monthly ban; the method is written up at [gtm-api.com/safe-linkedin-automation](https://gtm-api.com/safe-linkedin-automation/).

The server exposes three MCP tools (`list_toolsets`, `get_toolset_tools`, `call_tool`) that give an agent progressive access to 160+ typed LinkedIn actions: messaging, connection requests, content, enrichment, search, account health and infrastructure.

## Setup

Add the server to your MCP client. There is no key to paste: on first run a browser opens, you sign in and approve access, and the tokens are cached under `~/.mcp-auth`.

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "gtm-api": {
      "command": "npx",
      "args": ["-y", "@gtm-api/linkedin-mcp"]
    }
  }
}
```

Claude Code:

```
claude mcp add gtm-api -- npx -y @gtm-api/linkedin-mcp
```

Sign up at [app.gtm-api.com](https://app.gtm-api.com/login) (forever free plan, no card) and connect a LinkedIn account you own, either before or during the consent step.

If your client speaks streamable-http itself, skip this launcher and point it straight at `https://mcp.gtm-api.com/mcp`. It will run the same OAuth flow. The launcher is for clients that can only spawn a command.

## Authentication

The hosted endpoint takes OAuth tokens only. Your client discovers the flow on its own: the first call returns a `WWW-Authenticate` challenge naming the server's metadata document, mcp-remote registers itself with the authorization server (dynamic client registration, so nothing has to be pre-registered with us) and opens the consent page.

A gtm-api API key (`gtm_live_...`) authenticates the [REST API](https://docs.gtm-api.com/api-reference/overview), not this server. Sending one here answers `401 invalid_token`. Versions up to 1.1.0 required `GTM_API_KEY` and sent it as a bearer, which could not work; if your config still sets it, the variable is now ignored and you can drop it.

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `GTM_MCP_URL` | no | Endpoint override, defaults to `https://mcp.gtm-api.com/mcp` |

Extra CLI arguments pass through to `mcp-remote`, so its flags are available: `--debug` to write detailed logs to `~/.mcp-auth`, `--host` to change the callback hostname, `--allow-http` for a plain-http endpoint override.

## Links

- What the server does, tool list, safety model: [github.com/gtm-api/linkedin-mcp](https://github.com/gtm-api/linkedin-mcp)
- Connecting any client, step by step: [docs.gtm-api.com/mcp/connect](https://docs.gtm-api.com/mcp/connect)
- How a LinkedIn MCP server works: [gtm-api.com/linkedin-mcp-server](https://gtm-api.com/linkedin-mcp-server/)
- Docker variant of this launcher: [hub.docker.com/r/gtmapi/linkedin-mcp](https://hub.docker.com/r/gtmapi/linkedin-mcp)
