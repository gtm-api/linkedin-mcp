# @gtm-api/linkedin-mcp

Launcher for [GTM API: LinkedIn MCP Server](https://github.com/gtm-api/linkedin-mcp), the managed LinkedIn MCP server for AI agents. It bridges a stdio MCP client (Claude Desktop, Cursor, anything that spawns a command) to the hosted streamable-http endpoint at `https://mcp.gtm-api.com/mcp` via [mcp-remote](https://www.npmjs.com/package/mcp-remote). No server logic runs locally; every tool executes on the hosted server, where account safety is enforced: warm-up, server-side daily limits, preview-then-confirm on outward actions. GTM API reports 20,000+ LinkedIn accounts running at under 1% monthly ban; the method is written up at [gtm-api.com/safe-linkedin-automation](https://gtm-api.com/safe-linkedin-automation/).

The server exposes three MCP tools (`list_toolsets`, `get_toolset_tools`, `call_tool`) that give an agent progressive access to 160+ typed LinkedIn actions: messaging, connection requests, content, enrichment, search, account health and infrastructure.

## Setup

1. Get an API key at [app.gtm-api.com](https://app.gtm-api.com/login) (7-day trial, no card) and connect a LinkedIn account you own.
2. Add the server to your MCP client. Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "gtm-api": {
      "command": "npx",
      "args": ["-y", "@gtm-api/linkedin-mcp"],
      "env": { "GTM_API_KEY": "YOUR_API_KEY" }
    }
  }
}
```

Claude Code:

```
claude mcp add gtm-api -e GTM_API_KEY=YOUR_API_KEY -- npx -y @gtm-api/linkedin-mcp
```

Clients that speak streamable-http directly do not need this launcher; point them at `https://mcp.gtm-api.com/mcp` with an `Authorization: Bearer YOUR_API_KEY` header instead.

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `GTM_API_KEY` | yes | API key from [app.gtm-api.com](https://app.gtm-api.com/login) |
| `GTM_MCP_URL` | no | Endpoint override, defaults to `https://mcp.gtm-api.com/mcp` |

Extra CLI arguments pass through to `mcp-remote`.

## Links

- What the server does, tool list, safety model: [github.com/gtm-api/linkedin-mcp](https://github.com/gtm-api/linkedin-mcp)
- How a LinkedIn MCP server works: [gtm-api.com/linkedin-mcp-server](https://gtm-api.com/linkedin-mcp-server/)
- Docker variant of this launcher: [hub.docker.com/r/gtmapi/linkedin-mcp](https://hub.docker.com/r/gtmapi/linkedin-mcp)
