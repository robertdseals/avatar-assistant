const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/speak');

const FAKE_KEY = 'test-key-do-not-leak-12345';

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    ended: false,
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

async function call(overrides = {}) {
  const res = mockRes();
  const req = {
    method: 'POST',
    headers: { origin: 'https://shaleygardens.com' },
    body: { text: 'The roses are open today.' },
    ...overrides,
  };
  if (overrides.headers) req.headers = overrides.headers;
  await handler(req, res);
  return res;
}

function wavResponse(bytes) {
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        candidates: [{
          content: {
            parts: [{ inlineData: { mimeType: 'audio/wav', data: bytes.toString('base64') } }],
          },
        }],
      }),
  };
}

describe('speak handler', { concurrency: 1 }, () => {
  let originalFetch;
  let originalError;
  let logs;

  beforeEach(() => {
    handler._resetForTests();
    process.env.AVITAR_KEY = FAKE_KEY;
    delete process.env.VERCEL_URL;
    delete process.env.VERCEL_BRANCH_URL;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    originalFetch = global.fetch;
    logs = [];
    originalError = console.error;
    console.error = (...args) => {
      logs.push(args.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '));
    };
    global.fetch = async () => {
      throw new Error('fetch should not have been called');
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    console.error = originalError;
  });

  test('asks for a short spoken reply and returns wav audio without the key', async () => {
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(80)]);
    let requested;
    global.fetch = async (url, options) => {
      requested = { url, options };
      return wavResponse(wav);
    };

    const res = await call({
      headers: { origin: 'https://www.shaleygardens.com', 'x-real-ip': '203.0.113.15' },
      body: { text: `Good morning. ${FAKE_KEY} The jasmine smells sweet.` },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(Object.keys(res.body), ['audio']);
    assert.equal(Buffer.from(res.body.audio, 'base64').slice(0, 4).toString(), 'RIFF');
    assert.equal(JSON.stringify(res.body).includes(FAKE_KEY), false);
    assert.equal(res.headers['access-control-allow-origin'], 'https://www.shaleygardens.com');
    assert.equal(requested.url.includes(FAKE_KEY), false);
    assert.match(requested.url, /gemini-3\.8-flash-lite-tts:generateContent$/);
    assert.equal(requested.options.headers['x-goog-api-key'], FAKE_KEY);
    const payload = JSON.parse(requested.options.body);
    assert.equal(payload.generationConfig.speechConfig.voiceConfig.voice, 'Sulafat');
    assert.equal(payload.contents[0].parts[0].text.includes(FAKE_KEY), false);
    assert.match(payload.contents[0].parts[0].text, /jasmine smells sweet/);
    assert.equal(payload.contents[0].parts[0].text.length <= handler._limits.maxSpokenChars, true);
  });

  test('wraps raw pcm and hides upstream errors', async () => {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          candidates: [{
            content: {
              parts: [{
                inlineData: {
                  mimeType: 'audio/L16;codec=pcm;rate=24000',
                  data: Buffer.alloc(200).toString('base64'),
                },
              }],
            },
          }],
        }),
    });
    const pcm = await call({ headers: { 'x-real-ip': '203.0.113.16' } });
    assert.equal(Buffer.from(pcm.body.audio, 'base64').slice(0, 4).toString(), 'RIFF');

    global.fetch = async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { message: `bad key ${FAKE_KEY}` } }),
    });
    const failed = await call({ headers: { 'x-real-ip': '203.0.113.17' } });
    assert.equal(failed.statusCode, 500);
    assert.equal(JSON.stringify(failed.body).includes(FAKE_KEY), false);
    assert.equal(failed.body.audio, undefined);
    assert.equal(logs.join('\n').includes(FAKE_KEY), false);
  });

  test('blocks other websites and limits repeats', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return wavResponse(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(40)]));
    };
    const denied = await call({ headers: { origin: 'https://evil.example', 'x-real-ip': '203.0.113.18' } });
    assert.equal(denied.statusCode, 403);
    assert.equal(calls, 0);

    for (let i = 0; i < handler._limits.perIpPerMinute; i += 1) {
      const res = await call({ headers: { 'x-real-ip': '203.0.113.19' } });
      assert.equal(res.statusCode, 200);
    }
    const blocked = await call({ headers: { 'x-real-ip': '203.0.113.19' } });
    assert.equal(blocked.statusCode, 429);
    assert.equal(calls, handler._limits.perIpPerMinute);
  });
});
