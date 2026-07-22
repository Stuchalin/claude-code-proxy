'use strict';

/**
 * Claude Code credential proxy
 * ----------------------------
 * A tiny, dependency-free reverse proxy that lets someone use YOUR Claude
 * subscription without ever seeing your credentials.
 *
 * A remote Claude Code CLI points `ANTHROPIC_BASE_URL` at this server. Each
 * request must carry a shared-secret header (so only people you trust can use
 * it). The proxy then strips whatever auth the client sent, injects your own
 * OAuth token + the real Anthropic host, and streams the upstream response
 * (including Server-Sent Events) straight back with no buffering.
 *
 * Everything is configured from a `.env` file — see `.env.example`.
 */

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Minimal .env loader (avoids a dotenv dependency so this stays zero-install).
// Values already present in the real environment win over the file.
// ---------------------------------------------------------------------------
function loadEnvFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return; // no .env file — rely on the process environment
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip matching surrounding quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(path.join(__dirname, '.env'));

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const PROXY_SECRET = process.env.PROXY_SECRET || '';
const OAUTH_TOKEN = process.env.ANTHROPIC_OAUTH_TOKEN || '';
const UPSTREAM_HOST = process.env.UPSTREAM_HOST || 'api.anthropic.com';
// Header the client must send carrying the shared secret.
const SECRET_HEADER = (process.env.PROXY_SECRET_HEADER || 'x-proxy-secret').toLowerCase();
// Beta flag Anthropic requires for subscription OAuth tokens.
const OAUTH_BETA = 'oauth-2025-04-20';

function fail(msg) {
  console.error(`[config] ${msg}`);
  process.exit(1);
}

if (!PROXY_SECRET) fail('PROXY_SECRET is required (shared secret your client must send).');
if (!OAUTH_TOKEN) fail('ANTHROPIC_OAUTH_TOKEN is required (your subscription OAuth token).');

// ---------------------------------------------------------------------------
// Constant-time shared-secret check
// ---------------------------------------------------------------------------
function secretMatches(provided) {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(PROXY_SECRET);
  if (a.length !== b.length) return false; // timingSafeEqual needs equal lengths
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Build the header set sent upstream: drop the client's auth, inject ours.
// ---------------------------------------------------------------------------
function buildUpstreamHeaders(incoming) {
  const headers = { ...incoming };

  // Hop-by-hop / routing headers that must not be forwarded as-is.
  for (const h of [
    'host',
    'authorization',
    'x-api-key',
    'connection',
    'proxy-connection',
    'keep-alive',
    'transfer-encoding',
    'upgrade',
    SECRET_HEADER, // never leak the shared secret upstream
  ]) {
    delete headers[h];
  }

  // Point at the real Anthropic API and inject the subscription OAuth token.
  headers['host'] = UPSTREAM_HOST;
  headers['authorization'] = `Bearer ${OAUTH_TOKEN}`;

  // Ensure the OAuth beta flag is present (append without clobbering others).
  const existingBeta = incoming['anthropic-beta'];
  if (existingBeta) {
    const parts = existingBeta.split(',').map((s) => s.trim()).filter(Boolean);
    if (!parts.includes(OAUTH_BETA)) parts.push(OAUTH_BETA);
    headers['anthropic-beta'] = parts.join(', ');
  } else {
    headers['anthropic-beta'] = OAUTH_BETA;
  }

  return headers;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  // Lightweight, unauthenticated health check for uptime probes.
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // Gate every real request behind the shared secret.
  if (!secretMatches(req.headers[SECRET_HEADER])) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized: missing or invalid proxy secret' }));
    // Drain the incoming body so the socket can be reused/closed cleanly.
    req.resume();
    return;
  }

  const upstreamReq = https.request(
    {
      hostname: UPSTREAM_HOST,
      port: 443,
      method: req.method,
      path: req.url,
      headers: buildUpstreamHeaders(req.headers),
    },
    (upstreamRes) => {
      // Mirror status + headers, then stream the body straight through.
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      // Flush headers immediately so SSE clients start receiving without delay.
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      upstreamRes.pipe(res);
    }
  );

  upstreamReq.on('error', (err) => {
    console.error(`[upstream] ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad gateway', detail: err.message }));
    } else {
      res.destroy(err);
    }
  });

  // Stream the client's request body upstream without buffering it.
  req.pipe(upstreamReq);
  req.on('error', () => upstreamReq.destroy());
});

// Disable Nagle so SSE chunks flush to the client immediately.
server.on('connection', (socket) => socket.setNoDelay(true));

server.listen(PORT, HOST, () => {
  console.log(`[proxy] listening on http://${HOST}:${PORT}`);
  console.log(`[proxy] forwarding to https://${UPSTREAM_HOST}`);
  console.log(`[proxy] shared-secret header: ${SECRET_HEADER}`);
});
