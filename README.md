# GTM API: LinkedIn MCP Server

[![Site](https://img.shields.io/badge/site-gtm--api.com-bef264)](https://gtm-api.com/linkedin-mcp-server/)
[![Protocol](https://img.shields.io/badge/protocol-MCP-blue)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/badge/license-MIT-lightgrey)](./LICENSE)

GTM API is a managed LinkedIn MCP server. It gives an AI agent one key and 160+ typed LinkedIn tools over the [Model Context Protocol](https://modelcontextprotocol.io/), so Claude, ChatGPT or Cursor can search, connect, message and enrich on a LinkedIn account you own, with account safety enforced server side.

This repository holds the public interface: what the server exposes, how to connect a client, and how the safety layer works.

## What is a LinkedIn MCP server?

A LinkedIn MCP server exposes LinkedIn actions as Model Context Protocol tools, so an AI agent calls them directly, the way a person would click through the UI. LinkedIn publishes no official API for invitations, member messages or open profile search, so a LinkedIn MCP server works through an account you own rather than through LinkedIn's developer platform.

Two shapes exist today. **Cookie-driven open-source servers** run a browser session with your own cookie and no pacing. **Managed servers** run each account in isolated infrastructure with limits enforced before every action. GTM API is the second kind.

## Which clients it works with

Any MCP-compatible client:

- **Claude** (Desktop, Code, and the API)
- **Cursor**
- **ChatGPT** (via connectors)
- **LangChain**, **n8n**, and custom agent runtimes

Not using MCP? Every tool is also a typed REST endpoint with webhooks. One schema generates all three surfaces.

## Quickstart

**1. Get an API key.** Sign up at [app.gtm-api.com](https://app.gtm-api.com/login) (7-day trial, no card) and connect a LinkedIn account. It opens in a dedicated anti-detect cloud browser with its own proxy.

**2. Add the server to your MCP client.** For Claude Desktop, edit `claude_desktop_config.json` (example in [`examples/`](./examples/claude_desktop_config.json)):

```json
{
  "mcpServers": {
    "gtm-api": {
      "url": "{{MCP_URL}}",
      "headers": { "Authorization": "Bearer YOUR_API_KEY" }
    }
  }
}
```

**3. Restart the client and prompt in plain English:**

> "Every morning, accept new connection invitations from founders, reply with a short welcome, and add anyone hiring SDRs to a warm list."

The agent discovers the tools and chains them: `get_my_latest_linkedin_connection_invitations` then `accept_linkedin_connection_invitation` then `send_linkedin_message`. Every outward action runs a preview-then-confirm step and a server-side daily-limit check before it reaches LinkedIn.

## What the agent can do

160+ typed tools across 10 LinkedIn toolsets:

| Toolset | Representative tools |
|---|---|
| **Messaging** | `send_linkedin_message`, `send_linkedin_voice_message`, `send_linkedin_inmail`, `send_linkedin_sales_nav_message`, inbox search and sync |
| **Network** | `send_linkedin_connection_request`, `accept_linkedin_connection_invitation`, withdraw and ignore, connections and followers |
| **Content** | track posts and metrics, comment, react, get engagers and commenters |
| **Enrichment** | lite and full profile, experience, skills, education, company data |
| **Search** | people, company and post search, similar profiles, employees, decision-makers, saved searches |
| **Account health** | smart limits, health snapshots, quota-hit, block and activity logs |
| **Infrastructure** | anti-detect cloud browsers, dedicated proxies, webhooks |

LinkedIn is the live channel today. Email (Gmail, Outlook, IMAP), messengers (WhatsApp, Telegram, Instagram DMs) and calendars (Google, Microsoft) are on the roadmap on the same typed contract.

## Is it safe for my LinkedIn account?

Safety is enforced by the server itself, under every tool call. Six mechanisms:

- **Owned accounts.** The agent acts through an account you connected and control, never a shared pool.
- **Session isolation.** Each account runs in its own anti-detect cloud browser with a dedicated proxy. One account, one session, one device signature.
- **Warm-up.** A new account starts at a fraction of platform maximum, and its allowance is raised programmatically as the account ages and builds history.
- **Server-side limits.** Per-action daily budgets are checked before dispatch, across 16 action buckets.
- **Randomized pacing.** Bulk work is spread with per-gap randomized intervals, because a fixed cadence is itself a detectable pattern.
- **Preview then confirm.** Outward actions return a preview and require confirmation, so an over-eager agent cannot burn an account.

On this setup GTM API reports 20,000+ LinkedIn accounts running at under 1% monthly ban. Full method: [gtm-api.com/safe-linkedin-automation](https://gtm-api.com/safe-linkedin-automation/).

## How it compares to open-source LinkedIn MCP servers

Open-source servers such as [`stickerdaniel/linkedin-mcp-server`](https://github.com/stickerdaniel/linkedin-mcp-server) or [Apify](https://apify.com/)'s LinkedIn actors drive a browser with your cookie and leave pacing to you. That works for a prototype and gets expensive at volume.

| | GTM API (managed) | Cookie-driven open source |
|---|---|---|
| Account model | Owned, warmed, isolated | Your live cookie session |
| Safety layer | Anti-detect browser, dedicated proxy, limits | None |
| Limit enforcement | Server side, before every action | You build it |
| Sends (connect, message, InMail) | Yes, with preview then confirm | Partial or none |
| Published ban rate | Self-reported: under 1% monthly across 20,000+ accounts | Not published |
| Support | Managed | Community |

## Pricing

From $19 per connected account per month, scaling to $5 at volume, with unlimited API calls and no per-action fees. 7-day trial, no card. Enrichment and Signals are optional metered add-ons: [gtm-api.com/pricing](https://gtm-api.com/pricing/).

## A note on LinkedIn's terms

LinkedIn's User Agreement does not permit third-party automation, so every tool in this space carries risk and no vendor can honestly promise otherwise. GTM API reduces that risk by acting only on accounts you own, with warm-up, human-like pacing and enforced limits, which is why the reported ban rate is under 1% rather than zero. This is information, not legal advice.

## Links

- Get an API key: [app.gtm-api.com](https://app.gtm-api.com/login)
- How a LinkedIn MCP server works: [gtm-api.com/linkedin-mcp-server](https://gtm-api.com/linkedin-mcp-server/)
- The safety method in detail: [gtm-api.com/safe-linkedin-automation](https://gtm-api.com/safe-linkedin-automation/)
- Model Context Protocol: [modelcontextprotocol.io](https://modelcontextprotocol.io/)

---

[gtm-api.com](https://gtm-api.com/), the LinkedIn API and MCP server for AI agents.
