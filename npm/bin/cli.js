#!/usr/bin/env node
'use strict';

// Thin stdio launcher for the hosted GTM API LinkedIn MCP server.
//
// No server logic lives here. The bin bridges a stdio MCP client (Claude
// Desktop, Cursor, anything that spawns a command) to the remote
// streamable-http endpoint via the bundled mcp-remote; every tool executes on
// https://mcp.gtm-api.com/mcp. Mirrors docker/entrypoint.sh in the repo root.

const { spawn } = require('node:child_process');

const url = process.env.GTM_MCP_URL || 'https://mcp.gtm-api.com/mcp';
const key = process.env.GTM_API_KEY;

if (!key) {
  console.error('GTM_API_KEY is not set.');
  console.error('Get an API key at https://app.gtm-api.com/login (7-day trial), then put');
  console.error('GTM_API_KEY in the "env" block of this server in your MCP client config.');
  process.exit(1);
}

let proxy;
try {
  proxy = require.resolve('mcp-remote/dist/proxy.js');
} catch (err) {
  console.error('Cannot resolve the bundled mcp-remote bridge: ' + err.message);
  process.exit(1);
}

const args = [
  proxy,
  url,
  '--header',
  'Authorization: Bearer ' + key,
  '--transport',
  'http-only',
  ...process.argv.slice(2),
];

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
