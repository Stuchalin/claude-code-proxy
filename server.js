'use strict';

/**
 * claude-code-proxy
 * -----------------
 * A tiny, dependency-free self-hosted gateway that lets you use your own Claude
 * subscription from your other devices without copying credential files around.
 *
 * A Claude Code CLI points `ANTHROPIC_BASE_URL` at this server. Each request
 * must carry a shared-secret header (so only clients you authorize can use it).
 * The proxy strips whatever auth the client sent, injects the OAuth token it
 * reads from your local Claude Code login + the real Anthropic host, and streams
 * the upstream response (including Server-Sent Events) straight back with no
 * buffering.
 *
 * The OAuth token is discovered automatically from your local Claude Code
 * credentials (no copy/paste needed) and refreshed on the fly when it expires.
 * Everything else is configured from a `.env` file — see `.env.example`.
 *
 * You are responsible for using this in line with Anthropic's terms — it
 * forwards your credentials, so every request counts as your own usage.
 */

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

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
const UPSTREAM_HOST = process.env.UPSTREAM_HOST || 'api.anthropic.com';
// Header the client must send carrying the shared secret.
const SECRET_HEADER = (process.env.PROXY_SECRET_HEADER || 'x-proxy-secret').toLowerCase();
// Beta flag Anthropic requires for subscription OAuth tokens.
const OAUTH_BETA = 'oauth-2025-04-20';

// --- Token discovery / refresh settings ---
// Optional hard override: if set, this token is used as-is and never refreshed.
const EXPLICIT_TOKEN = process.env.ANTHROPIC_OAUTH_TOKEN || '';
// Where Claude Code keeps its credentials on this machine.
const CREDS_PATH =
  process.env.CLAUDE_CREDENTIALS_PATH ||
  path.join(os.homedir(), '.claude', '.credentials.json');
// Auto-refresh the token when it's expired (default on). Set AUTO_REFRESH=false to disable.
const AUTO_REFRESH = (process.env.AUTO_REFRESH || 'true').toLowerCase() !== 'false';
// Claude Code's public OAuth client id + token endpoint (overridable).
const OAUTH_CLIENT_ID =
  process.env.OAUTH_CLIENT_ID || '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_TOKEN_URL =
  process.env.OAUTH_TOKEN_URL || 'https://console.anthropic.com/v1/oauth/token';
// Refresh this many ms before the token actually expires.
const REFRESH_SKEW_MS = 60_000;

// --- Model policy ---
// Comma-separated, case-insensitive substrings matched against the request's
// "model" field. BLOCKED_MODELS rejects any match (e.g. "fable" blocks
// claude-fable-5). ALLOWED_MODELS, if set, permits ONLY matching models.
function parseList(v) {
  return (v || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
const BLOCKED_MODELS = parseList(process.env.BLOCKED_MODELS);
const ALLOWED_MODELS = parseList(process.env.ALLOWED_MODELS);

// Effort cap: reject requests whose output_config.effort exceeds this ceiling.
// Levels, lowest to highest. Claude Code defaults to "xhigh".
const EFFORT_ORDER = { low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };
const MAX_EFFORT = (process.env.MAX_EFFORT || '').trim().toLowerCase();
if (MAX_EFFORT && !(MAX_EFFORT in EFFORT_ORDER)) {
  console.error(`[config] MAX_EFFORT must be one of ${Object.keys(EFFORT_ORDER).join(', ')} (got '${MAX_EFFORT}')`);
  process.exit(1);
}
// Max request body we'll buffer to inspect the model (bytes). Requests larger
// than this are rejected with 413. Generous default for image-heavy prompts.
const MAX_REQUEST_BYTES = Number(process.env.MAX_REQUEST_BYTES || 100 * 1024 * 1024);

// --- Access window (trial time limit) ---
// After ACCESS_DURATION elapses, the proxy refuses further requests. The clock
// starts on first use (default) or at server start, and is persisted so a
// restart doesn't hand out a fresh window. Delete the state file to reset.
function parseDuration(v) {
  if (!v) return 0;
  const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/i);
  if (!m) {
    console.error(`[config] ACCESS_DURATION must look like 1h / 30m / 90s / 2d (got '${v}')`);
    process.exit(1);
  }
  const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[(m[2] || 'm').toLowerCase()];
  return Math.round(parseFloat(m[1]) * mult); // bare number => minutes
}
const ACCESS_DURATION_MS = parseDuration(process.env.ACCESS_DURATION);
const ACCESS_START_MODE = (process.env.ACCESS_START_MODE || 'first-use').toLowerCase();
const ACCESS_STATE_FILE = process.env.ACCESS_STATE_FILE || path.join(__dirname, '.access-start');
// What to do once expired: 'reject' (403 every request) or 'shutdown' (exit).
const ACCESS_EXPIRE_ACTION = (process.env.ACCESS_EXPIRE_ACTION || 'reject').toLowerCase();

let accessStart = 0; // ms epoch the window began; 0 = not started yet

function loadAccessStart() {
  try {
    const n = parseInt(fs.readFileSync(ACCESS_STATE_FILE, 'utf8').trim(), 10);
    if (Number.isFinite(n) && n > 0) accessStart = n;
  } catch {
    /* no prior state */
  }
}

function startAccessWindow() {
  if (accessStart) return; // already running
  accessStart = Date.now();
  try {
    fs.writeFileSync(ACCESS_STATE_FILE, String(accessStart), { mode: 0o600 });
  } catch (e) {
    console.error(`[access] could not persist start time: ${e.message}`);
  }
  console.log(
    `[access] window started; expires ${new Date(accessStart + ACCESS_DURATION_MS).toISOString()}`
  );
}

function accessExpired() {
  return Boolean(ACCESS_DURATION_MS && accessStart && Date.now() >= accessStart + ACCESS_DURATION_MS);
}

function fail(msg) {
  console.error(`[config] ${msg}`);
  process.exit(1);
}

if (!PROXY_SECRET) fail('PROXY_SECRET is required (shared secret your client must send).');

// ---------------------------------------------------------------------------
// Token cache + discovery
//   Priority: explicit env var  ->  credentials file  ->  macOS Keychain.
//   The file is re-read only when its mtime changes, so a token refreshed by
//   your own Claude Code CLI is picked up automatically.
// ---------------------------------------------------------------------------
let cache = { token: '', refreshToken: '', expiresAt: 0, source: 'none', mtimeMs: 0 };
let refreshPromise = null;

// Claude Code stores expiresAt in ms; tolerate a seconds value just in case.
function normalizeExpiry(v) {
  if (!v || typeof v !== 'number') return 0;
  return v < 1e12 ? v * 1000 : v;
}

function loadFromFile() {
  const st = fs.statSync(CREDS_PATH); // throws if the file is missing
  if (cache.source === 'file' && st.mtimeMs === cache.mtimeMs && cache.token) {
    return true; // unchanged since last read
  }
  const data = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
  const o = data.claudeAiOauth || {};
  if (!o.accessToken) return false;
  cache = {
    token: o.accessToken,
    refreshToken: o.refreshToken || '',
    expiresAt: normalizeExpiry(o.expiresAt),
    source: 'file',
    mtimeMs: st.mtimeMs,
  };
  return true;
}

function loadFromKeychain() {
  // macOS stores the same JSON blob in the login Keychain.
  for (const service of ['Claude Code-credentials', 'Claude Code']) {
    try {
      const raw = execFileSync('security', ['find-generic-password', '-s', service, '-w'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const o = (JSON.parse(raw).claudeAiOauth) || {};
      if (o.accessToken) {
        cache = {
          token: o.accessToken,
          refreshToken: o.refreshToken || '',
          expiresAt: normalizeExpiry(o.expiresAt),
          source: 'keychain',
          mtimeMs: 0,
        };
        return true;
      }
    } catch {
      /* try the next service name */
    }
  }
  return false;
}

function loadCredentials() {
  if (EXPLICIT_TOKEN) {
    if (cache.source !== 'env') {
      cache = { token: EXPLICIT_TOKEN, refreshToken: '', expiresAt: 0, source: 'env', mtimeMs: 0 };
    }
    return;
  }
  try {
    if (loadFromFile()) return;
  } catch {
    /* file missing / unreadable — fall through */
  }
  if (process.platform === 'darwin' && loadFromKeychain()) return;
}

// Persist a freshly refreshed token back to the credentials file (atomic write,
// preserving any other fields) so your own CLI and this proxy stay in sync.
function persistToFile(token, refreshToken, expiresAt) {
  try {
    const data = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
    data.claudeAiOauth = {
      ...(data.claudeAiOauth || {}),
      accessToken: token,
      refreshToken: refreshToken,
      expiresAt: expiresAt,
    };
    const tmp = `${CREDS_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, CREDS_PATH);
    cache.mtimeMs = fs.statSync(CREDS_PATH).mtimeMs;
  } catch (e) {
    console.error(`[refresh] could not persist new token: ${e.message}`);
  }
}

function doRefresh() {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: cache.refreshToken,
      client_id: OAUTH_CLIENT_ID,
    });
    const u = new URL(OAUTH_TOKEN_URL);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (resp) => {
        let d = '';
        resp.on('data', (c) => (d += c));
        resp.on('end', () => {
          if (resp.statusCode !== 200) {
            console.error(`[refresh] failed (${resp.statusCode}): ${d.slice(0, 200)}`);
            return resolve();
          }
          try {
            const j = JSON.parse(d);
            const newToken = j.access_token;
            if (!newToken) {
              console.error('[refresh] response had no access_token');
              return resolve();
            }
            const newRefresh = j.refresh_token || cache.refreshToken;
            const expiresAt = j.expires_in ? Date.now() + j.expires_in * 1000 : 0;
            cache.token = newToken;
            cache.refreshToken = newRefresh;
            cache.expiresAt = expiresAt;
            console.log('[refresh] access token refreshed');
            if (cache.source === 'file') persistToFile(newToken, newRefresh, expiresAt);
          } catch (e) {
            console.error(`[refresh] could not parse response: ${e.message}`);
          }
          resolve();
        });
      }
    );
    req.on('error', (e) => {
      console.error(`[refresh] request error: ${e.message}`);
      resolve();
    });
    req.write(body);
    req.end();
  });
}

// Single-flight refresh so concurrent requests don't all hit the token endpoint.
function refreshToken() {
  if (!cache.refreshToken) return Promise.resolve();
  if (!refreshPromise) {
    refreshPromise = doRefresh().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

async function getToken() {
  loadCredentials();
  const expired =
    cache.expiresAt && Date.now() >= cache.expiresAt - REFRESH_SKEW_MS;
  if (!EXPLICIT_TOKEN && AUTO_REFRESH && cache.refreshToken && expired) {
    await refreshToken();
  }
  return cache.token;
}

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
// Model policy
// ---------------------------------------------------------------------------
// Buffer the request body (bounded) so we can read its "model" field.
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_REQUEST_BYTES) {
        const err = new Error('request body too large');
        err.code = 'TOO_LARGE';
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Extract the requested model and effort from a JSON body (fields may be null).
function inspectBody(body, contentType) {
  const empty = { model: null, effort: null };
  if (!body || body.length === 0) return empty;
  if (contentType && !contentType.toLowerCase().includes('json')) return empty;
  try {
    const j = JSON.parse(body.toString('utf8'));
    return {
      model: typeof j.model === 'string' ? j.model : null,
      effort:
        j.output_config && typeof j.output_config.effort === 'string'
          ? j.output_config.effort
          : null,
    };
  } catch {
    return empty;
  }
}

// Decide whether a model is permitted. Allowlist (if set) wins, then blocklist.
function modelDecision(model) {
  if (!model) return { ok: true };
  const m = model.toLowerCase();
  if (ALLOWED_MODELS.length && !ALLOWED_MODELS.some((s) => m.includes(s))) {
    return { ok: false, reason: `model '${model}' is not in this proxy's allowed list` };
  }
  if (BLOCKED_MODELS.some((s) => m.includes(s))) {
    return { ok: false, reason: `model '${model}' is blocked by this proxy` };
  }
  return { ok: true };
}

// Decide whether a request's effort level is within the configured ceiling.
function effortDecision(effort) {
  if (!MAX_EFFORT || !effort) return { ok: true };
  const rank = EFFORT_ORDER[effort.toLowerCase()];
  if (!rank) return { ok: true }; // unknown value — let upstream judge it
  if (rank > EFFORT_ORDER[MAX_EFFORT]) {
    return {
      ok: false,
      reason: `effort '${effort}' exceeds this proxy's maximum of '${MAX_EFFORT}' — lower the effort and retry`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Build the header set sent upstream: drop the client's auth, inject ours.
// ---------------------------------------------------------------------------
function buildUpstreamHeaders(incoming, token) {
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
  headers['authorization'] = `Bearer ${token}`;

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
const server = http.createServer(async (req, res) => {
  // Lightweight, unauthenticated health check for uptime probes.
  if (req.method === 'GET' && req.url === '/health') {
    const body = { status: 'ok', tokenSource: cache.source };
    if (ACCESS_DURATION_MS) {
      body.access = {
        expired: accessExpired(),
        expiresAt: accessStart ? new Date(accessStart + ACCESS_DURATION_MS).toISOString() : null,
      };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }

  // Gate every real request behind the shared secret.
  if (!secretMatches(req.headers[SECRET_HEADER])) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized: missing or invalid proxy secret' }));
    req.resume(); // drain the body so the socket closes cleanly
    return;
  }

  // Enforce the trial access window. Clock starts on first authenticated use.
  if (ACCESS_DURATION_MS) {
    if (ACCESS_START_MODE === 'first-use') startAccessWindow();
    if (accessExpired()) {
      console.log(`[access] expired — refused ${req.method} ${req.url}`);
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'forbidden', message: 'access window has expired' },
        })
      );
      req.resume();
      if (ACCESS_EXPIRE_ACTION === 'shutdown') {
        console.log('[access] shutting down (ACCESS_EXPIRE_ACTION=shutdown)');
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 1000).unref();
      }
      return;
    }
  }

  // Buffer the request body so we can inspect the requested model. (Only the
  // request is buffered — the streamed SSE *response* still flows unbuffered.)
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    if (e.code === 'TOO_LARGE') {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'request body too large' }));
    } else if (!res.headersSent) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'could not read request body' }));
    }
    return;
  }

  // Enforce the model + effort policy before spending a token refresh or hitting upstream.
  const { model, effort } = inspectBody(body, req.headers['content-type']);
  const decision = [modelDecision(model), effortDecision(effort)].find((d) => !d.ok);
  if (decision) {
    console.log(`[policy] blocked ${req.method} ${req.url} -> ${decision.reason}`);
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'forbidden', message: decision.reason } }));
    return;
  }

  // Resolve (and if needed refresh) the OAuth token to inject.
  let token = '';
  try {
    token = await getToken();
  } catch (e) {
    console.error(`[token] ${e.message}`);
  }
  if (!token) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error:
          'no upstream credentials available — log into Claude Code on this machine or set ANTHROPIC_OAUTH_TOKEN',
      })
    );
    return;
  }

  const headers = buildUpstreamHeaders(req.headers, token);
  // We forward a fixed buffer, so set an accurate content-length.
  if (body.length > 0) headers['content-length'] = Buffer.byteLength(body);
  else delete headers['content-length'];

  const upstreamReq = https.request(
    {
      hostname: UPSTREAM_HOST,
      port: 443,
      method: req.method,
      path: req.url,
      headers,
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

  if (body.length > 0) upstreamReq.write(body);
  upstreamReq.end();
});

// Disable Nagle so SSE chunks flush to the client immediately.
server.on('connection', (socket) => socket.setNoDelay(true));

server.listen(PORT, HOST, () => {
  loadCredentials(); // warm the cache so we can report status at boot
  console.log(`[proxy] listening on http://${HOST}:${PORT}`);
  console.log(`[proxy] forwarding to https://${UPSTREAM_HOST}`);
  console.log(`[proxy] shared-secret header: ${SECRET_HEADER}`);
  if (ALLOWED_MODELS.length) console.log(`[proxy] model allowlist: ${ALLOWED_MODELS.join(', ')}`);
  if (BLOCKED_MODELS.length) console.log(`[proxy] model blocklist: ${BLOCKED_MODELS.join(', ')}`);
  if (MAX_EFFORT) console.log(`[proxy] max effort: ${MAX_EFFORT}`);
  if (ACCESS_DURATION_MS) {
    loadAccessStart();
    if (ACCESS_START_MODE === 'server-start') startAccessWindow();
    const ms = ACCESS_DURATION_MS;
    const dur =
      ms % 86400000 === 0 ? `${ms / 86400000}d`
      : ms % 3600000 === 0 ? `${ms / 3600000}h`
      : ms % 60000 === 0 ? `${ms / 60000}m`
      : `${ms / 1000}s`;
    if (accessStart) {
      const exp = new Date(accessStart + ACCESS_DURATION_MS).toISOString();
      console.log(`[proxy] access window: ${dur} (${accessExpired() ? 'EXPIRED' : `expires ${exp}`})`);
    } else {
      console.log(`[proxy] access window: ${dur}, starts on first use`);
    }
  }
  if (cache.token) {
    const exp = cache.expiresAt ? ` (expires ${new Date(cache.expiresAt).toISOString()})` : '';
    console.log(`[proxy] OAuth token discovered from ${cache.source}${exp}`);
  } else {
    console.warn(
      `[proxy] WARNING: no OAuth token found yet. Log into Claude Code on this machine ` +
        `(checked ${EXPLICIT_TOKEN ? 'ANTHROPIC_OAUTH_TOKEN' : CREDS_PATH}), or set ANTHROPIC_OAUTH_TOKEN.`
    );
  }
});
