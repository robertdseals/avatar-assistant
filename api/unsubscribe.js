const { createLimiter, clientIp, readRedisConfig } = require('../lib/guard');
const { removeSubscriber, confirmationPage, CONTACT } = require('../lib/newsletter');

const limiter = createLimiter({
  name: 'unsubscribe',
  perIpPerMinute: 20,
  perIpPerHour: 60,
  globalPerMinute: 60,
});

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function tokenFrom(req) {
  const rawUrl = typeof req.url === 'string' ? req.url : '/api/unsubscribe';
  try {
    const parsed = new URL(rawUrl, 'https://shaleygardens.com');
    return parsed.searchParams.get('token') || '';
  } catch {
    return '';
  }
}

function sendHtml(res, status, title, message) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(confirmationPage({ title, message }));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    res.statusCode = 405;
    res.setHeader('Cache-Control', 'no-store');
    res.end('Method not allowed');
    return;
  }

  const limit = await limiter.check(clientIp(req));
  if (!limit.ok) {
    res.setHeader('Retry-After', String(limit.retryAfterSeconds));
    sendHtml(
      res,
      429,
      'Please wait',
      `Too many unsubscribe tries from this connection. Wait a little while, then open the link again. You can also write to <a href="mailto:${CONTACT}">${CONTACT}</a>.`
    );
    return;
  }

  const token = tokenFrom(req);
  if (!TOKEN_PATTERN.test(token)) {
    sendHtml(
      res,
      400,
      'That link is not valid',
      `This unsubscribe link is missing its code, or the code is not one of ours. If a note still arrives, write to <a href="mailto:${CONTACT}">${CONTACT}</a> and we will take you off.`
    );
    return;
  }

  const redis = readRedisConfig();
  if (!redis) {
    sendHtml(
      res,
      503,
      'Please try again',
      `The list could not be updated just now. Open the link again in a moment, or write to <a href="mailto:${CONTACT}">${CONTACT}</a>.`
    );
    return;
  }

  try {
    await removeSubscriber(redis, token);
  } catch (error) {
    console.error('Unsubscribe store unavailable');
    sendHtml(
      res,
      503,
      'Please try again',
      `The list could not be updated just now. Open the link again in a moment, or write to <a href="mailto:${CONTACT}">${CONTACT}</a>.`
    );
    return;
  }

  const friendly = 'You are unsubscribed. We will not send more garden notes for that signup. If a note was already on its way, that one may still arrive.';
  if (req.method === 'POST') {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : req.body;
    const body = typeof rawBody === 'string' ? rawBody : '';
    const oneClick = body.includes('List-Unsubscribe=One-Click')
      || (rawBody && rawBody['List-Unsubscribe'] === 'One-Click');
    if (oneClick) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end('Unsubscribed\n');
      return;
    }
  }

  sendHtml(res, 200, 'You are unsubscribed', friendly);
};

module.exports._resetForTests = () => limiter.reset();
