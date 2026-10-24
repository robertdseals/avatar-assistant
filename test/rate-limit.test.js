const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createLimiter } = require('../lib/guard');
const chat = require('../api/chat');
const speak = require('../api/speak');

const TOKEN = 'super-secret-store-token';
const STORE = 'https://example.upstash.io';

function clearStoreEnv() {
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
}

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

async function post(handler, body, headers = {}) {
  const res = mockRes();
  await handler({
    method: 'POST',
    headers: { 'x-real-ip': '203.0.113.10', ...headers },
    body,
  }, res);
  return res;
}

describe('shared rate limit', { concurrency: 1 }, () => {
  let originalFetch;
  let logs;

  beforeEach(() => {
    chat._resetForTests();
    speak._resetForTests();
    clearStoreEnv();
    process.env.AVITAR_KEY = 'test-key-do-not-leak-12345';
    originalFetch = global.fetch;
    logs = [];
    console.error = (...args) => {
      logs.push(args.map((part) => String(part)).join(' '));
    };
    global.fetch = async () => {
      throw new Error('fetch should not have been called');
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    clearStoreEnv();
  });

  test('keeps the in-memory limit when no store is configured', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      throw new Error('no store configured');
    };
    const limiter = createLimiter({
      name: 'chat',
      perIpPerMinute: 8,
      perIpPerHour: 40,
      globalPerMinute: 20,
    });
    for (let i = 0; i < 8; i += 1) {
      assert.equal((await limiter.check('198.51.100.8')).ok, true);
    }
    assert.equal((await limiter.check('198.51.100.8')).ok, false);
    assert.equal(calls, 0);
  });

  test('two copies share one counter and the voice has its own counter', async () => {
    const hits = new Map();
    const seen = [];
    global.fetch = async (url, options) => {
      if (String(url) !== STORE) {
        const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(40)]);
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }] } }],
          }),
        };
      }
      const command = JSON.parse(options.body);
      assert.equal(command[0], 'EVAL');
      assert.equal(command[2], 2);
      assert.match(command[1], /ZADD/);
      assert.match(command[1], /ZREMRANGEBYSCORE/);
      assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
      assert.equal(String(url).includes(TOKEN), false);
      const ipKey = command[3];
      const globalKey = command[4];
      const perMinute = Number(command[8]);
      seen.push({ ipKey, globalKey, perMinute, perHour: Number(command[9]), globalMax: Number(command[10]) });
      const count = (hits.get(ipKey) || 0) + 1;
      hits.set(ipKey, count);
      const allowed = count <= perMinute;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ result: allowed ? [1, 0] : [0, 30] }),
      };
    };

    process.env.KV_REST_API_URL = STORE;
    process.env.KV_REST_API_TOKEN = TOKEN;
    const firstCopy = createLimiter({ name: 'chat', perIpPerMinute: 8, perIpPerHour: 40, globalPerMinute: 20 });
    const secondCopy = createLimiter({ name: 'chat', perIpPerMinute: 8, perIpPerHour: 40, globalPerMinute: 20 });
    for (let i = 0; i < 8; i += 1) assert.equal((await firstCopy.check('203.0.113.8')).ok, true);
    const blocked = await secondCopy.check('203.0.113.8');
    assert.equal(blocked.ok, false);
    assert.equal(blocked.retryAfterSeconds, 30);
    assert.equal(seen[0].ipKey, seen[8].ipKey);
    assert.equal(seen[0].ipKey, 'shaley:chat:ip:203.0.113.8');
    assert.equal(seen[0].globalKey, 'shaley:chat:global');
    assert.equal(seen[0].perMinute, 8);
    assert.equal(seen[0].perHour, 40);
    assert.equal(seen[0].globalMax, 20);

    const voice = await post(speak, { text: 'Hello from the garden.' });
    assert.equal(voice.statusCode, 200);
    assert.equal(seen.at(-1).ipKey, 'shaley:speak:ip:203.0.113.10');
    assert.equal(JSON.stringify(voice.body).includes(TOKEN), false);
  });

  test('a store refusal stops the chat without calling Gemini or revealing the token', async () => {
    let gemini = 0;
    global.fetch = async (url) => {
      if (String(url) === STORE) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ result: [0, 12], error: TOKEN }),
        };
      }
      gemini += 1;
      throw new Error('gemini should not be called');
    };
    process.env.UPSTASH_REDIS_REST_URL = STORE;
    process.env.UPSTASH_REDIS_REST_TOKEN = TOKEN;
    const res = await post(chat, { message: 'Hello' });
    assert.equal(res.statusCode, 429);
    assert.equal(res.headers['retry-after'], '12');
    assert.equal(res.body.error, "You're sending messages too quickly. Please wait a little while and try again.");
    assert.equal(JSON.stringify(res.body).includes(TOKEN), false);
    assert.equal(logs.join('\n').includes(TOKEN), false);
    assert.equal(gemini, 0);
  });

  test('uses the Vercel KV names before the Upstash names', async () => {
    let called = '';
    global.fetch = async (url, options) => {
      called = `${url} ${options.headers.Authorization}`;
      return { ok: true, status: 200, text: async () => JSON.stringify({ result: [1, 0] }) };
    };
    process.env.KV_REST_API_URL = 'https://kv.example.upstash.io';
    process.env.KV_REST_API_TOKEN = 'kv-token';
    process.env.UPSTASH_REDIS_REST_URL = 'https://other.example.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'other-token';
    const limiter = createLimiter({ name: 'chat', perIpPerMinute: 8, perIpPerHour: 40, globalPerMinute: 20 });
    assert.equal((await limiter.check('203.0.113.1')).ok, true);
    assert.equal(called, 'https://kv.example.upstash.io Bearer kv-token');
  });

  test('falls back to the temporary limit when the store is down', async () => {
    global.fetch = async (url) => {
      if (String(url) === STORE) {
        return { ok: false, status: 500, text: async () => `down ${TOKEN}` };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'The roses are open.' }] } }],
        }),
      };
    };
    process.env.KV_REST_API_URL = `${STORE}/`;
    process.env.KV_REST_API_TOKEN = TOKEN;
    const ok = await post(chat, { message: 'Hello' }, { 'x-real-ip': '198.51.100.20' });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.body.message, 'The roses are open.');
    assert.equal(JSON.stringify(ok.body).includes(TOKEN), false);
    assert.match(logs.join('\n'), /Shared rate limit store unavailable/);
    assert.equal(logs.join('\n').includes(TOKEN), false);

    for (let i = 0; i < 7; i += 1) {
      const res = await post(chat, { message: 'Hello again' }, { 'x-real-ip': '198.51.100.20' });
      assert.equal(res.statusCode, 200);
    }
    const blocked = await post(chat, { message: 'Too many' }, { 'x-real-ip': '198.51.100.20' });
    assert.equal(blocked.statusCode, 429);
  });
});
