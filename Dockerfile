# Thin stdio launcher for the hosted GTM API LinkedIn MCP server.
#
# The image runs no server logic. It bridges a stdio MCP client (Claude
# Desktop, Cursor, anything that spawns a command) to the remote
# streamable-http endpoint with mcp-remote; every tool executes on
# https://mcp.gtm-api.com/mcp. Usage:
#
#   docker run -i --rm -e GTM_API_KEY=your_key gtmapi/linkedin-mcp
FROM node:22-alpine
RUN npm install -g mcp-remote@0.1.38 && npm cache clean --force
ENV GTM_MCP_URL=https://mcp.gtm-api.com/mcp
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
USER node
ENTRYPOINT ["entrypoint.sh"]
