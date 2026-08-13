#!/bin/sh
# Bridge a stdio MCP client to the hosted GTM API endpoint via mcp-remote.
# Auth is OAuth, run by mcp-remote: it registers itself with the authorization
# server and opens a consent page on first run. Extra arguments pass through.
#
# The container has no browser and cannot reach a callback on the host's
# localhost, so mount a volume at /home/node/.mcp-auth and complete the consent
# once by copying the printed URL into a browser; the cached tokens then persist
# across runs. Mirrors npm/bin/cli.js in the repo root.
if [ -n "${GTM_API_KEY}" ]; then
  echo "Note: GTM_API_KEY is set but not used. This server authenticates with OAuth." >&2
  echo "The key still works for the REST API." >&2
fi
exec mcp-remote "${GTM_MCP_URL}" \
  --transport http-only \
  "$@"
