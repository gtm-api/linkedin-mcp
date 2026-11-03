# Thin stdio launcher for the hosted gtm-api LinkedIn MCP server.
#
# The image runs no server logic. It is the npm launcher, npm/bin/cli.js (the
# file `npx @gtm-api/linkedin-mcp` runs), with its pinned mcp-remote: it
# bridges a stdio MCP client (Claude Desktop, Cursor, anything that spawns a
# command) to the remote streamable-http endpoint, and every tool executes on
# https://mcp.gtm-api.com/mcp.
#
# Auth is the launcher's. OAuth by default: the token cache lives in
# /home/node/.mcp-auth, so mount a volume there to authorize once instead of on
# every run. Or an API key: pass the variable by name with -e and keep its value
# in the client's env block, so the key sits on no command line, docker's
# included.
#
#   docker run -i --rm -v gtm-mcp-auth:/home/node/.mcp-auth gtmapi/linkedin-mcp
#   docker run -i --rm -e GTM_API_KEY gtmapi/linkedin-mcp
#
# Until 1.3.2 the image ran an entrypoint script of its own, which drifted from
# the launcher: the build published on 2026-07-28 put the key itself on
# mcp-remote's command line.
FROM node:22-alpine
WORKDIR /opt/launcher
COPY npm/package.json npm/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY npm/bin ./bin
USER node
ENTRYPOINT ["node", "/opt/launcher/bin/cli.js"]
