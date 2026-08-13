#!/usr/bin/env node
'use strict';

// Thin stdio launcher for the hosted gtm-api LinkedIn MCP server.
//
// No server logic lives here. The bin bridges a stdio MCP client (Claude
// Desktop, Cursor, anything that spawns a command) to the remote
// streamable-http endpoint via the bundled mcp-remote; every tool executes on
// https://mcp.gtm-api.com/mcp. Mirrors docker/entrypoint.sh in the repo root.
//
// Auth is OAuth, run by mcp-remote: the first request comes back 401 with a
// WWW-Authenticate pointing at the protected-resource document, mcp-remote
// registers itself with the authorization server (dynamic client registration),
// opens the consent page in a browser and caches the tokens under ~/.mcp-auth.
// Nothing to paste, nothing to store in the client config.
//
// This launcher used to force `--header "Authorization: Bearer $GTM_API_KEY"`,
// which could never work and hid the fix. Two reasons, either one fatal:
// the edge takes JWTs only and answers 401 invalid_token to a `gtm_live_…`
// opaque key (that key authenticates the REST API, not this server); and
// mcp-remote merges --header values AFTER the OAuth token it holds, so the
// static header would also overwrite a freshly minted access token on every
// request and the OAuth fallback could never recover.

const { spawn } = require('node:child_process');

const url = process.env.GTM_MCP_URL || 'https://mcp.gtm-api.com/mcp';

// Configs written against the old README still carry this. Say once that it is
// not used, so the setup that used to 401 does not now look like it is being
// silently ignored, then carry on into the OAuth flow.
if (process.env.GTM_API_KEY) {
  console.error('Note: GTM_API_KEY is set but not used. This server authenticates with OAuth;');
  console.error('a browser window opens on first run. The key still works for the REST API.');
}

let proxy;
try {
  proxy = require.resolve('mcp-remote/dist/proxy.js');
} catch (err) {
  console.error('Cannot resolve the bundled mcp-remote bridge: ' + err.message);
  process.exit(1);
}

const args = [proxy, url, '--transport', 'http-only', ...process.argv.slice(2)];

const child = spawn(process.execPath, args, { stdio: 'inherit' });

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => child.kill(sig));
}

child.on('error', (err) => {
  console.error('Failed to start mcp-remote: ' + err.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code === null ? 0 : code);
  }
});
