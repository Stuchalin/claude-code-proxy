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
// Upstream protocol + port. Defaults talk to the real API over TLS; `http`
// exists so tests can point the proxy at a local plain-HTTP fake upstream.
const UPSTREAM_PROTOCOL = (
  process.env.UPSTREAM_PROTOCOL || 'https'
).toLowerCase();
if (UPSTREAM_PROTOCOL !== 'https' && UPSTREAM_PROTOCOL !== 'http') {
  fail(`UPSTREAM_PROTOCOL must be https or http (got '${UPSTREAM_PROTOCOL}')`);
}
const UPSTREAM_PORT = Number(process.env.UPSTREAM_PORT || 443);
if (
  !Number.isInteger(UPSTREAM_PORT) ||
  UPSTREAM_PORT < 1 ||
  UPSTREAM_PORT > 65535
) {
  fail(
    `UPSTREAM_PORT must be an integer 1-65535 (got '${process.env.UPSTREAM_PORT}')`,
  );
}
// Header the client must send carrying the shared secret.
const SECRET_HEADER = (
  process.env.PROXY_SECRET_HEADER || 'x-proxy-secret'
).toLowerCase();
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
const AUTO_REFRESH =
  (process.env.AUTO_REFRESH || 'true').toLowerCase() !== 'false';
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
  console.error(
    `[config] MAX_EFFORT must be one of ${Object.keys(EFFORT_ORDER).join(', ')} (got '${MAX_EFFORT}')`,
  );
  process.exit(1);
}
// Max request body we'll buffer to inspect the model (bytes). Requests larger
// than this are rejected with 413. Generous default for image-heavy prompts.
const MAX_REQUEST_BYTES = Number(
  process.env.MAX_REQUEST_BYTES || 100 * 1024 * 1024,
);

// --- Usage cache (GET /api/oauth/usage) ---
// Every client polls the usage endpoint with the same OAuth token, so they
// share one upstream rate limit. The proxy caches the 200 answer per path +
// query, coalesces concurrent refreshes, serves a stale answer on 429 / 5xx /
// network errors, and pauses upstream calls after a 429. Durations are in
// seconds (fractional allowed). USAGE_CACHE=false restores plain pass-through.
const USAGE_PATH = '/api/oauth/usage';
const USAGE_CACHE_RAW = (process.env.USAGE_CACHE || 'true')
  .trim()
  .toLowerCase();
if (USAGE_CACHE_RAW !== 'true' && USAGE_CACHE_RAW !== 'false') {
  fail(`USAGE_CACHE must be true or false (got '${process.env.USAGE_CACHE}')`);
}
const USAGE_CACHE = USAGE_CACHE_RAW === 'true';
function parseSeconds(name, raw, def) {
  if (raw === undefined || String(raw).trim() === '') return def * 1000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    fail(`${name} must be a positive number of seconds (got '${raw}')`);
  }
  return n * 1000;
}
const USAGE_CACHE_TTL_MS = parseSeconds(
  'USAGE_CACHE_TTL',
  process.env.USAGE_CACHE_TTL,
  60,
);
const USAGE_CACHE_MAX_STALE_MS = parseSeconds(
  'USAGE_CACHE_MAX_STALE',
  process.env.USAGE_CACHE_MAX_STALE,
  900,
);
const USAGE_BACKOFF_BASE_MS = parseSeconds(
  'USAGE_BACKOFF_BASE',
  process.env.USAGE_BACKOFF_BASE,
  300,
);
const USAGE_BACKOFF_MAX_MS = parseSeconds(
  'USAGE_BACKOFF_MAX',
  process.env.USAGE_BACKOFF_MAX,
  1800,
);
const USAGE_USER_AGENT = process.env.USAGE_USER_AGENT || 'claude-code/2.1.0';
try {
  http.validateHeaderValue('user-agent', USAGE_USER_AGENT);
} catch {
  fail('USAGE_USER_AGENT is not a valid header value');
}
// Upper bound for one upstream usage exchange (headers + body).
const USAGE_FETCH_TIMEOUT_MS = 30_000;

// --- Access window (trial time limit) ---
// After ACCESS_DURATION elapses, the proxy refuses further requests. The clock
// starts on first use (default) or at server start, and is persisted so a
// restart doesn't hand out a fresh window. Delete the state file to reset.
function parseDuration(v) {
  if (!v) return 0;
  const m = String(v)
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/i);
  if (!m) {
    console.error(
      `[config] ACCESS_DURATION must look like 1h / 30m / 90s / 2d (got '${v}')`,
    );
    process.exit(1);
  }
  const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[
    (m[2] || 'm').toLowerCase()
  ];
  return Math.round(parseFloat(m[1]) * mult); // bare number => minutes
}
const ACCESS_DURATION_MS = parseDuration(process.env.ACCESS_DURATION);
const ACCESS_START_MODE = (
  process.env.ACCESS_START_MODE || 'first-use'
).toLowerCase();
const ACCESS_STATE_FILE =
  process.env.ACCESS_STATE_FILE || path.join(__dirname, '.access-start');
// What to do once expired: 'reject' (403 every request) or 'shutdown' (exit).
const ACCESS_EXPIRE_ACTION = (
  process.env.ACCESS_EXPIRE_ACTION || 'reject'
).toLowerCase();

let accessStart = 0; // ms epoch the window began; 0 = not started yet

// ---------------------------------------------------------------------------
// Usage stats (in-memory; lost on restart) for the /dashboard view.
//   We tap the streamed SSE response to read the token-usage events Anthropic
//   emits (message_start -> input tokens; message_delta -> output tokens) so we
//   can show per-client request counts, token totals, an API-equivalent dollar
//   estimate, and what each client is doing right now. This does NOT buffer the
//   stream — bytes still flow to the client in real time; we only sniff a copy.
//
//   NOTE: the "$" figure is what the traffic WOULD cost at public per-token API
//   prices. A subscription is a flat fee, so this is a usage yardstick, not a
//   real charge. Account-level weekly/session quota % is not exposed by the API
//   and cannot be shown here.
// ---------------------------------------------------------------------------
const serverStart = Date.now();

// Public API prices in USD per 1M tokens (input, output). Substring match on
// the model id, first hit wins; order specific -> generic. Cache tokens are
// billed at read/write rates but we fold them into input for a rough estimate.
const PRICING = [
  { match: 'opus', in: 15, out: 75 },
  { match: 'sonnet', in: 3, out: 15 },
  { match: 'haiku', in: 0.8, out: 4 },
  { match: 'fable', in: 5, out: 25 },
];
function priceFor(model) {
  const m = (model || '').toLowerCase();
  return PRICING.find((p) => m.includes(p.match)) || { in: 3, out: 15 };
}
function estimateCost(model, inTok, outTok) {
  const p = priceFor(model);
  return (inTok / 1e6) * p.in + (outTok / 1e6) * p.out;
}

const stats = {
  totals: {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    blocked: 0,
    errors: 0,
  },
  byModel: new Map(), // model -> { requests, inputTokens, outputTokens, cost }
  clients: new Map(), // ip -> { firstSeen, lastSeen, requests, inputTokens, outputTokens, cost, models:Set, active, lastModel, lastPrompt, lastStatus }
};

// Usage cache state (see handleUsage). Only upstream 200 answers are stored.
const usageCache = new Map(); // req.url -> { body: Buffer, contentType, at }
const usageInflight = new Map(); // req.url -> Promise of the upstream result
// Global pause after an upstream 429: the limit is per token, and every key
// shares one token. stepMs is the current escalation step (0 = none yet).
const usagePause = { until: 0, stepMs: 0 };
const usageStats = { hit: 0, miss: 0, stale: 0, rateLimited: 0, fetches: 0 };

function clientKey(req) {
  // Behind a tunnel/proxy the socket IP is the edge; the real client is in
  // CF-Connecting-IP (Cloudflare) or the first X-Forwarded-For entry.
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf).trim();
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function getClient(ip) {
  let c = stats.clients.get(ip);
  if (!c) {
    c = {
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      models: new Set(),
      active: 0,
      lastModel: null,
      lastPrompt: null,
      lastStatus: null,
    };
    stats.clients.set(ip, c);
  }
  return c;
}

// Pull a short preview of the latest user turn from a request body, for the
// "what he's doing" column. Best-effort; never throws.
function promptPreview(body, contentType) {
  if (!body || !body.length) return null;
  if (contentType && !contentType.toLowerCase().includes('json')) return null;
  try {
    const j = JSON.parse(body.toString('utf8'));
    const msgs = Array.isArray(j.messages) ? j.messages : [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role !== 'user') continue;
      const c = msgs[i].content;
      let text =
        typeof c === 'string'
          ? c
          : Array.isArray(c)
            ? c
                .filter((b) => b && b.type === 'text')
                .map((b) => b.text)
                .join(' ')
            : '';
      text = text.replace(/\s+/g, ' ').trim();
      if (text) return text.length > 120 ? text.slice(0, 117) + '…' : text;
    }
  } catch {
    /* ignore */
  }
  return null;
}

// Watch an SSE stream (as it flows to the client) for usage events, updating
// the given client + global totals when the numbers arrive. Anthropic sends
// input_tokens in message_start and cumulative output_tokens in message_delta.
function tapUsage(upstreamRes, client, model) {
  let buf = '';
  let inTok = 0,
    outTok = 0,
    cacheTok = 0;
  const onData = (chunk) => {
    buf += chunk.toString('utf8');
    // Keep only the tail after the last newline; parse complete lines.
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const ev = JSON.parse(payload);
        const u = ev.usage || (ev.message && ev.message.usage);
        if (u) {
          if (typeof u.input_tokens === 'number') inTok = u.input_tokens;
          if (typeof u.cache_read_input_tokens === 'number')
            cacheTok += u.cache_read_input_tokens;
          if (typeof u.cache_creation_input_tokens === 'number')
            cacheTok += u.cache_creation_input_tokens;
          if (typeof u.output_tokens === 'number') outTok = u.output_tokens;
        }
      } catch {
        /* partial or non-JSON data line */
      }
    }
  };
  let done = false;
  const finalize = () => {
    if (done) return; // end/close/error may all fire — count once
    done = true;
    upstreamRes.removeListener('data', onData);
    const totalIn = inTok + cacheTok;
    const cost = estimateCost(model, totalIn, outTok);
    client.inputTokens += totalIn;
    client.outputTokens += outTok;
    client.cost += cost;
    client.active = Math.max(0, client.active - 1);
    stats.totals.inputTokens += totalIn;
    stats.totals.outputTokens += outTok;
    stats.totals.cost += cost;
    const mk = model || 'unknown';
    const bm = stats.byModel.get(mk) || {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
    };
    bm.inputTokens += totalIn;
    bm.outputTokens += outTok;
    bm.cost += cost;
    stats.byModel.set(mk, bm);
  };
  upstreamRes.on('data', onData);
  upstreamRes.once('end', finalize);
  upstreamRes.once('close', finalize);
  upstreamRes.once('error', finalize);
}

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
    `[access] window started; expires ${new Date(accessStart + ACCESS_DURATION_MS).toISOString()}`,
  );
}

function accessExpired() {
  return Boolean(
    ACCESS_DURATION_MS &&
    accessStart &&
    Date.now() >= accessStart + ACCESS_DURATION_MS,
  );
}

function fail(msg) {
  console.error(`[config] ${msg}`);
  process.exit(1);
}

if (!PROXY_SECRET)
  fail('PROXY_SECRET is required (shared secret your client must send).');

// ---------------------------------------------------------------------------
// Token cache + discovery
//   Priority: explicit env var  ->  credentials file  ->  macOS Keychain.
//   The file is re-read only when its mtime changes, so a token refreshed by
//   your own Claude Code CLI is picked up automatically.
// ---------------------------------------------------------------------------
let cache = {
  token: '',
  refreshToken: '',
  expiresAt: 0,
  source: 'none',
  mtimeMs: 0,
};
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
      const raw = execFileSync(
        'security',
        ['find-generic-password', '-s', service, '-w'],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
      const o = JSON.parse(raw).claudeAiOauth || {};
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
      cache = {
        token: EXPLICIT_TOKEN,
        refreshToken: '',
        expiresAt: 0,
        source: 'env',
        mtimeMs: 0,
      };
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
            console.error(
              `[refresh] failed (${resp.statusCode}): ${d.slice(0, 200)}`,
            );
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
            const expiresAt = j.expires_in
              ? Date.now() + j.expires_in * 1000
              : 0;
            cache.token = newToken;
            cache.refreshToken = newRefresh;
            cache.expiresAt = expiresAt;
            console.log('[refresh] access token refreshed');
            if (cache.source === 'file')
              persistToFile(newToken, newRefresh, expiresAt);
          } catch (e) {
            console.error(`[refresh] could not parse response: ${e.message}`);
          }
          resolve();
        });
      },
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
    return {
      ok: false,
      reason: `model '${model}' is not in this proxy's allowed list`,
    };
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
    const parts = existingBeta
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!parts.includes(OAUTH_BETA)) parts.push(OAUTH_BETA);
    headers['anthropic-beta'] = parts.join(', ');
  } else {
    headers['anthropic-beta'] = OAUTH_BETA;
  }

  return headers;
}

// Open a request to the configured upstream (protocol, host, port). `options`
// carries method, path and headers; the callback gets the upstream response.
function upstreamRequest(options, onResponse) {
  const transport = UPSTREAM_PROTOCOL === 'http' ? http : https;
  return transport.request(
    { ...options, hostname: UPSTREAM_HOST, port: UPSTREAM_PORT },
    onResponse,
  );
}

// ---------------------------------------------------------------------------
// Usage cache: GET /api/oauth/usage
// ---------------------------------------------------------------------------
const NO_TOKEN_MESSAGE =
  'no upstream credentials available — log into Claude Code on this machine or set ANTHROPIC_OAUTH_TOKEN';
// Response headers that describe the upstream connection, not the payload.
const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'content-length', // recomputed from the buffered body
];

// Parse Retry-After (delta-seconds or HTTP-date) into ms from now; 0 unless
// it lies in the future.
function retryAfterMs(value) {
  if (!value) return 0;
  const v = String(value).trim();
  const ms = /^\d+$/.test(v)
    ? Number(v) * 1000
    : Date.parse(v) - Date.now() || 0;
  return ms > 0 ? ms : 0;
}

// One upstream exchange, fully buffered. Resolves (never rejects) with
//   { kind: 'response', status, headers, body } | { kind: 'network', error }
//   | { kind: 'notoken' }.
// A partial body (error / abort / close before 'end') is a network error.
async function fetchUsage(req) {
  // getToken() (and a refresh it may trigger) is not bounded by the timer
  // below; doRefresh has no timeout of its own.
  let token = '';
  try {
    token = await getToken();
  } catch (e) {
    console.error(`[token] ${e.message}`);
  }
  if (!token) return { kind: 'notoken' };

  const headers = buildUpstreamHeaders(req.headers, token);
  headers['user-agent'] = USAGE_USER_AGENT;
  headers['accept-encoding'] = 'identity'; // cached bytes must be plain
  delete headers['content-length'];
  usageStats.fetches++;

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const netError = (error) => finish({ kind: 'network', error });

    let upstreamReq;
    try {
      upstreamReq = upstreamRequest(
        { method: 'GET', path: req.url, headers },
        (upstreamRes) => {
          const chunks = [];
          let ended = false;
          upstreamRes.on('data', (c) => chunks.push(c));
          upstreamRes.once('end', () => {
            ended = true;
            finish({
              kind: 'response',
              status: upstreamRes.statusCode || 502,
              headers: upstreamRes.headers,
              body: Buffer.concat(chunks),
            });
          });
          upstreamRes.once('error', netError);
          upstreamRes.once('aborted', () =>
            netError(new Error('upstream response aborted')),
          );
          upstreamRes.once('close', () => {
            if (!ended) netError(new Error('upstream closed mid-response'));
          });
        },
      );
    } catch (e) {
      netError(e);
      return;
    }
    // One absolute deadline over the whole exchange (headers + body).
    timer = setTimeout(
      () =>
        upstreamReq.destroy(
          new Error(`timed out after ${USAGE_FETCH_TIMEOUT_MS / 1000} s`),
        ),
      USAGE_FETCH_TIMEOUT_MS,
    );
    upstreamReq.on('error', netError);
    upstreamReq.end();
  });
}

// Apply one upstream result to the shared state, once per fetch (not per
// waiter): store a 200, reset or advance the 429 pause, log failures.
function recordUsageResult(key, result) {
  const now = Date.now();
  if (result.kind === 'notoken') {
    console.error(`[usage] ${key}: no upstream credentials`);
  } else if (result.kind === 'network') {
    console.error(`[usage] ${key}: upstream error: ${result.error.message}`);
  } else if (result.status === 200) {
    usageCache.set(key, {
      body: result.body,
      contentType: result.headers['content-type'],
      at: now,
    });
    usagePause.until = 0;
    usagePause.stepMs = 0;
  } else if (result.status === 429) {
    usageStats.rateLimited++;
    usagePause.stepMs = Math.min(
      usagePause.stepMs ? usagePause.stepMs * 2 : USAGE_BACKOFF_BASE_MS,
      USAGE_BACKOFF_MAX_MS,
    );
    const retryMs = retryAfterMs(result.headers['retry-after']);
    const pauseMs = retryMs || usagePause.stepMs;
    usagePause.until = now + pauseMs;
    const why = retryMs
      ? 'Retry-After'
      : `backoff step ${usagePause.stepMs / 1000} s`;
    console.log(
      `[usage] ${key}: upstream 429; pausing upstream calls for ${pauseMs / 1000} s (${why})`,
    );
  } else if (result.status >= 500) {
    console.error(`[usage] ${key}: upstream ${result.status}`);
  }
  return result;
}

// Write one usage response and settle the client's dashboard stats.
function sendUsage(res, client, status, headers, body) {
  client.lastStatus = status;
  client.active = Math.max(0, client.active - 1);
  if (status >= 400) stats.totals.errors++;
  const gone =
    res.destroyed || res.writableEnded || (res.socket && res.socket.destroyed);
  if (gone) return; // the client already left
  res.writeHead(status, { ...headers, 'content-length': body.length });
  res.end(body);
}

function sendCachedUsage(res, client, entry, kind) {
  const headers = {
    'x-proxy-cache': kind,
    age: String(Math.floor((Date.now() - entry.at) / 1000)),
  };
  if (entry.contentType) headers['content-type'] = entry.contentType;
  sendUsage(res, client, 200, headers, entry.body);
}

// Serve the usage entry if it is younger than USAGE_CACHE_MAX_STALE.
function serveStale(res, client, key, reason) {
  const entry = usageCache.get(key);
  if (!entry || Date.now() - entry.at >= USAGE_CACHE_MAX_STALE_MS) {
    return false;
  }
  usageStats.stale++;
  const age = Math.floor((Date.now() - entry.at) / 1000);
  console.log(`[usage] ${key}: serving stale (age ${age} s): ${reason}`);
  sendCachedUsage(res, client, entry, 'stale');
  return true;
}

function sendJsonUsage(res, client, status, obj, extra = {}) {
  sendUsage(
    res,
    client,
    status,
    {
      'content-type': 'application/json',
      'x-proxy-cache': 'miss',
      age: '0',
      ...extra,
    },
    Buffer.from(JSON.stringify(obj)),
  );
}

async function handleUsage(req, res, client) {
  const key = req.url;
  const entry = usageCache.get(key);
  if (entry && Date.now() - entry.at < USAGE_CACHE_TTL_MS) {
    usageStats.hit++;
    sendCachedUsage(res, client, entry, 'hit');
    return;
  }

  const pauseLeft = usagePause.until - Date.now();
  if (pauseLeft > 0) {
    if (serveStale(res, client, key, 'upstream paused after 429')) return;
    const secs = Math.max(1, Math.ceil(pauseLeft / 1000));
    sendJsonUsage(
      res,
      client,
      429,
      {
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message: `usage endpoint is rate limited; retry in ${secs} s`,
        },
      },
      { 'retry-after': String(secs) },
    );
    return;
  }

  // Single-flight: concurrent misses for one key share one upstream request.
  let pending = usageInflight.get(key);
  if (!pending) {
    pending = fetchUsage(req)
      .then((result) => recordUsageResult(key, result))
      .finally(() => usageInflight.delete(key));
    usageInflight.set(key, pending);
  }
  const result = await pending;

  if (result.kind === 'response' && result.status === 200) {
    usageStats.miss++;
    const headers = { 'x-proxy-cache': 'miss', age: '0' };
    if (result.headers['content-type'])
      headers['content-type'] = result.headers['content-type'];
    sendUsage(res, client, 200, headers, result.body);
    return;
  }

  const retryable =
    result.kind !== 'response' ||
    result.status === 429 ||
    result.status >= 500;
  const reason =
    result.kind === 'notoken'
      ? 'no upstream credentials'
      : result.kind === 'network'
        ? `upstream error: ${result.error.message}`
        : `upstream ${result.status}`;
  if (retryable && serveStale(res, client, key, reason)) return;

  if (result.kind === 'notoken') {
    sendJsonUsage(res, client, 502, { error: NO_TOKEN_MESSAGE });
  } else if (result.kind === 'network') {
    sendJsonUsage(res, client, 502, {
      error: 'bad gateway',
      detail: result.error.message,
    });
  } else {
    // Pass the upstream error through as is (status, headers, body).
    const headers = { ...result.headers };
    for (const h of HOP_BY_HOP) delete headers[h];
    headers['x-proxy-cache'] = 'miss';
    headers['age'] = '0';
    sendUsage(res, client, result.status, headers, result.body);
  }
}

// ---------------------------------------------------------------------------
// Dashboard snapshot + page
// ---------------------------------------------------------------------------
function snapshot() {
  const clients = [...stats.clients.entries()]
    .map(([ip, c]) => ({
      ip,
      firstSeen: c.firstSeen,
      lastSeen: c.lastSeen,
      requests: c.requests,
      inputTokens: c.inputTokens,
      outputTokens: c.outputTokens,
      cost: c.cost,
      active: c.active,
      models: [...c.models],
      lastModel: c.lastModel,
      lastPrompt: c.lastPrompt,
      lastStatus: c.lastStatus,
    }))
    .sort((a, b) => b.lastSeen - a.lastSeen);
  const byModel = [...stats.byModel.entries()]
    .map(([model, m]) => ({ model, ...m }))
    .sort((a, b) => b.cost - a.cost);
  return {
    now: Date.now(),
    serverStart,
    tokenSource: cache.source,
    tokenExpiresAt: cache.expiresAt || null,
    access: ACCESS_DURATION_MS
      ? {
          expired: accessExpired(),
          expiresAt: accessStart ? accessStart + ACCESS_DURATION_MS : null,
        }
      : null,
    totals: stats.totals,
    clients,
    byModel,
  };
}

// Self-contained page: no external assets (CSP-safe), polls /dashboard/data.
const DASHBOARD_HTML = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>claude-code-proxy · live</title>
<style>
:root{color-scheme:dark light}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#0c0d10;color:#e6e6e6}
header{padding:16px 20px;border-bottom:1px solid #23262d;display:flex;flex-wrap:wrap;gap:8px 24px;align-items:baseline}
h1{font-size:15px;margin:0;color:#c8a2ff;letter-spacing:.5px}
.dim{color:#8a8f98}
.wrap{padding:20px;max-width:1100px;margin:0 auto}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:22px}
.card{background:#14161b;border:1px solid #23262d;border-radius:10px;padding:14px 16px}
.card .k{font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:#8a8f98}
.card .v{font-size:22px;margin-top:4px;font-weight:600}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:#8a8f98;margin:26px 0 10px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #1c1f26;vertical-align:top}
th{color:#8a8f98;font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.5px}
td.num{text-align:right;font-variant-numeric:tabular-nums}
.badge{display:inline-block;padding:1px 7px;border-radius:20px;font-size:11px;background:#1c1f26}
.live{background:#0f3d2e;color:#4ade80}
.idle{color:#8a8f98}
.err{color:#f87171}
.prompt{color:#b9c0cc;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.note{color:#6b7280;font-size:12px;margin-top:26px;border-top:1px solid #1c1f26;padding-top:14px}
a{color:#c8a2ff}
</style></head><body>
<header>
  <h1>■ claude-code-proxy</h1>
  <span class="dim">live usage · <span id="clock">—</span></span>
  <span class="dim">token: <span id="tok">—</span></span>
  <span class="dim" id="accessline"></span>
</header>
<div class="wrap">
  <div class="cards" id="cards"></div>
  <h2>Connected clients</h2>
  <table><thead><tr>
    <th>Client IP</th><th>Status</th><th>Now / last</th>
    <th class="num">Reqs</th><th class="num">In tok</th><th class="num">Out tok</th><th class="num">Est. $</th>
  </tr></thead><tbody id="clients"></tbody></table>
  <h2>By model</h2>
  <table><thead><tr>
    <th>Model</th><th class="num">Reqs</th><th class="num">In tok</th><th class="num">Out tok</th><th class="num">Est. $</th>
  </tr></thead><tbody id="models"></tbody></table>
  <p class="note">
    "Est. $" = what this traffic would cost at public per-token <em>API</em> prices — a usage yardstick, not a real charge (your subscription is a flat fee).
    Account-level weekly/session limit % is not exposed by the Anthropic API, so it can't be shown here — check <span class="dim">/status</span> in your own CLI for that.
    Stats reset when the proxy restarts.
  </p>
</div>
<script>
const fmt=n=>n>=1e6?(n/1e6).toFixed(2)+'M':n>=1e3?(n/1e3).toFixed(1)+'k':String(n||0);
const usd=n=>'$'+(n||0).toFixed(n<1?4:2);
const ago=ms=>{const s=Math.round((Date.now()-ms)/1000);if(s<60)return s+'s ago';const m=Math.round(s/60);if(m<60)return m+'m ago';return Math.round(m/60)+'h ago';};
const esc=s=>(s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const secret=new URLSearchParams(location.search).get('secret')||'';
async function tick(){
  try{
    const r=await fetch('/dashboard/data'+(secret?'?secret='+encodeURIComponent(secret):''),{cache:'no-store'});
    if(!r.ok){document.getElementById('clock').textContent='auth error ('+r.status+')';return;}
    const d=await r.json();
    document.getElementById('clock').textContent=new Date(d.now).toLocaleTimeString();
    document.getElementById('tok').textContent=d.tokenSource+(d.tokenExpiresAt?' · exp '+new Date(d.tokenExpiresAt).toLocaleTimeString():'');
    const al=document.getElementById('accessline');
    al.textContent=d.access?('window: '+(d.access.expired?'EXPIRED':'expires '+new Date(d.access.expiresAt).toLocaleString())):'';
    al.className='dim'+(d.access&&d.access.expired?' err':'');
    const t=d.totals, activeClients=d.clients.filter(c=>c.active>0).length;
    document.getElementById('cards').innerHTML=[
      ['Active now',activeClients+' / '+d.clients.length],
      ['Requests',fmt(t.requests)],
      ['Input tok',fmt(t.inputTokens)],
      ['Output tok',fmt(t.outputTokens)],
      ['Est. $ (API-equiv)',usd(t.cost)],
      ['Blocked / errors',fmt(t.blocked)+' / '+fmt(t.errors)],
    ].map(([k,v])=>'<div class="card"><div class="k">'+k+'</div><div class="v">'+v+'</div></div>').join('');
    document.getElementById('clients').innerHTML=d.clients.map(c=>{
      const live=c.active>0;
      const status=live?'<span class="badge live">● '+c.active+' active</span>':'<span class="idle">idle</span>';
      const errbadge=(c.lastStatus&&c.lastStatus>=400)?' <span class="err">'+c.lastStatus+'</span>':'';
      const doing=live&&c.lastPrompt?'<div class="prompt" title="'+esc(c.lastPrompt)+'">“'+esc(c.lastPrompt)+'”</div>':'';
      return '<tr><td>'+esc(c.ip)+'<br><span class="dim">'+esc(c.lastModel||'—')+'</span>'+errbadge+'</td>'+
        '<td>'+status+doing+'</td>'+
        '<td class="dim">'+ago(c.lastSeen)+'</td>'+
        '<td class="num">'+fmt(c.requests)+'</td>'+
        '<td class="num">'+fmt(c.inputTokens)+'</td>'+
        '<td class="num">'+fmt(c.outputTokens)+'</td>'+
        '<td class="num">'+usd(c.cost)+'</td></tr>';
    }).join('')||'<tr><td colspan="7" class="dim">no clients yet</td></tr>';
    document.getElementById('models').innerHTML=d.byModel.map(m=>
      '<tr><td>'+esc(m.model)+'</td>'+
      '<td class="num">'+fmt(m.requests)+'</td>'+
      '<td class="num">'+fmt(m.inputTokens)+'</td>'+
      '<td class="num">'+fmt(m.outputTokens)+'</td>'+
      '<td class="num">'+usd(m.cost)+'</td></tr>'
    ).join('')||'<tr><td colspan="5" class="dim">no traffic yet</td></tr>';
  }catch(e){document.getElementById('clock').textContent='offline';}
}
tick();setInterval(tick,2000);
</script>
</body></html>`;

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
        expiresAt: accessStart
          ? new Date(accessStart + ACCESS_DURATION_MS).toISOString()
          : null,
      };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }

  // --- Live usage dashboard (secret-gated) --------------------------------
  // /dashboard      -> HTML page (auto-refreshes via its own fetch loop)
  // /dashboard/data -> JSON snapshot the page polls
  const parsedUrl = new URL(req.url, 'http://x');
  const pathname = parsedUrl.pathname;
  if (
    req.method === 'GET' &&
    (pathname === '/dashboard' || pathname === '/dashboard/data')
  ) {
    // Allow the secret via the header OR a ?secret= query param (so you can
    // just open a URL in a browser).
    const provided =
      req.headers[SECRET_HEADER] || parsedUrl.searchParams.get('secret') || '';
    if (!secretMatches(provided)) {
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end(
        'unauthorized: append ?secret=YOUR_SECRET or send the proxy-secret header',
      );
      return;
    }
    if (pathname === '/dashboard/data') {
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify(snapshot()));
    } else {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(DASHBOARD_HTML);
    }
    return;
  }

  // Gate every real request behind the shared secret.
  if (!secretMatches(req.headers[SECRET_HEADER])) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'unauthorized: missing or invalid proxy secret',
      }),
    );
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
        }),
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
  const decision = [modelDecision(model), effortDecision(effort)].find(
    (d) => !d.ok,
  );
  if (decision) {
    console.log(
      `[policy] blocked ${req.method} ${req.url} -> ${decision.reason}`,
    );
    stats.totals.blocked++;
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        type: 'error',
        error: { type: 'forbidden', message: decision.reason },
      }),
    );
    return;
  }

  // Record this authenticated, allowed request against its client for the dashboard.
  const ip = clientKey(req);
  const client = getClient(ip);
  client.lastSeen = Date.now();
  client.requests++;
  client.active++;
  stats.totals.requests++;
  if (model) {
    client.lastModel = model;
    client.models.add(model);
    const bm = stats.byModel.get(model) || {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
    };
    bm.requests++;
    stats.byModel.set(model, bm);
  }
  const preview = promptPreview(body, req.headers['content-type']);
  if (preview) client.lastPrompt = preview;

  // The usage endpoint is served from a shared cache (a hit needs no token).
  if (USAGE_CACHE && req.method === 'GET' && pathname === USAGE_PATH) {
    await handleUsage(req, res, client);
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
    res.end(JSON.stringify({ error: NO_TOKEN_MESSAGE }));
    return;
  }

  const headers = buildUpstreamHeaders(req.headers, token);
  // We forward a fixed buffer, so set an accurate content-length.
  if (body.length > 0) headers['content-length'] = Buffer.byteLength(body);
  else delete headers['content-length'];

  const upstreamReq = upstreamRequest(
    {
      method: req.method,
      path: req.url,
      headers,
    },
    (upstreamRes) => {
      // Mirror status + headers, then stream the body straight through.
      const code = upstreamRes.statusCode || 502;
      client.lastStatus = code;
      if (code >= 400) stats.totals.errors++;
      res.writeHead(code, upstreamRes.headers);
      // Flush headers immediately so SSE clients start receiving without delay.
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      // Sniff the stream for usage totals (does not buffer — bytes still flow).
      tapUsage(upstreamRes, client, model);
      upstreamRes.pipe(res);
    },
  );

  upstreamReq.on('error', (err) => {
    console.error(`[upstream] ${err.message}`);
    client.active = Math.max(0, client.active - 1);
    stats.totals.errors++;
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
  const port = server.address().port; // bound port (PORT=0 picks a free one)
  console.log(`[proxy] listening on http://${HOST}:${port}`);
  console.log(
    `[proxy] forwarding to ${UPSTREAM_PROTOCOL}://${UPSTREAM_HOST}:${UPSTREAM_PORT}`,
  );
  console.log(`[proxy] shared-secret header: ${SECRET_HEADER}`);
  console.log(
    `[proxy] dashboard: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${port}/dashboard?secret=YOUR_SECRET`,
  );
  if (ALLOWED_MODELS.length)
    console.log(`[proxy] model allowlist: ${ALLOWED_MODELS.join(', ')}`);
  if (BLOCKED_MODELS.length)
    console.log(`[proxy] model blocklist: ${BLOCKED_MODELS.join(', ')}`);
  if (MAX_EFFORT) console.log(`[proxy] max effort: ${MAX_EFFORT}`);
  if (USAGE_CACHE) {
    console.log(
      `[proxy] usage cache: ttl ${USAGE_CACHE_TTL_MS / 1000} s, max stale ${USAGE_CACHE_MAX_STALE_MS / 1000} s, ` +
        `429 backoff ${USAGE_BACKOFF_BASE_MS / 1000}-${USAGE_BACKOFF_MAX_MS / 1000} s, user-agent ${USAGE_USER_AGENT}`,
    );
  } else {
    console.log('[proxy] usage cache: off (USAGE_CACHE=false)');
  }
  if (ACCESS_DURATION_MS) {
    loadAccessStart();
    if (ACCESS_START_MODE === 'server-start') startAccessWindow();
    const ms = ACCESS_DURATION_MS;
    const dur =
      ms % 86400000 === 0
        ? `${ms / 86400000}d`
        : ms % 3600000 === 0
          ? `${ms / 3600000}h`
          : ms % 60000 === 0
            ? `${ms / 60000}m`
            : `${ms / 1000}s`;
    if (accessStart) {
      const exp = new Date(accessStart + ACCESS_DURATION_MS).toISOString();
      console.log(
        `[proxy] access window: ${dur} (${accessExpired() ? 'EXPIRED' : `expires ${exp}`})`,
      );
    } else {
      console.log(`[proxy] access window: ${dur}, starts on first use`);
    }
  }
  if (cache.token) {
    const exp = cache.expiresAt
      ? ` (expires ${new Date(cache.expiresAt).toISOString()})`
      : '';
    console.log(`[proxy] OAuth token discovered from ${cache.source}${exp}`);
  } else {
    console.warn(
      `[proxy] WARNING: no OAuth token found yet. Log into Claude Code on this machine ` +
        `(checked ${EXPLICIT_TOKEN ? 'ANTHROPIC_OAUTH_TOKEN' : CREDS_PATH}), or set ANTHROPIC_OAUTH_TOKEN.`,
    );
  }
});
