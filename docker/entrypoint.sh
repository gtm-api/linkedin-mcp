#!/bin/sh
# Bridge a stdio MCP client to the hosted GTM API endpoint via mcp-remote.
# Requires GTM_API_KEY. Extra arguments pass through to mcp-remote.
if [ -z "${GTM_API_KEY}" ]; then
  echo "GTM_API_KEY is not set." >&2
  echo "Get an API key at https://app.gtm-api.com/login (7-day trial), then run:" >&2
  echo "  docker run -i --rm -e GTM_API_KEY=your_key gtmapi/linkedin-mcp" >&2
  exit 1
fi
exec mcp-remote "${GTM_MCP_URL}" \
  --header "Authorization: Bearer ${GTM_API_KEY}" \
  --transport http-only \
  "$@"
