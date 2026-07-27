# Connecting to the gtm.mcp server (local dev)

> Full local-dev & debugging runbook (Inspector, the dispatch log, the toolkit,
> daily workflow, modes) lives at the product level:
> [`../../LOCAL_DEVELOPMENT.md`](../../LOCAL_DEVELOPMENT.md) **§3**. This file is
> just the client-connection quick reference.

## 1. Bring up the server - one command

```bash
# from the gtm.mcp repo root
pnpm dev
```

`pnpm dev` runs `bin/mcp-dev.sh`, which:
1. checks the linkedin backend is up on `:8020` (start it with `./dev up` in `product/backend/gtm.service.linkedin`),
2. mints a fresh 24h dev bearer via `./dev artisan jwt:fake` (the seeded dev team `ts_tm_seeddev00001`),
3. starts `wrangler dev` on `http://localhost:8788` with that token injected as `DEV_BEARER`.

Because the token is injected server-side (dev only, gated by `AUTH_MODE=dev`), **the connector is a bare URL - no Authorization header needed locally.**

- Mount:  `http://localhost:8788/mcp/linkedin/accounts`
- Health: `http://localhost:8788/health`
- Override team: `TEAM_SID=ts_tm_... pnpm dev`

## 2. Claude Code

```bash
claude mcp add --transport http --scope user \
  gtm-linkedin http://localhost:8788/mcp/linkedin/accounts
claude mcp list        # → gtm-linkedin ... ✔ Connected
```

Then in any `claude` session the 17 account tools are available (e.g. "search my LinkedIn accounts").

## 3. Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gtm-linkedin": {
      "command": "npx",
      "args": ["mcp-remote", "http://localhost:8788/mcp/linkedin/accounts", "--allow-http"]
    }
  }
}
```

Restart Claude Desktop; the tools appear under the connector.

## 4. MCP Inspector (UI)

```bash
npx @modelcontextprotocol/inspector
```
Transport **Streamable HTTP** → URL `http://localhost:8788/mcp/linkedin/accounts` → Connect → List Tools.

## 5. curl (no client)

```bash
curl -sS -X POST http://localhost:8788/mcp/linkedin/accounts -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_linkedin_accounts","arguments":{"page_size":5}}}'
```

## Notes

- The dev header-less bypass is **dev-only** (`AUTH_MODE=dev` + `DEV_BEARER`). Deployed environments still return `401` + `WWW-Authenticate` and require real OAuth.
- A real OAuth connector (browser "Connect" flow, and claude.ai web support over a public URL) is Stage 4-5 of the plan (DCR + CORS + consent in the id service, `mcp.gtm-api.com` / cloudflared tunnel).
