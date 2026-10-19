'use strict';

// Pins the usage-cache block of the dashboard: the `usage` object in
// /dashboard/data and how the /dashboard page renders it. The page script is
// run in a vm against a minimal fake DOM, fed the proxy's real snapshot.

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {
  TEST_TIMEOUT_MS,
  startFakeUpstream,
  startProxy,
} = require('./helpers/harness');

const timeout = { timeout: TEST_TIMEOUT_MS };
const USAGE = '/api/oauth/usage';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function okHandler(req, res) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ five_hour: { utilization: 1 } }));
}

function rateLimitHandler(req, res) {
  res.writeHead(429, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ upstream: 429 }));
}

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
  upstream.handler = okHandler;
  proxy = await startProxy({ upstreamPort: upstream.port, env });
  return proxy;
}

const get = (p = USAGE) => proxy.request({ path: p });

async function data() {
  const res = await get('/dashboard/data');
  assert.equal(res.status, 200);
  return JSON.parse(res.body);
}

async function usage() {
  return (await data()).usage;
}

// Run the dashboard page script once against a fake DOM and the given
// snapshot; returns the fake elements by id.
async function renderPage(snapshot) {
  const page = await get('/dashboard');
  assert.equal(page.status, 200);
  const script = page.body.match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = {};
  const byId = (id) =>
    (elements[id] ||= { textContent: '', innerHTML: '', className: '' });
  const context = {
    document: { getElementById: byId },
    location: { search: '' },
    URLSearchParams,
    fetch: async () => ({ ok: true, json: async () => snapshot }),
    setInterval: () => 0,
  };
  vm.runInNewContext(script, context);
  for (let i = 0; i < 20 && !byId('clock').textContent; i++) {
    await new Promise((r) => setImmediate(r));
  }
  assert.notEqual(elements.clock.textContent, 'offline');
  assert.ok(elements.clock.textContent, 'page script never finished a tick');
  return elements;
}

describe('dashboard data: usage cache', timeout, () => {
  it('reports config and zero counters on a fresh proxy', async () => {
    await start({ USAGE_CACHE_TTL: '5', USAGE_CACHE_MAX_STALE: '120' });
    assert.deepEqual(await usage(), {
      enabled: true,
      ttlMs: 5000,
      maxStaleMs: 120000,
      hit: 0,
      miss: 0,
      stale: 0,
      rateLimited: 0,
      fetches: 0,
      pausedUntil: null,
      pauseStepMs: 0,
    });
  });

  it('counts miss, hit, upstream 429, stale and fetches', async () => {
    await start({ USAGE_CACHE_TTL: '0.2', USAGE_BACKOFF_BASE: '5' });
    await get(); // miss, fetch 1
    await get(); // hit
    let u = await usage();
    assert.equal(u.miss, 1);
    assert.equal(u.hit, 1);
    assert.equal(u.fetches, 1);
    assert.equal(u.rateLimited, 0);
    assert.equal(u.pausedUntil, null);

    await sleep(350);
    upstream.handler = rateLimitHandler;
    const before429 = Date.now();
    assert.equal((await get()).headers['x-proxy-cache'], 'stale'); // fetch 2
    assert.equal((await get()).headers['x-proxy-cache'], 'stale'); // paused
    u = await usage();
    assert.equal(u.miss, 1);
    assert.equal(u.hit, 1);
    assert.equal(u.stale, 2);
    assert.equal(u.rateLimited, 1);
    assert.equal(u.fetches, 2);
    assert.equal(u.pauseStepMs, 5000);
    assert.ok(u.pausedUntil >= before429 + 5000, 'pause ends ~5 s out');
    assert.ok(u.pausedUntil <= Date.now() + 5000);
  });

  it('shows the pause step doubling and the reset after a 200', async () => {
    await start({ USAGE_BACKOFF_BASE: '0.5', USAGE_BACKOFF_MAX: '10' });
    upstream.handler = rateLimitHandler;
    await get(); // 429 -> step 0.5 s
    let u = await usage();
    assert.equal(u.pauseStepMs, 500);
    assert.ok(u.pausedUntil);

    await sleep(650);
    u = await usage();
    assert.equal(u.pausedUntil, null, 'pause over');
    assert.equal(u.pauseStepMs, 500, 'step kept until a 200');

    await get(); // 429 -> step 1 s
    u = await usage();
    assert.equal(u.pauseStepMs, 1000);
    assert.equal(u.rateLimited, 2);

    await sleep(1150);
    upstream.handler = okHandler;
    assert.equal((await get()).status, 200);
    u = await usage();
    assert.equal(u.pauseStepMs, 0);
    assert.equal(u.pausedUntil, null);
    assert.equal(u.fetches, 3);
  });

  it('reports the cache as off and counts nothing when USAGE_CACHE=false', async () => {
    await start({ USAGE_CACHE: 'false' });
    await get();
    await get();
    const u = await usage();
    assert.equal(u.enabled, false);
    for (const k of ['hit', 'miss', 'stale', 'rateLimited', 'fetches']) {
      assert.equal(u[k], 0, k);
    }
    assert.equal(upstream.requests.length, 2);
  });
});

describe('dashboard page: usage cache', timeout, () => {
  it('renders the counters and no pause card when not paused', async () => {
    await start({ USAGE_CACHE_TTL: '5', USAGE_CACHE_MAX_STALE: '120' });
    await get();
    await get();
    const el = await renderPage(await data());
    assert.match(el.usagecfg.textContent, /ttl 5 s · max stale 120 s/);
    const html = el.usagecards.innerHTML;
    assert.match(html, /Hit \/ miss \/ stale<\/div><div class="v">1 \/ 1 \/ 0</);
    assert.match(html, /Upstream fetches<\/div><div class="v">1</);
    assert.match(html, /Upstream 429s<\/div><div class="v">0</);
    assert.doesNotMatch(html, /paused/i);
  });

  it('renders the pause end while upstream is paused', async () => {
    await start({ USAGE_BACKOFF_BASE: '30' });
    upstream.handler = rateLimitHandler;
    await get();
    const snap = await data();
    assert.ok(snap.usage.pausedUntil);
    const el = await renderPage(snap);
    const html = el.usagecards.innerHTML;
    assert.match(html, /Upstream 429s<\/div><div class="v">1</);
    assert.match(
      html,
      /Upstream paused until<\/div><div class="v err">[^<]+\((29|30)s\)</,
    );
  });

  it('renders the cache as off when USAGE_CACHE=false', async () => {
    await start({ USAGE_CACHE: 'false' });
    const el = await renderPage(await data());
    assert.match(el.usagecfg.textContent, /off \(USAGE_CACHE=false\)/);
    assert.equal(el.usagecards.innerHTML, '');
  });
});
