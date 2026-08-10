# gtm-api LinkedIn MCP Server

Managed LinkedIn MCP server for AI agents, running as an Apify Actor. It bridges MCP clients to the hosted streamable-http endpoint at `https://mcp.gtm-api.com/mcp`; no server logic runs inside the Actor. Every tool executes on the hosted server, where account safety is enforced: warm-up ramps for fresh accounts, server-side daily limits, preview-then-confirm on outward actions. gtm-api reports 20,000+ LinkedIn accounts running at under 1% monthly ban; the method is written up at [gtm-api.com/safe-linkedin-automation](https://gtm-api.com/safe-linkedin-automation/).

The server exposes three MCP tools (`list_toolsets`, `get_toolset_tools`, `call_tool`) that give an agent progressive access to 160+ typed LinkedIn actions: messaging, connection requests, content, enrichment, search, account health and infrastructure.

## Setup

1. Get an API key at [app.gtm-api.com](https://app.gtm-api.com/login) (7-day trial, no card) and connect a LinkedIn account you own.
2. Start this Actor in **Standby** mode with `gtmApiKey` set in the input, or pass the key per request instead (an `x-gtm-api-key` header, or `?gtm_api_key=...` in the URL).
3. Point your MCP client at the Actor's Standby URL, path `/mcp`, with your Apify token:

```json
{
    "mcpServers": {
        "gtm-api": {
            "url": "https://USERNAME--linkedin-mcp.apify.actor/mcp?token=YOUR_APIFY_TOKEN"
        }
    }
}
```

A normal (non-Standby) run performs a connectivity self-check against the hosted endpoint, writes the result to the dataset, and exits.

## Input

| Field | Required | Meaning |
|---|---|---|
| `gtmApiKey` | no, if passed per request | API key from [app.gtm-api.com](https://app.gtm-api.com/login), sent upstream as an Authorization bearer |
| `upstreamUrl` | no | Endpoint override, defaults to `https://mcp.gtm-api.com/mcp` |

## Prefer a direct connection?

Clients that speak streamable-http do not need this Actor: point them straight at `https://mcp.gtm-api.com/mcp` with an `Authorization: Bearer YOUR_API_KEY` header. Stdio clients can use the npm launcher [`@gtm-api/linkedin-mcp`](https://www.npmjs.com/package/@gtm-api/linkedin-mcp) or the Docker image [`gtmapi/linkedin-mcp`](https://hub.docker.com/r/gtmapi/linkedin-mcp). This Actor exists for teams that keep their agent stack on Apify.

## Links

- What the server does, tool list, safety model: [github.com/gtm-api/linkedin-mcp](https://github.com/gtm-api/linkedin-mcp)
- How a LinkedIn MCP server works: [gtm-api.com/linkedin-mcp-server](https://gtm-api.com/linkedin-mcp-server/)
- API docs: [docs.gtm-api.com](https://docs.gtm-api.com)
