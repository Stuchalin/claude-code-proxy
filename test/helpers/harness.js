'use strict';

// Test harness: spawns server.js as a child process against an in-process
// fake upstream (plain HTTP). Shared by every test file; no dependencies.

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVER_JS = path.join(__dirname, '..', '..', 'server.js');
const SECRET = 'test-secret';
const TOKEN = 'fake-token'; // placeholder, not a real credential
// Upper bound for one suite, test or hook. Pass it as node:test's `timeout`
// option (added in v18.7.0; `--test-timeout` needs Node 20.11+, so it is not
// used) so a hung proxy or upstream fails the run instead of stalling it.
const TEST_TIMEOUT_MS = 15000;

// Every env name server.js reads. Each is set explicitly (empty unless a
// default or override gives it a value) so neither the developer's shell nor
// a local .env file can leak policy into a test: the .env loader only fills
// names that are absent from the environment.
const SERVER_SOURCE = fs.readFileSync(SERVER_JS, 'utf8');
const SERVER_ENV_NAMES = [
  ...new Set(
    [...SERVER_SOURCE.matchAll(/process\.env\.(\w+)/g)].map((m) => m[1]),
  ),
];

const live = new Set(); // spawned proxies not yet stopped
process.on('exit', () => {
  for (const child of live) child.kill('SIGKILL');
});

// Start a fake upstream. `handler(req, res, record)` answers each request
// after its body is read; `record` is { method, url, headers, body } and is
// also pushed to `upstream.requests`. Swap the handler per test with
// `upstream.handler = fn` and clear the log with `upstream.reset()`.
async function startFakeUpstream(handler) {
  const upstream = {
    requests: [],
    handler: handler || defaultHandler,
    port: 0,
    reset() {
      this.requests.length = 0;
      this.handler = defaultHandler;
    },
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const record = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      upstream.requests.push(record);
      upstream.handler(req, res, record);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  upstream.port = server.address().port;
  return upstream;
}

function defaultHandler(req, res) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

// Spawn the proxy pointed at `upstreamPort`. `env` overrides any variable
// (string values, e.g. { USAGE_CACHE_TTL: '0.2' }). Resolves once the proxy
// logs its bound port; rejects with err.code / err.output if it exits first.
function startProxy({ upstreamPort, env = {}, timeoutMs = 5000 } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-test-'));
  const childEnv = { ...process.env };
  for (const name of SERVER_ENV_NAMES) childEnv[name] = '';
  Object.assign(
    childEnv,
    {
      PORT: '0',
      HOST: '127.0.0.1',
      PROXY_SECRET: SECRET,
      ANTHROPIC_OAUTH_TOKEN: TOKEN,
      AUTO_REFRESH: 'false',
      CLAUDE_CREDENTIALS_PATH: path.join(tmp, 'credentials.json'),
      ACCESS_STATE_FILE: path.join(tmp, 'access-start'),
      UPSTREAM_HOST: '127.0.0.1',
      UPSTREAM_PROTOCOL: 'http',
      UPSTREAM_PORT: upstreamPort ? String(upstreamPort) : '',
    },
    env,
  );

  const child = spawn(process.execPath, [SERVER_JS], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  live.add(child);
  let output = '';
  const exited = new Promise((resolve) =>
    child.once('exit', (code, signal) => {
      live.delete(child);
      fs.rmSync(tmp, { recursive: true, force: true });
      resolve({ code, signal });
    }),
  );

  const proxy = {
    child,
    port: 0,
    get output() {
      return output;
    },
    // Resolve once the proxy's stdout/stderr matches `re` (logs arrive async).
    async waitForOutput(re, waitMs = 2000) {
      const deadline = Date.now() + waitMs;
      while (!re.test(output)) {
        if (Date.now() > deadline) {
          throw new Error(`proxy output never matched ${re}:\n${output}`);
        }
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    // Request helper bound to this proxy; sends the secret unless told not to.
    request(opts = {}) {
      const headers = { ...(opts.headers || {}) };
      if (opts.secret !== false) headers['x-proxy-secret'] = SECRET;
      return request(proxy.port, { ...opts, headers });
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        const t = setTimeout(() => child.kill('SIGKILL'), 2000);
        await exited;
        clearTimeout(t);
      }
    },
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`proxy did not start in ${timeoutMs} ms:\n${output}`));
    }, timeoutMs);
    const onData = (chunk) => {
      output += chunk;
      const m = output.match(/\[proxy\] listening on http:\/\/[^\s]+:(\d+)/);
      if (m && !proxy.port) {
        proxy.port = Number(m[1]);
        clearTimeout(timer);
        resolve(proxy);
      }
    };
    child.stdout.setEncoding('utf8').on('data', onData);
    child.stderr.setEncoding('utf8').on('data', (c) => (output += c));
    exited.then(({ code, signal }) => {
      if (proxy.port) return;
      clearTimeout(timer);
      const err = new Error(
        `proxy exited before listening (code ${code}, signal ${signal}):\n${output}`,
      );
      err.code = code;
      err.output = output;
      reject(err);
    });
  });
}

// Minimal HTTP client. Resolves { status, headers, body } (body as a string).
// Rejects (and destroys the request) if the whole exchange exceeds timeoutMs.
function request(
  port,
  {
    method = 'GET',
    path: p = '/',
    headers = {},
    body,
    timeoutMs = 5000,
  } = {},
) {
  return new Promise((done, fail) => {
    let timer;
    const resolve = (v) => (clearTimeout(timer), done(v));
    const reject = (e) => (clearTimeout(timer), fail(e));
    const payload =
      body === undefined
        ? null
        : Buffer.isBuffer(body)
          ? body
          : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const h = { ...headers };
    if (payload) h['content-length'] = payload.length;
    const req = http.request(
      { host: '127.0.0.1', port, method, path: p, headers: h, agent: false },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', reject);
      },
    );
    timer = setTimeout(
      () =>
        req.destroy(
          new Error(`request ${method} ${p} timed out after ${timeoutMs} ms`),
        ),
      timeoutMs,
    );
    req.on('error', reject);
    req.end(payload || undefined);
  });
}

module.exports = {
  SECRET,
  TEST_TIMEOUT_MS,
  TOKEN,
  startFakeUpstream,
  startProxy,
  request,
};
