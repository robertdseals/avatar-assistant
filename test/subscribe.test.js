const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/subscribe');

const TOKEN = 'subscribe-token-do-not-leak';
const URL = 'https://example-redis.test';

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = String(value);
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
}

async function call(body, headers = {}) {
  const res = mockRes();
  await handler({
    method: 'POST',
    headers: { origin: 'https://shaleygardens.com', 'x-real-ip': '203.0.113.40', ...headers },
    body,
  }, res);
  return res;
}

function redisFetch(onWrite) {
  return async (url, options) => {
    const command = JSON.parse(options.body);
    if (command[0] === 'EVAL') {
      return { ok: true, text: async () => JSON.stringify({ result: [1, 0] }) };
    }
    return onWrite(url, command);
  };
}

describe('newsletter signup', { concurrency: 1 }, () => {
  let originalFetch;

  beforeEach(() => {
    handler._resetForTests();
    process.env.KV_REST_API_URL = URL;
    process.env.KV_REST_API_TOKEN = TOKEN;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.VERCEL_URL;
    originalFetch = global.fetch;
    global.fetch = async () => {
      throw new Error('fetch should not have been called');
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
  });

  test('saves a new email in the shared set and does not send mail', async () => {
    const writes = [];
    global.fetch = redisFetch(async (url, command) => {
      writes.push({ url, command });
      return { ok: true, text: async () => JSON.stringify({ result: 1 }) };
    });

    const res = await call({ email: '  Gardener@Example.com ' });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'ok');
    assert.match(res.body.message, /signed up/i);
    assert.deepEqual(writes, [{
      url: URL,
      command: ['SADD', 'shaley:newsletter:emails', 'gardener@example.com'],
    }]);
    assert.equal(JSON.stringify(res.body).includes(TOKEN), false);
  });

  test('treats an address already in the set as a friendly success', async () => {
    global.fetch = redisFetch(async () => ({ ok: true, text: async () => JSON.stringify({ result: 0 }) }));
    const res = await call({ email: 'gardener@example.com' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'ok');
  });

  test('rejects a bad email before touching the store', async () => {
    let wrote = false;
    global.fetch = redisFetch(async () => {
      wrote = true;
      return { ok: true, text: async () => JSON.stringify({ result: 1 }) };
    });
    const res = await call({ email: 'not-an-email' });
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /valid email/i);
    assert.equal(wrote, false);
  });

  test('a filled honeypot looks successful and is not stored', async () => {
    let wrote = false;
    global.fetch = redisFetch(async () => {
      wrote = true;
      return { ok: true, text: async () => JSON.stringify({ result: 1 }) };
    });
    const res = await call({ email: 'gardener@example.com', website: 'https://spam.test' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'ok');
    assert.equal(wrote, false);
  });

  test('says the newsletter is coming soon when Redis is not configured', async () => {
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    let called = false;
    global.fetch = async () => {
      called = true;
      return { ok: true, text: async () => '{}' };
    };
    const res = await call({ email: 'gardener@example.com' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'soon');
    assert.match(res.body.message, /coming soon/i);
    assert.equal(called, false);
  });

  test('hides a store failure and never returns the token', async () => {
    global.fetch = redisFetch(async () => ({
      ok: false,
      status: 401,
      text: async () => `denied ${TOKEN}`,
    }));
    const res = await call({ email: 'gardener@example.com' });
    assert.equal(res.statusCode, 503);
    assert.equal(JSON.stringify(res.body).includes(TOKEN), false);
    assert.match(res.body.error, /try again/i);
  });

  test('uses the same origin rule as the chat', async () => {
    const res = await call({ email: 'gardener@example.com' }, { origin: 'https://evil.example' });
    assert.equal(res.statusCode, 403);
  });

  test('slows repeated signups from one address', async () => {
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    const headers = { 'x-real-ip': '203.0.113.77' };
    assert.equal((await call({ email: 'a@example.com' }, headers)).statusCode, 200);
    assert.equal((await call({ email: 'b@example.com' }, headers)).statusCode, 200);
    assert.equal((await call({ email: 'c@example.com' }, headers)).statusCode, 200);
    const blocked = await call({ email: 'd@example.com' }, headers);
    assert.equal(blocked.statusCode, 429);
    assert.equal(JSON.stringify(blocked.body).includes(TOKEN), false);
  });
});
