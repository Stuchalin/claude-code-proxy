'use strict';

// Pins the existing pass-through behavior against a fake upstream.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  TEST_TIMEOUT_MS,
  TOKEN,
  startFakeUpstream,
  startProxy,
} = require('./helpers/harness');

const timeout = { timeout: TEST_TIMEOUT_MS };

describe('pass-through proxy', timeout, () => {
  let upstream;
  let proxy;

  before(async () => {
    upstream = await startFakeUpstream();
    proxy = await startProxy({ upstreamPort: upstream.port });
  }, timeout);

  after(async () => {
    if (proxy) await proxy.stop();
    if (upstream) await upstream.close();
  }, timeout);

  beforeEach(() => upstream.reset());

  it('logs the bound port when started with PORT=0', async () => {
    assert.ok(proxy.port > 0);
    assert.match(
      proxy.output,
      new RegExp(`listening on http://127\\.0\\.0\\.1:${proxy.port}\\b`),
    );
    await proxy.waitForOutput(
      new RegExp(`forwarding to http://127\\.0\\.0\\.1:${upstream.port}\\b`),
    );
  });

  it('rejects a request without the secret with 401 and never calls upstream', async () => {
    const res = await proxy.request({
      method: 'POST',
      path: '/v1/messages',
      secret: false,
      headers: { 'content-type': 'application/json' },
      body: { model: 'claude-sonnet-4-5' },
    });
    assert.equal(res.status, 401);
    assert.match(JSON.parse(res.body).error, /unauthorized/);
    assert.equal(upstream.requests.length, 0);
  });

  it('forwards POST /v1/messages with the OAuth token, beta flag and intact body', async () => {
    upstream.handler = (req, res) => {
      res.writeHead(201, { 'content-type': 'application/json', 'x-up': '1' });
      res.end('{"id":"msg_1"}');
    };
    const body = JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'héllo' }],
    });
    const res = await proxy.request({
      method: 'POST',
      path: '/v1/messages?beta=true',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer client-token',
        'x-api-key': 'client-key',
        'anthropic-beta': 'foo-2025-01-01',
      },
      body,
    });

    assert.equal(res.status, 201);
    assert.equal(res.headers['x-up'], '1');
    assert.equal(res.body, '{"id":"msg_1"}');

    assert.equal(upstream.requests.length, 1);
    const up = upstream.requests[0];
    assert.equal(up.method, 'POST');
    assert.equal(up.url, '/v1/messages?beta=true');
    assert.equal(up.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(up.headers['x-api-key'], undefined);
    assert.equal(up.headers['x-proxy-secret'], undefined);
    assert.equal(
      up.headers['anthropic-beta'],
      'foo-2025-01-01, oauth-2025-04-20',
    );
    assert.equal(up.body.toString('utf8'), body);
    assert.equal(up.headers['content-length'], String(Buffer.byteLength(body)));
  });

  it('adds the OAuth beta flag when the client sends none', async () => {
    await proxy.request({
      method: 'POST',
      path: '/v1/messages',
      headers: { 'content-type': 'application/json' },
      body: { model: 'claude-haiku-4-5' },
    });
    assert.equal(upstream.requests.length, 1);
    assert.equal(
      upstream.requests[0].headers['anthropic-beta'],
      'oauth-2025-04-20',
    );
  });
});

describe('upstream configuration', timeout, () => {
  it('fails at startup on an unknown UPSTREAM_PROTOCOL', async () => {
    await assert.rejects(
      startProxy({ env: { UPSTREAM_PROTOCOL: 'ftp' } }),
      (err) =>
        err.code === 1 && /\[config\] UPSTREAM_PROTOCOL/.test(err.output),
    );
  });

  it('fails at startup on an invalid UPSTREAM_PORT', async () => {
    await assert.rejects(
      startProxy({ env: { UPSTREAM_PORT: '70000' } }),
      (err) => err.code === 1 && /\[config\] UPSTREAM_PORT/.test(err.output),
    );
  });
});
