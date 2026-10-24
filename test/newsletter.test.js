const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const {
  renderNewsletter,
  runSend,
  normalizeEmail,
  newsletterFile,
} = require('../lib/newsletter');
const subscribe = require('../api/subscribe');
const unsubscribe = require('../api/unsubscribe');
const sendNewsletter = require('../api/send-newsletter');

const REDIS = 'https://example-redis.test';
const ADMIN = 'admin-token-for-tests-32chars';
const NOTE = `## Hello\n\nA short note with a [calendar](https://shaleygardens.com/calendar.html).\n`;
const UNSUB_TOKEN = 'a'.repeat(43);

function store() {
  const sets = new Map();
  const hashes = new Map();
  const nums = new Map();
  const sent = [];
  const ops = [];
  const setFor = (key) => {
    if (!sets.has(key)) sets.set(key, new Set());
    return sets.get(key);
  };
  const hashFor = (key) => {
    if (!hashes.has(key)) hashes.set(key, new Map());
    return hashes.get(key);
  };
  const fetchImpl = async (url, options) => {
    if (String(url).includes('api.resend.com')) {
      const body = JSON.parse(options.body);
      sent.push({ body, auth: options.headers.Authorization });
      return { ok: true, text: async () => JSON.stringify({ id: 'email_1' }) };
    }
    const command = JSON.parse(options.body);
    ops.push(command[0]);
    if (command[0] === 'EVAL') {
      return { ok: true, text: async () => JSON.stringify({ result: [1, 0] }) };
    }
    let result = null;
    const [op, key, field, value] = command;
    if (op === 'SADD') {
      const bucket = setFor(key);
      result = 0;
      for (const member of command.slice(2)) {
        if (!bucket.has(member)) {
          bucket.add(member);
          result += 1;
        }
      }
    } else if (op === 'SREM') {
      const bucket = setFor(key);
      result = 0;
      for (const member of command.slice(2)) if (bucket.delete(member)) result += 1;
    } else if (op === 'SMEMBERS') {
      result = [...setFor(key)];
    } else if (op === 'HSETNX') {
      const hash = hashFor(key);
      if (hash.has(field)) result = 0;
      else {
        hash.set(field, value);
        result = 1;
      }
    } else if (op === 'HSET') {
      hashFor(key).set(field, value);
      result = 1;
    } else if (op === 'HGET') {
      const found = hashFor(key).get(field);
      result = found === undefined ? null : found;
    } else if (op === 'HDEL') {
      result = hashFor(key).delete(field) ? 1 : 0;
    } else if (op === 'INCR') {
      nums.set(key, (nums.get(key) || 0) + 1);
      result = nums.get(key);
    } else if (op === 'DECR') {
      nums.set(key, (nums.get(key) || 0) - 1);
      result = nums.get(key);
    } else if (op === 'EXPIRE') {
      result = 1;
    } else {
      throw new Error(`unexpected redis command ${op}`);
    }
    return { ok: true, text: async () => JSON.stringify({ result }) };
  };
  return { fetchImpl, sent, sets, hashes, nums, ops };
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
    end(payload) {
      this.body = payload;
      this.ended = true;
    },
  };
}

describe('newsletter mail', { concurrency: 1 }, () => {
  let originalFetch;
  let memory;

  beforeEach(() => {
    subscribe._resetForTests();
    unsubscribe._resetForTests();
    originalFetch = global.fetch;
    memory = store();
    global.fetch = memory.fetchImpl;
    process.env.KV_REST_API_URL = REDIS;
    process.env.KV_REST_API_TOKEN = 'redis-token-do-not-leak';
    process.env.RESEND_API_KEY = 're_test_key_do_not_leak';
    process.env.NEWSLETTER_FROM = 'Shaley Gardens <newsletter@newsletter.shaleygardens.com>';
    process.env.ADMIN_SEND_TOKEN = ADMIN;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    delete process.env.RESEND_API_KEY;
    delete process.env.NEWSLETTER_FROM;
    delete process.env.ADMIN_SEND_TOKEN;
  });

  test('renders a mobile note and drops the draft banner', () => {
    const markdown = fs.readFileSync('newsletter/2026-11-november.md', 'utf8');
    const note = renderNewsletter(markdown);
    assert.equal(note.subject, 'November in your Central Florida garden');
    assert.equal(/draft only/i.test(note.html), false);
    assert.equal(/draft only/i.test(note.text), false);
    assert.match(note.html, /href="https:\/\/shaleygardens\.com\/calendar\.html"/);
    assert.equal(/<script/i.test(note.html), false);
  });

  test('rejects a newsletter path outside the folder', () => {
    assert.equal(newsletterFile('newsletter/../api/subscribe.js'), null);
    assert.equal(newsletterFile('https://example.com/note.md'), null);
    assert.ok(newsletterFile('newsletter/2026-11-november.md'));
  });

  test('a new signup sends one welcome when Resend is configured', async () => {
    const res = mockRes();
    await subscribe({
      method: 'POST',
      headers: { origin: 'https://shaleygardens.com', 'x-real-ip': '203.0.113.50' },
      body: { email: 'Gardener@Example.com' },
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(memory.sent.length, 1);
    assert.deepEqual(memory.sent[0].body.to, ['gardener@example.com']);
    assert.match(memory.sent[0].body.headers['List-Unsubscribe'], /https:\/\/shaleygardens\.com\/api\/unsubscribe\?token=/);
    assert.equal(memory.sent[0].body.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    assert.match(memory.sent[0].body.html, /Unsubscribe/);
    assert.match(memory.sent[0].body.text, /hello@shaleygardens.com/);
    assert.equal(JSON.stringify(res.body).includes('gardener@example.com'), false);
    assert.equal(memory.sent[0].auth.includes('re_test_key_do_not_leak'), true);
    assert.equal(JSON.stringify(res.body).includes('re_test_key_do_not_leak'), false);
  });

  test('unsubscribe removes the address and hides it on the page', async () => {
    memory.sets.set('shaley:newsletter:emails', new Set(['gardener@example.com']));
    memory.hashes.set('shaley:newsletter:email-by-token', new Map([
      [UNSUB_TOKEN, 'gardener@example.com'],
    ]));
    memory.hashes.set('shaley:newsletter:token-by-email', new Map([
      ['gardener@example.com', UNSUB_TOKEN],
    ]));
    const res = mockRes();
    await unsubscribe({
      method: 'GET',
      url: `/api/unsubscribe?token=${UNSUB_TOKEN}`,
      headers: { 'x-real-ip': '203.0.113.60' },
    }, res);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /You are unsubscribed/);
    assert.equal(res.body.includes('gardener@example.com'), false);
    assert.equal(memory.sets.get('shaley:newsletter:emails').size, 0);
  });

  test('one-click POST unsubscribe returns a plain confirmation', async () => {
    memory.hashes.set('shaley:newsletter:email-by-token', new Map([
      [UNSUB_TOKEN, 'gardener@example.com'],
    ]));
    memory.hashes.set('shaley:newsletter:token-by-email', new Map([
      ['gardener@example.com', UNSUB_TOKEN],
    ]));
    const res = mockRes();
    await unsubscribe({
      method: 'POST',
      url: `/api/unsubscribe?token=${UNSUB_TOKEN}`,
      headers: { 'x-real-ip': '203.0.113.61', 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    }, res);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /Unsubscribed/);
    assert.equal(res.headers['content-type'].includes('text/plain'), true);
  });

  test('a bad unsubscribe link does not invent an address', async () => {
    const res = mockRes();
    await unsubscribe({
      method: 'GET',
      url: '/api/unsubscribe?token=short',
      headers: { 'x-real-ip': '203.0.113.62' },
    }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /not valid/);
    assert.equal(memory.ops.includes('HGET'), false);
  });

  test('send tool explains itself when Resend is not configured', async () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.NEWSLETTER_FROM;
    const res = mockRes();
    await sendNewsletter({
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}` },
      body: { mode: 'test', to: 'owner@example.com', markdown: NOTE, file: 'newsletter/2026-11-november.md' },
    }, res);
    assert.equal(res.statusCode, 503);
    const payload = JSON.parse(res.body);
    assert.match(payload.error, /RESEND_API_KEY/);
    assert.match(payload.error, /Nothing was sent/);
    assert.equal(memory.sent.length, 0);
  });

  test('send tool stays closed without the admin token', async () => {
    delete process.env.ADMIN_SEND_TOKEN;
    const res = mockRes();
    await sendNewsletter({
      method: 'POST',
      headers: { authorization: 'Bearer guessed-token-not-the-real-one' },
      body: { mode: 'test', to: 'owner@example.com', markdown: NOTE },
    }, res);
    assert.equal(res.statusCode, 503);
    assert.match(JSON.parse(res.body).error, /ADMIN_SEND_TOKEN/);
    assert.equal(memory.sent.length, 0);
  });

  test('a wrong admin token sends nothing', async () => {
    const res = mockRes();
    await sendNewsletter({
      method: 'POST',
      headers: { authorization: 'Bearer not-the-admin-token-value' },
      body: { mode: 'test', to: 'owner@example.com', markdown: NOTE },
    }, res);
    assert.equal(res.statusCode, 401);
    assert.equal(memory.sent.length, 0);
    assert.equal(memory.ops.includes('SMEMBERS'), false);
  });

  test('test mode sends to one address and not the list', async () => {
    memory.sets.set('shaley:newsletter:emails', new Set(['list-one@example.com', 'list-two@example.com']));
    const result = await runSend({
      mode: 'test',
      to: 'Owner@Example.com',
      markdown: NOTE,
      file: 'newsletter/2026-11-november.md',
      pauseMs: 0,
      fetchImpl: memory.fetchImpl,
      now: Date.UTC(2026, 9, 24),
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.sent, 1);
    assert.deepEqual(memory.sent.map((item) => item.body.to[0]), ['owner@example.com']);
    assert.equal(memory.ops.includes('SMEMBERS'), false);
    assert.equal(JSON.stringify(result.body).includes('list-one@example.com'), false);
  });

  test('a full send needs confirm and then mails only subscribers', async () => {
    memory.sets.set('shaley:newsletter:emails', new Set(['list-one@example.com', 'list-two@example.com']));
    const blocked = await runSend({
      mode: 'full',
      confirm: false,
      markdown: NOTE,
      file: 'newsletter/2026-11-november.md',
      pauseMs: 0,
      fetchImpl: memory.fetchImpl,
      now: Date.UTC(2026, 9, 24),
    });
    assert.equal(blocked.status, 400);
    assert.equal(memory.sent.length, 0);

    const result = await runSend({
      mode: 'full',
      confirm: true,
      markdown: NOTE,
      file: 'newsletter/2026-11-november.md',
      pauseMs: 0,
      batchSize: 20,
      fetchImpl: memory.fetchImpl,
      now: Date.UTC(2026, 9, 24),
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.sent, 2);
    assert.equal(result.body.remaining, 0);
    assert.deepEqual(memory.sent.map((item) => item.body.to[0]).sort(), ['list-one@example.com', 'list-two@example.com']);
    for (const item of memory.sent) {
      assert.match(item.body.html, /Unsubscribe/);
      assert.match(item.body.headers['List-Unsubscribe'], /token=/);
      assert.equal(item.body.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    }

    memory.sent.length = 0;
    const again = await runSend({
      mode: 'full',
      confirm: true,
      markdown: NOTE,
      file: 'newsletter/2026-11-november.md',
      pauseMs: 0,
      fetchImpl: memory.fetchImpl,
      now: Date.UTC(2026, 9, 24),
    });
    assert.equal(again.body.sent, 0);
    assert.equal(memory.sent.length, 0);
  });

  test('stops at 100 sends in a day', async () => {
    memory.nums.set('shaley:newsletter:sent-day:2026-10-24', 100);
    const result = await runSend({
      mode: 'test',
      to: 'owner@example.com',
      markdown: NOTE,
      pauseMs: 0,
      fetchImpl: memory.fetchImpl,
      now: Date.UTC(2026, 9, 24),
    });
    assert.equal(result.status, 429);
    assert.match(result.body.error, /100/);
    assert.equal(memory.sent.length, 0);
    assert.equal(normalizeEmail('owner@example.com'), 'owner@example.com');
  });
});
