# Thin stdio launcher for the hosted gtm-api LinkedIn MCP server.
#
# The image runs no server logic. It is the npm launcher, npm/bin/cli.js (the
# file `npx @gtm-api/linkedin-mcp` runs), with its pinned mcp-remote: it
# bridges a stdio MCP client (Claude Desktop, Cursor, anything that spawns a
# command) to the remote streamable-http endpoint, and every tool executes on
# https://mcp.gtm-api.com/mcp.
#
# API key only. Pass the variable by name with -e and keep its value in the
# client's env block, so the key sits on no command line, docker's included:
#
#   docker run -i --rm -e GTM_API_KEY gtmapi/linkedin-mcp
#
# Without a key the entrypoint stops at once and says so, because OAuth cannot
# finish in a container. mcp-remote takes the consent redirect on
# http://localhost:<port>/oauth/callback with a listener bound to the
# container's own 127.0.0.1, so the browser on the host reaches it neither
# through a published port (-p 127.0.0.1:<port>:<port> gets a reset) nor
# through --network host on Docker Desktop, and no browser opens inside the
# container. Checked on 2026-11-03 against a local authorization server; a
# token cache volume at /home/node/.mcp-auth also came up root-owned and
# stopped the bridge on EACCES before the consent page. OAuth users connect to
# the URL directly or run the npm launcher.
#
# Until 1.3.2 the image ran an entrypoint script of its own, which drifted from
# the launcher: the build published on 2026-07-28 put the key itself on
# mcp-remote's command line. The guard below only checks that the variable is
# set; the launcher still reads the key from the environment.
FROM node:22-alpine
WORKDIR /opt/launcher
COPY npm/package.json npm/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY npm/bin ./bin
USER node
ENTRYPOINT ["/bin/sh", "-c", "[ -n \"$GTM_API_KEY\" ] || { printf '%s\\n' \
  'gtmapi/linkedin-mcp: GTM_API_KEY is not set, and this image signs in with an API key only.' \
  'Run it with -e GTM_API_KEY and put a gtm_live_ key (https://app.gtm-api.com, Settings, API keys) in the env block of your MCP client config.' \
  'OAuth cannot finish inside a container: point the client at https://mcp.gtm-api.com/mcp, or run npx -y @gtm-api/linkedin-mcp.' \
  >&2; exit 1; }; exec node /opt/launcher/bin/cli.js \"$@\"", "gtmapi/linkedin-mcp"]
