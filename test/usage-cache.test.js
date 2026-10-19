'use strict';

// Pins the GET /api/oauth/usage cache: TTL hits, single-flight, stale on
// 429 / 5xx / network errors, the global 429 pause and its escalation.
// Each scenario starts a fresh proxy so no cache or pause state carries over.

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  TEST_TIMEOUT_MS,
  TOKEN,
  startFakeUpstream,
  startProxy,
} = require('./helpers/harness');

const timeout = { timeout: TEST_TIMEOUT_MS };
const USAGE = '/api/oauth/usage';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const usageBody = (n) => JSON.stringify({ five_hour: { utilization: n } });

// Answer with a usage 200 whose body carries the upstream call number.
function okHandler(upstream) {
  return (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'x-up': 'ok' });
    res.end(usageBody(upstream.requests.length));
  };
}

function statusHandler(status, headers = {}) {
  return (req, res) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify({ upstream: status }));
  };
}

// Shared fake upstream and the proxy of the running scenario. Scenarios are
// split over several describes so each stays inside TEST_TIMEOUT_MS.
let upstream;
let proxy;

before(async () => {
  upstream = await startFakeUpstream();
}, timeout);

after(async () => {
  if (upstream) await upstream.close();
}, timeout);

afterEach(async () => {
  if (proxy) await proxy.stop();
  proxy = null;
  upstream.reset();
}, timeout);

async function start(env = {}) {
  upstream.handler = okHandler(upstream);
  proxy = await startProxy({
    upstreamPort: upstream.port,
    env: { USAGE_CACHE_TTL: '5', USAGE_BACKOFF_BASE: '1', ...env },
  });
  return proxy;
}

const get = (p = USAGE, opts = {}) => proxy.request({ path: p, ...opts });

// Fill the cache, then let the entry go past its TTL.
async function primeAndExpire(ttlMs) {
  const first = await get();
  assert.equal(first.status, 200);
  assert.equal(first.headers['x-proxy-cache'], 'miss');
  await sleep(ttlMs + 150);
  return first;
}

describe('usage cache: hits and keys', timeout, () => {
  it('serves a hit within the TTL with one upstream call', async () => {
    await start();
    const first = await get();
    const second = await get();
    assert.equal(upstream.requests.length, 1);
    assert.equal(first.status, 200);
    assert.equal(first.headers['x-proxy-cache'], 'miss');
    assert.equal(first.headers.age, '0');
    assert.equal(first.headers['content-type'], 'application/json');
    assert.equal(second.status, 200);
    assert.equal(second.headers['x-proxy-cache'], 'hit');
    assert.match(second.headers.age, /^\d+$/);
    assert.equal(second.headers['content-type'], 'application/json');
    assert.equal(second.headers['x-up'], undefined); // content-type only
    assert.equal(second.body, first.body);
    assert.equal(second.headers['content-length'], String(first.body.length));
  });

  it('refreshes from upstream once the TTL has passed', async () => {
    await start({ USAGE_CACHE_TTL: '0.2' });
    await primeAndExpire(200);
    const res = await get();
    assert.equal(res.headers['x-proxy-cache'], 'miss');
    assert.equal(res.body, usageBody(2));
    assert.equal(upstream.requests.length, 2);
  });

  it('injects the User-Agent, identity encoding and the OAuth token', async () => {
    await start({ USAGE_USER_AGENT: 'claude-code/9.9.9' });
    await get(USAGE, {
      headers: { 'user-agent': 'ClaudeBar/1.0', 'accept-encoding': 'gzip' },
    });
    const up = upstream.requests[0];
    assert.equal(up.method, 'GET');
    assert.equal(up.url, USAGE);
    assert.equal(up.headers['user-agent'], 'claude-code/9.9.9');
    assert.equal(up.headers['accept-encoding'], 'identity');
    assert.equal(up.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(up.headers['anthropic-beta'], 'oauth-2025-04-20');
    assert.equal(up.headers['x-proxy-secret'], undefined);
  });

  it('defaults the User-Agent to claude-code/2.1.0', async () => {
    await start();
    await get(USAGE, { headers: { 'user-agent': 'ClaudeBar/1.0' } });
    assert.equal(
      upstream.requests[0].headers['user-agent'],
      'claude-code/2.1.0',
    );
  });

  it('coalesces concurrent misses into one upstream call', async () => {
    await start();
    upstream.handler = (req, res) =>
      setTimeout(() => okHandler(upstream)(req, res), 300);
    const results = await Promise.all(Array.from({ length: 5 }, () => get()));
    assert.equal(upstream.requests.length, 1);
    for (const r of results) {
      assert.equal(r.status, 200);
      assert.equal(r.headers['x-proxy-cache'], 'miss');
      assert.equal(r.body, usageBody(1));
    }
  });

  it('keys the cache by path and query', async () => {
    await start();
    const a = await get(`${USAGE}?a=1`);
    const b = await get(`${USAGE}?a=2`);
    const a2 = await get(`${USAGE}?a=1`);
    assert.equal(upstream.requests.length, 2);
    assert.equal(upstream.requests[1].url, `${USAGE}?a=2`);
    assert.notEqual(a.body, b.body);
    assert.equal(a2.headers['x-proxy-cache'], 'hit');
    assert.equal(a2.body, a.body);
  });

});

describe('usage cache: stale on errors', timeout, () => {
  it('serves the stale entry as 200 when upstream answers 429', async () => {
    await start({ USAGE_CACHE_TTL: '0.2' });
    const first = await primeAndExpire(200);
    upstream.handler = statusHandler(429);
    const res = await get();
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-proxy-cache'], 'stale');
    assert.match(res.headers.age, /^\d+$/);
    assert.equal(res.body, first.body);
    assert.equal(upstream.requests.length, 2);
    await proxy.waitForOutput(/\[usage\] .*upstream 429/);
  });

  it('serves stale on an upstream 5xx', async () => {
    await start({ USAGE_CACHE_TTL: '0.2' });
    const first = await primeAndExpire(200);
    upstream.handler = statusHandler(503);
    const res = await get();
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-proxy-cache'], 'stale');
    assert.equal(res.body, first.body);
  });

  it('serves stale when the upstream drops the connection before headers', async () => {
    await start({ USAGE_CACHE_TTL: '0.2' });
    const first = await primeAndExpire(200);
    upstream.handler = (req) => req.socket.destroy();
    const res = await get();
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-proxy-cache'], 'stale');
    assert.equal(res.body, first.body);
  });

  it('answers 502 bad gateway on a network error with no cache', async () => {
    await start();
    upstream.handler = (req) => req.socket.destroy();
    const res = await get();
    assert.equal(res.status, 502);
    assert.equal(JSON.parse(res.body).error, 'bad gateway');
    assert.equal(res.headers['x-proxy-cache'], 'miss');
    assert.equal(res.headers.age, '0');
  });

  // 200 with content-length 100, one byte sent, then the socket is destroyed.
  const partialHandler = (req, res) => {
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': '100',
    });
    res.write('{');
    setTimeout(() => res.socket.destroy(), 50);
  };

  it('serves stale on a partial body and keeps the cached entry', async () => {
    await start({ USAGE_CACHE_TTL: '0.2' });
    const first = await primeAndExpire(200);
    upstream.handler = partialHandler;
    const res = await get();
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-proxy-cache'], 'stale');
    assert.equal(res.body, first.body);
    // The partial body did not replace the entry.
    const again = await get();
    assert.equal(again.headers['x-proxy-cache'], 'stale');
    assert.equal(again.body, first.body);
  });

  it('answers 502 on a partial body with no cache and caches nothing', async () => {
    await start();
    upstream.handler = partialHandler;
    const res = await get();
    assert.equal(res.status, 502);
    assert.equal(JSON.parse(res.body).error, 'bad gateway');
    upstream.handler = okHandler(upstream);
    const next = await get();
    assert.equal(next.status, 200);
    assert.equal(next.headers['x-proxy-cache'], 'miss');
    assert.equal(next.body, usageBody(2));
  });

});

describe('usage cache: pass-through', timeout, () => {
  it('passes an upstream 429 through as is when nothing is cached', async () => {
    await start();
    upstream.handler = statusHandler(429, { 'x-up': 'limited' });
    const res = await get();
    assert.equal(res.status, 429);
    assert.equal(res.body, JSON.stringify({ upstream: 429 }));
    assert.equal(res.headers['x-up'], 'limited');
    assert.equal(res.headers['x-proxy-cache'], 'miss');
    assert.equal(res.headers.age, '0');
  });

  it('does not cache non-200 answers', async () => {
    await start();
    upstream.handler = statusHandler(404);
    const notFound = await get();
    assert.equal(notFound.status, 404);
    upstream.handler = statusHandler(500);
    const failed = await get();
    assert.equal(failed.status, 500);
    upstream.handler = okHandler(upstream);
    const ok = await get();
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['x-proxy-cache'], 'miss');
    assert.equal(upstream.requests.length, 3);
  });

  it('passes 401 through instead of serving stale', async () => {
    await start({ USAGE_CACHE_TTL: '0.2' });
    await primeAndExpire(200);
    upstream.handler = statusHandler(401);
    const res = await get();
    assert.equal(res.status, 401);
    assert.equal(res.headers['x-proxy-cache'], 'miss');
  });

  it('requires the secret and never leaks a cached body', async () => {
    await start();
    const first = await get();
    const res = await get(USAGE, { secret: false });
    assert.equal(res.status, 401);
    assert.match(JSON.parse(res.body).error, /unauthorized/);
    assert.ok(!res.body.includes(first.body));
    assert.equal(res.headers['x-proxy-cache'], undefined);
    assert.equal(upstream.requests.length, 1);
  });

});

describe('usage cache: 429 pause', timeout, () => {
  it('pauses upstream after a 429 and doubles the pause on the next one', async () => {
    await start({ USAGE_BACKOFF_BASE: '1', USAGE_BACKOFF_MAX: '10' });
    upstream.handler = statusHandler(429);

    assert.equal((await get()).status, 429); // upstream call 1; pause 1 s
    const blocked = await get();
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers['retry-after'], '1');
    assert.equal(blocked.headers['x-proxy-cache'], 'miss');
    assert.equal(blocked.headers.age, '0');
    assert.equal(JSON.parse(blocked.body).error.type, 'rate_limit_error');
    assert.equal(upstream.requests.length, 1);

    await sleep(1400);
    assert.equal((await get()).status, 429); // upstream call 2; pause 2 s
    assert.equal(upstream.requests.length, 2);

    await sleep(1400);
    const still = await get(); // 1.4 s into a 2 s pause
    assert.equal(still.status, 429);
    assert.equal(still.headers['retry-after'], '1');
    assert.equal(upstream.requests.length, 2);

    await sleep(1000);
    await get(); // pause over
    assert.equal(upstream.requests.length, 3);
  });

  it('serves stale during the pause without calling upstream', async () => {
    await start({ USAGE_CACHE_TTL: '0.2', USAGE_BACKOFF_BASE: '5' });
    const first = await primeAndExpire(200);
    upstream.handler = statusHandler(429);
    assert.equal((await get()).headers['x-proxy-cache'], 'stale');
    const paused = await get();
    assert.equal(paused.status, 200);
    assert.equal(paused.headers['x-proxy-cache'], 'stale');
    assert.equal(paused.body, first.body);
    assert.equal(upstream.requests.length, 2);
  });

});

describe('usage cache: Retry-After and reset', timeout, () => {
  it('uses a future Retry-After as the pause length', async () => {
    await start({ USAGE_BACKOFF_BASE: '0.2', USAGE_BACKOFF_MAX: '10' });
    upstream.handler = statusHandler(429, { 'retry-after': '2' });
    await get();
    await sleep(700); // well past the 0.2 s backoff step
    const blocked = await get();
    assert.equal(blocked.status, 429);
    assert.match(blocked.headers['retry-after'], /^[12]$/);
    assert.equal(upstream.requests.length, 1);
    await sleep(1700);
    await get();
    assert.equal(upstream.requests.length, 2);
  });

  it('keeps the longer pause on a later 429 for another key', async () => {
    await start({ USAGE_BACKOFF_MAX: '1200' });
    // ?a=1 gets Retry-After 600 at once; ?a=2 gets Retry-After 1 slightly
    // later, while both fetches are in flight.
    upstream.handler = (req, res) => {
      const long = req.url.endsWith('?a=1');
      const answer = statusHandler(429, { 'retry-after': long ? '600' : '1' });
      setTimeout(() => answer(req, res), long ? 0 : 200);
    };
    const started = Date.now();
    const [a, b] = await Promise.all([
      get(`${USAGE}?a=1`),
      get(`${USAGE}?a=2`),
    ]);
    assert.equal(a.status, 429);
    assert.equal(b.status, 429);
    assert.equal(upstream.requests.length, 2);
    const snap = JSON.parse((await get('/dashboard/data')).body);
    assert.ok(snap.usage.pausedUntil >= started + 600000, 'keeps 600 s');
    await sleep(1300); // past the 1 s Retry-After
    const blocked = await get(`${USAGE}?a=3`);
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers['retry-after']) > 500);
    assert.equal(upstream.requests.length, 2);
  });

  it('falls back to the backoff step on a past Retry-After date', async () => {
    await start({ USAGE_BACKOFF_BASE: '0.3', USAGE_BACKOFF_MAX: '10' });
    upstream.handler = statusHandler(429, {
      'retry-after': new Date(Date.now() - 60000).toUTCString(),
    });
    await get();
    assert.equal((await get()).status, 429);
    assert.equal(upstream.requests.length, 1);
    await sleep(600);
    await get();
    assert.equal(upstream.requests.length, 2);
  });

  it('resets the escalation after a 200', async () => {
    await start({
      USAGE_CACHE_TTL: '0.1',
      USAGE_BACKOFF_BASE: '0.5',
      USAGE_BACKOFF_MAX: '10',
    });
    upstream.handler = statusHandler(429);
    await get(); // pause 0.5 s
    await sleep(800);
    await get(); // pause 1 s
    assert.equal(upstream.requests.length, 2);
    await sleep(1300);
    upstream.handler = okHandler(upstream);
    assert.equal((await get()).status, 200); // resets the step
    await sleep(250);
    upstream.handler = statusHandler(429);
    await get(); // pause back to 0.5 s (2 s without the reset)
    assert.equal(upstream.requests.length, 4);
    await sleep(1000);
    await get();
    assert.equal(upstream.requests.length, 5);
  });

});

describe('usage cache: limits and opt-out', timeout, () => {
  it('does not serve stale older than USAGE_CACHE_MAX_STALE', async () => {
    await start({ USAGE_CACHE_TTL: '0.1', USAGE_CACHE_MAX_STALE: '0.4' });
    await get();
    await sleep(700);
    upstream.handler = statusHandler(429);
    const res = await get();
    assert.equal(res.status, 429);
    assert.equal(res.body, JSON.stringify({ upstream: 429 }));
    assert.equal(res.headers['x-proxy-cache'], 'miss');
  });

  it('forwards every request untouched when USAGE_CACHE=false', async () => {
    await start({ USAGE_CACHE: 'false' });
    const opts = { headers: { 'user-agent': 'ClaudeBar/1.0' } };
    const first = await get(USAGE, opts);
    const second = await get(USAGE, opts);
    assert.equal(upstream.requests.length, 2);
    assert.equal(first.status, 200);
    assert.equal(second.body, usageBody(2));
    assert.equal(second.headers['x-proxy-cache'], undefined);
    assert.equal(second.headers['x-up'], 'ok');
    assert.equal(upstream.requests[1].headers['user-agent'], 'ClaudeBar/1.0');
    assert.match(proxy.output, /usage cache: off/);
  });

  it('leaves other paths uncached', async () => {
    await start();
    await proxy.request({ path: '/api/oauth/profile' });
    await proxy.request({ path: '/api/oauth/profile' });
    assert.equal(upstream.requests.length, 2);
  });
});

describe('usage cache configuration', timeout, () => {
  for (const [name, value] of [
    ['USAGE_CACHE', 'maybe'],
    ['USAGE_CACHE_TTL', 'abc'],
    ['USAGE_CACHE_MAX_STALE', '0'],
    ['USAGE_BACKOFF_BASE', '-1'],
    ['USAGE_BACKOFF_MAX', 'Infinity'],
  ]) {
    it(`fails at startup on ${name}=${value}`, async () => {
      await assert.rejects(
        startProxy({ env: { [name]: value } }),
        (err) =>
          err.code === 1 && new RegExp(`\\[config\\] ${name}`).test(err.output),
      );
    });
  }
});
