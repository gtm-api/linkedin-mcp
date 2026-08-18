#!/usr/bin/env node
'use strict';

// Thin stdio launcher for the hosted gtm-api LinkedIn MCP server.
//
// No server logic lives here. The bin bridges a stdio MCP client (Claude
// Desktop, Cursor, anything that spawns a command) to the remote
// streamable-http endpoint via the bundled mcp-remote; every tool executes on
// https://mcp.gtm-api.com/mcp. Mirrors docker/entrypoint.sh in the repo root.
//
// Auth, two modes:
//
// - Default: OAuth, run by mcp-remote. The first request comes back 401 with a
//   WWW-Authenticate pointing at the protected-resource document, mcp-remote
//   registers itself with the authorization server (dynamic client
//   registration), opens the consent page in a browser and caches the tokens
//   under ~/.mcp-auth. Nothing to paste, nothing to store in the client config.
//
// - GTM_API_KEY set: the `gtm_live_…` key IS the credential, sent as the
//   bearer on every request; no browser, no consent, fits headless/CI. The key
//   is preflighted once so a bad key fails fast with a readable error instead
//   of tripping mcp-remote's OAuth fallback (whose freshly minted token the
//   static --header would then clobber on every request: a 401 loop).
//   Supported since the platform accepts api keys on the MCP endpoint
//   (2026-08-18); launchers 1.1.0 and older sent the key against an edge that
//   answered 401 invalid_token, and 1.2.x ignored the variable entirely.

const { spawn } = require('node:child_process');

const url = process.env.GTM_MCP_URL || 'https://mcp.gtm-api.com/mcp';
const apiKey = process.env.GTM_API_KEY;

async function preflightApiKey() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: '@gtm-api/linkedin-mcp', version: 'preflight' },
        },
      }),
    });
    if (response.status === 401) {
      console.error('GTM_API_KEY was rejected (401): the key is invalid, revoked or expired.');
      console.error('Mint or rotate a key in the app, or unset GTM_API_KEY to sign in with OAuth.');
      process.exit(1);
    }
    if (response.status === 402) {
      console.error('GTM_API_KEY was refused (402): the key is valid but its workspace subscription is suspended.');
      process.exit(1);
    }
  } catch (err) {
    // Network trouble is not a verdict on the key; let the bridge try.
    console.error('Warning: could not preflight GTM_API_KEY (' + err.message + '), continuing.');
  } finally {
    clearTimeout(timer);
  }
}

let proxy;
try {
  proxy = require.resolve('mcp-remote/dist/proxy.js');
} catch (err) {
  console.error('Cannot resolve the bundled mcp-remote bridge: ' + err.message);
  process.exit(1);
}

const args = [proxy, url, '--transport', 'http-only'];
if (apiKey) {
  args.push('--header', 'Authorization: Bearer ' + apiKey);
}
args.push(...process.argv.slice(2));

let child;

async function main() {
  if (apiKey) {
    await preflightApiKey();
  }
  child = spawn(process.execPath, args, { stdio: 'inherit' });
  wire(child);
}

function wire(child) {
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
}

main();
