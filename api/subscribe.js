const {
  readRedisConfig,
  readJsonBody,
  sendError,
  beginRequest,
  createLimiter,
  clientIp,
} = require('../lib/guard');
const {
  SET_KEY,
  normalizeEmail,
  readResendConfig,
  redisCommand,
  welcomeContent,
  deliverOne,
} = require('../lib/newsletter');

const MAX_BODY_CHARS = 4000;
const SUCCESS = "You're signed up for free monthly Central Florida garden tips. Check your inbox for a welcome note. If you don't see it in a few minutes, look in your junk or spam folder and mark it Not spam so future issues reach you.";
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

function honeypotFilled(body) {
  const extra = body && body.website;
  return typeof extra === 'string' && extra.trim().length > 0;
}

async function addSubscriber(config, email) {
  const added = await redisCommand(config, ['SADD', SET_KEY, email]);
  if (typeof added !== 'number') throw new Error('store result');
  return added;
}

async function sendWelcome(redis, email) {
  const resend = readResendConfig();
  if (!resend) return;
  const note = welcomeContent();
  const result = await deliverOne({
    redis,
    resend,
    now: Date.now(),
    email,
    subject: note.subject,
    htmlBody: note.html,
    textBody: note.text,
  });
  if (result.status !== 'sent') console.error('Welcome email was not sent');
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

  let added = 0;
  try {
    added = await addSubscriber(redis, email);
  } catch (error) {
    console.error('Newsletter store unavailable');
    return reply(res, 503, { error: LATER });
  }

  if (added === 1) {
    try {
      await sendWelcome(redis, email);
    } catch (error) {
      console.error('Welcome email was not sent');
    }
  }

  return reply(res, 200, { status: 'ok', message: SUCCESS });
};

module.exports._resetForTests = () => limiter.reset();
