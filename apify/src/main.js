// Apify Actor wrapper for the hosted GTM API LinkedIn MCP server.
//
// No server logic lives here, same contract as npm/bin/cli.js and
// docker/entrypoint.sh in the repo root: every tool executes on the hosted
// streamable-http endpoint (default https://mcp.gtm-api.com/mcp). In Standby
// mode this Actor is a thin HTTP bridge that injects the caller's GTM API key
// as an Authorization bearer; in a normal run it performs a connectivity
// self-check against the endpoint and exits.

import http from 'node:http';
import { Actor } from 'apify';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const UPSTREAM = String(
    input.upstreamUrl || process.env.GTM_MCP_URL || 'https://mcp.gtm-api.com/mcp',
).replace(/\/+$/, '');
const INPUT_KEY = String(input.gtmApiKey || process.env.GTM_API_KEY || '');

const PORT = Number(process.env.ACTOR_WEB_SERVER_PORT || process.env.APIFY_CONTAINER_PORT || 3000);
const STANDBY = process.env.APIFY_META_ORIGIN === 'STANDBY' || Boolean(process.env.ACTOR_STANDBY_URL);
const READINESS_HEADER = 'x-apify-container-server-readiness-probe';

const KEY_HELP = 'GTM API key missing. Set gtmApiKey in the Actor input, or send an '
    + 'x-gtm-api-key header, or append ?gtm_api_key=... to the URL. '
    + 'Keys: https://app.gtm-api.com/login (7-day trial).';

const resolveKey = (req, url) => String(
    req.headers['x-gtm-api-key'] || url.searchParams.get('gtm_api_key') || INPUT_KEY || '',
).trim();

const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
});

const jsonError = (res, status, message) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }));
};

async function proxy(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const key = resolveKey(req, url);
    if (!key) return jsonError(res, 401, KEY_HELP);

    const headers = { authorization: `Bearer ${key}` };
    for (const h of ['content-type', 'accept', 'mcp-session-id', 'last-event-id', 'mcp-protocol-version']) {
        if (req.headers[h]) headers[h] = req.headers[h];
    }
    if (!headers.accept) headers.accept = 'application/json, text/event-stream';

    let upstreamRes;
    try {
        const body = await readBody(req);
        upstreamRes = await fetch(UPSTREAM, {
            method: req.method,
            headers,
            body: body.length > 0 ? body : undefined,
        });
    } catch (err) {
        return jsonError(res, 502, `Upstream ${UPSTREAM} unreachable: ${err.message}`);
    }

    const outHeaders = {};
    for (const h of ['content-type', 'mcp-session-id', 'cache-control']) {
        const v = upstreamRes.headers.get(h);
        if (v) outHeaders[h] = v;
    }
    res.writeHead(upstreamRes.status, outHeaders);
    if (upstreamRes.body) {
        try {
            for await (const chunk of upstreamRes.body) res.write(chunk);
        } catch {
            // Client or upstream dropped mid-stream; nothing sane to send.
        }
    }
    res.end();
}

if (STANDBY) {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost');
        if (req.method === 'GET' && url.pathname === '/') {
            if (req.headers[READINESS_HEADER]) {
                res.writeHead(200, { 'content-type': 'text/plain' });
                return res.end('ok');
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({
                name: 'GTM API LinkedIn MCP Server',
                mcpPath: '/mcp',
                transport: 'streamable-http',
                upstream: UPSTREAM,
                keyConfigured: Boolean(INPUT_KEY),
                docs: 'https://github.com/gtm-api/linkedin-mcp',
                keys: 'https://app.gtm-api.com/login',
            }));
        }
        if (url.pathname === '/mcp' && ['POST', 'GET', 'DELETE'].includes(req.method)) {
            return void proxy(req, res);
        }
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not found. MCP lives at POST /mcp (streamable-http).');
    });
    server.listen(PORT, () => console.log(`Standby bridge on :${PORT}, upstream ${UPSTREAM}`));
} else {
    // Normal run: connectivity self-check, then exit. The real use is Standby.
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (INPUT_KEY) headers.authorization = `Bearer ${INPUT_KEY}`;
    const started = Date.now();
    let summary;
    try {
        const r = await fetch(UPSTREAM, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2025-03-26',
                    capabilities: {},
                    clientInfo: { name: 'apify-actor-selfcheck', version: '0.1' },
                },
            }),
        });
        const text = await r.text();
        summary = {
            upstream: UPSTREAM,
            status: r.status,
            latencyMs: Date.now() - started,
            keyConfigured: Boolean(INPUT_KEY),
            verdict: r.status === 200
                ? 'endpoint answered the MCP initialize call'
                : (r.status === 401 && !INPUT_KEY)
                    ? 'endpoint alive, auth enforced (401 without a key, as expected); set gtmApiKey in the input for a full check'
                    : `unexpected status ${r.status}`,
            bodyPreview: text.slice(0, 400),
        };
    } catch (err) {
        summary = { upstream: UPSTREAM, error: err.message, verdict: 'endpoint unreachable' };
    }
    console.log(JSON.stringify(summary, null, 2));
    await Actor.pushData(summary);
    await Actor.exit(summary.verdict);
}
