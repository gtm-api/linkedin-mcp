'use strict';

// Key mode must not show the API key to anyone but the endpoint.
//
// The launcher hands mcp-remote the Authorization header as a command-line
// argument. Any local account can read another process's arguments with ps,
// and mcp-remote 0.1.38 logs every --header value to stderr before it expands
// the ${VAR} references in it; MCP clients (Claude Desktop, Cursor) keep that
// stderr in their log files, and people paste those into bug reports. So the
// argument carries a ${GTM_API_KEY} reference and the key stays in the
// environment the bridge inherits.
//
// This runs the real launcher and the bundled mcp-remote against a local stub
// of the endpoint with a fake key, then checks the bridge's line in ps, all of
// stderr and stdout, the --debug log, and the header that reached the stub.
// Each check first proves it looked at something, so a quiet mcp-remote or a
// missing process cannot pass it by accident.
//
// Needs ps, so it runs on Linux and macOS, not Windows.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const CLIENT_NAME = 'key-exposure-test';

// Stands in for https://mcp.gtm-api.com/mcp: answers initialize, accepts
// notifications, has no GET stream and no OAuth metadata, and records every
// request with its Authorization header.
function startStub() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let message = null;
      try {
        message = JSON.parse(body);
      } catch {
        // GET probes carry no body.
      }
      requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, message });

      if (req.method !== 'POST') {
        res.writeHead(req.url.startsWith('/.well-known/') ? 404 : 405).end();
      } else if (!message || message.id === undefined) {
        res.writeHead(202).end();
      } else {
        const result = message.method === 'initialize'
          ? { protocolVersion: message.params.protocolVersion, capabilities: {}, serverInfo: { name: 'stub', version: '0.0.0' } }
          : {};
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}/mcp` });
    });
  });
}

// -ww: never cut a line at the terminal width. args: the argv ps shows to
// every local account.
function processList() {
  return execFileSync('ps', ['-ww', '-A', '-o', 'pid=,ppid=,args='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map(([, pid, ppid, args]) => ({ pid: Number(pid), ppid: Number(ppid), args }));
}

function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

// Resolves once check() holds; rejects if the launcher exits first or the
// time runs out, with what it wrote to stderr so far.
function until(check, launcher, stderr, ms) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer);
        resolve();
      } else if (launcher.exitCode !== null || launcher.signalCode !== null || Date.now() - started > ms) {
        clearInterval(timer);
        reject(new Error('the launcher never answered initialize; stderr:\n' + stderr()));
      }
    }, 50);
  });
}

test('the key reaches the endpoint and nothing else', { timeout: 60000 }, async (t) => {
  const key = 'gtm_live_' + crypto.randomBytes(16).toString('hex');
  const stub = await startStub();
  t.after(() => stub.server.close());
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtm-mcp-key-exposure-'));
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));

  // --debug passes through to mcp-remote, which then also writes its log to
  // MCP_REMOTE_CONFIG_DIR: one more place the key must not land.
  const launcher = spawn(process.execPath, [CLI, '--debug'], {
    env: { ...process.env, GTM_API_KEY: key, GTM_MCP_URL: stub.url, MCP_REMOTE_CONFIG_DIR: configDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  launcher.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  launcher.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => launcher.on('exit', resolve));
  let bridge;
  t.after(() => {
    for (const pid of [bridge && bridge.pid, launcher.pid]) {
      try {
        if (pid) process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone, which is the normal case.
      }
    }
  });

  launcher.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: CLIENT_NAME, version: '0.0.0' } },
  }) + '\n');
  await until(() => /"id":1\b/.test(stdout), launcher, () => stderr, 30000);

  // The bridge is up and has proxied a request: read the process list now.
  const processes = processList();
  bridge = processes.find((p) => p.ppid === launcher.pid && p.args.includes('mcp-remote'));
  assert.ok(bridge, 'no mcp-remote process under the launcher in ps, so the argv check would prove nothing');
  assert.ok(bridge.args.includes('Authorization: Bearer ${GTM_API_KEY}'), 'the bridge was not given the key reference: ' + bridge.args);
  assert.deepEqual(processes.filter((p) => p.args.includes(key)).map((p) => p.args), [], 'the key is in ps');

  // mcp-remote renames the client on the way: "key-exposure-test (via mcp-remote 0.1.38)".
  const bridged = stub.requests.find((r) => r.message && r.message.method === 'initialize'
    && r.message.params.clientInfo.name.startsWith(CLIENT_NAME));
  assert.ok(bridged, 'the stub never received the initialize sent through the bridge');
  assert.equal(bridged.authorization, 'Bearer ' + key);

  // Closing stdin is how a client hangs up; mcp-remote exits on it.
  launcher.stdin.end();
  await exited;

  const linesWithKey = (text) => text.split('\n').filter((line) => line.includes(key));
  assert.match(stderr, /Using custom headers/, 'mcp-remote did not log its headers, so the stderr check would prove nothing');
  assert.deepEqual(linesWithKey(stderr), [], 'the key is in stderr');
  assert.deepEqual(linesWithKey(stdout), [], 'the key is in stdout');

  const debugLogs = filesUnder(configDir).filter((file) => file.endsWith('_debug.log'));
  assert.notEqual(debugLogs.length, 0, 'mcp-remote wrote no --debug log, so the log check would prove nothing');
  for (const file of filesUnder(configDir)) {
    assert.deepEqual(linesWithKey(fs.readFileSync(file, 'utf8')), [], 'the key is in ' + path.basename(file));
  }
});
