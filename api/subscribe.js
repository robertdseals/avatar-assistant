const {
  readRedisConfig,
  readJsonBody,
  sendError,
  beginRequest,
  createLimiter,
  clientIp,
} = require('../lib/guard');

const MAX_BODY_CHARS = 4000;
const SET_KEY = 'shaley:newsletter:emails';
const SUCCESS = "You're signed up for free monthly Central Florida garden tips.";
const COMING_SOON = 'The newsletter is coming soon. Please check back a little later.';
const INVALID = 'Please enter a valid email address.';
const BUSY = 'Please wait a little while before trying again.';
const LATER = "We couldn't save that just now. Please try again in a moment.";

const limiter = createLimiter({
  name: 'subscribe',
  perIpPerMinute: 3,
  perIpPerHour: 8,
  globalPerMinute: 30,
});

function normalizeEmail(value) {
  if (typeof value !== 'string') return '';
  const email = value.trim().toLowerCase();
  if (email.length < 6 || email.length > 254) return '';
  if (email.includes('..') || /[\s<>]/.test(email)) return '';
  const parts = email.split('@');
  if (parts.length !== 2) return '';
  const [local, domain] = parts;
  if (!local || !domain || !domain.includes('.')) return '';
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local)) return '';
  if (!/^[a-z0-9.-]+$/i.test(domain)) return '';
  if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return '';
  return email;
}

function honeypotFilled(body) {
  const extra = body && body.website;
  return typeof extra === 'string' && extra.trim().length > 0;
}

async function addSubscriber(config, email) {
  const response = await fetch(config.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(['SADD', SET_KEY, email]),
    redirect: 'error',
    signal: AbortSignal.timeout(2500),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error('store status');
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('store non-json');
  }
  if (!data || typeof data.result !== 'number') throw new Error('store result');
  return data.result;
}

function reply(res, status, payload) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json(payload);
}

module.exports = async function handler(req, res) {
  const gate = beginRequest(req, res);
  if (gate.done) return;

  const parsed = readJsonBody(req, MAX_BODY_CHARS);
  if (parsed.kind === 'too-long' || parsed.kind === 'missing') {
    return sendError(res, 400, INVALID);
  }

  const limit = await limiter.check(clientIp(req));
  if (!limit.ok) {
    res.setHeader('Retry-After', String(limit.retryAfterSeconds));
    return reply(res, 429, { error: BUSY });
  }

  const redis = readRedisConfig();
  if (honeypotFilled(parsed.body)) {
    if (!redis) return reply(res, 200, { status: 'soon', message: COMING_SOON });
    return reply(res, 200, { status: 'ok', message: SUCCESS });
  }

  const email = normalizeEmail(parsed.body.email);
  if (!email) return reply(res, 400, { error: INVALID });
  if (!redis) return reply(res, 200, { status: 'soon', message: COMING_SOON });

  try {
    await addSubscriber(redis, email);
  } catch (error) {
    console.error('Newsletter store unavailable');
    return reply(res, 503, { error: LATER });
  }

  return reply(res, 200, { status: 'ok', message: SUCCESS });
};

module.exports._resetForTests = () => limiter.reset();
