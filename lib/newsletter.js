const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { readRedisConfig } = require('./guard');

const SITE = 'https://shaleygardens.com';
const CONTACT = 'hello@shaleygardens.com';
const SET_KEY = 'shaley:newsletter:emails';
const TOKEN_BY_EMAIL = 'shaley:newsletter:token-by-email';
const EMAIL_BY_TOKEN = 'shaley:newsletter:email-by-token';
const DAILY_KEY_PREFIX = 'shaley:newsletter:sent-day:';
const JOB_KEY_PREFIX = 'shaley:newsletter:sent-file:';
const DAILY_CAP = 100;
const ROOT = path.join(__dirname, '..');

const MISSING_MAIL = 'Newsletter sending is turned off. Set RESEND_API_KEY and NEWSLETTER_FROM. Nothing was sent.';
const MISSING_ADMIN = 'Newsletter sending is turned off. Set ADMIN_SEND_TOKEN. Nothing was sent.';
const MISSING_REDIS = 'Newsletter sending is turned off. The subscriber store is not configured. Nothing was sent.';

function envValue(name) {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : '';
}

function readResendConfig() {
  const apiKey = envValue('RESEND_API_KEY');
  const from = envValue('NEWSLETTER_FROM');
  if (!apiKey || !from) return null;
  if (from.length > 200 || /[\r\n]/.test(from) || !from.includes('@')) return null;
  return { apiKey, from };
}

function readAdminToken() {
  const token = envValue('ADMIN_SEND_TOKEN');
  if (token.length < 16 || /[\r\n]/.test(token)) return '';
  return token;
}

function tokensMatch(provided, expected) {
  const left = Buffer.from(String(provided));
  const right = Buffer.from(String(expected));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

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

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function safeHref(raw) {
  const value = String(raw || '').trim();
  if (value.startsWith('/') && !value.startsWith('//')) {
    return `${SITE}${value}`;
  }
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return url.href;
    if (url.protocol === 'mailto:' && url.pathname.includes('@')) return url.href;
  } catch {
    return '';
  }
  return '';
}

function formatInline(raw, asText) {
  const re = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*/g;
  let html = '';
  let text = '';
  let last = 0;
  let match = re.exec(raw);
  while (match) {
    const plain = raw.slice(last, match.index);
    html += escapeHtml(plain);
    text += plain;
    if (match[1]) {
      const href = safeHref(match[2]);
      const label = match[1];
      html += href
        ? `<a href="${escapeHtml(href)}" style="color:#1f4a38;">${escapeHtml(label)}</a>`
        : escapeHtml(label);
      text += href ? `${label} (${href})` : label;
    } else {
      html += `<strong>${escapeHtml(match[3])}</strong>`;
      text += match[3];
    }
    last = match.index + match[0].length;
    match = re.exec(raw);
  }
  html += escapeHtml(raw.slice(last));
  text += raw.slice(last);
  return asText ? text : html;
}

function renderNewsletter(markdown) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let paragraph = [];
  let list = [];
  let subject = 'Shaley Gardens';

  function flushParagraph() {
    if (!paragraph.length) return;
    const text = paragraph.join(' ').trim();
    paragraph = [];
    if (text) blocks.push({ type: 'p', text });
  }

  function flushList() {
    if (!list.length) return;
    blocks.push({ type: 'ul', items: list });
    list = [];
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^draft only\b/i.test(trimmed)) continue;
    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      if (level === 1 && subject === 'Shaley Gardens') subject = heading[2].trim().slice(0, 120);
      blocks.push({ type: `h${level}`, text: heading[2].trim() });
      continue;
    }
    if (/^[-*]\s+/.test(trimmed)) {
      flushParagraph();
      list.push(trimmed.replace(/^[-*]\s+/, ''));
      continue;
    }
    flushList();
    paragraph.push(trimmed);
  }
  flushParagraph();
  flushList();

  const styles = {
    h1: 'font-size:28px;line-height:1.25;color:#1f4a38;margin:0 0 12px;',
    h2: 'font-size:22px;line-height:1.3;color:#1f4a38;margin:22px 0 8px;',
    h3: 'font-size:18px;line-height:1.3;color:#1f4a38;margin:18px 0 8px;',
    p: 'margin:0 0 14px;',
    ul: 'margin:0 0 14px;padding-left:1.2em;',
  };
  const htmlParts = blocks.map((block) => {
    if (block.type === 'ul') {
      const items = block.items.map((item) => `<li>${formatInline(item, false)}</li>`).join('');
      return `<ul style="${styles.ul}">${items}</ul>`;
    }
    const style = styles[block.type] || styles.p;
    return `<${block.type} style="${style}">${formatInline(block.text, false)}</${block.type}>`;
  });
  const textParts = blocks.map((block) => {
    if (block.type === 'ul') return block.items.map((item) => `- ${formatInline(item, true)}`).join('\n');
    if (block.type === 'h1') return formatInline(block.text, true);
    if (block.type.startsWith('h')) return formatInline(block.text, true).toUpperCase();
    return formatInline(block.text, true);
  });

  return {
    subject,
    html: htmlParts.join('\n'),
    text: textParts.join('\n\n'),
  };
}

function unsubscribeUrl(token) {
  return `${SITE}/api/unsubscribe?token=${encodeURIComponent(token)}`;
}

function listHeaders(token) {
  const url = unsubscribeUrl(token);
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

function wrapHtml(inner, token) {
  const url = unsubscribeUrl(token);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shaley Gardens</title>
</head>
<body style="margin:0;background:#f4efe4;color:#24312b;">
  <div style="max-width:560px;margin:0 auto;padding:28px 20px 40px;font-family:Georgia,'Iowan Old Style',serif;font-size:18px;line-height:1.5;">
    <p style="margin:0 0 16px;"><img src="https://www.shaleygardens.com/assets/logo-web.png" alt="Shaley Gardens" width="168" height="164" style="display:block;width:168px;max-width:62%;height:auto;border:0;"></p>
    ${inner}
    <p style="margin-top:28px;padding-top:16px;border-top:1px solid rgba(36,49,43,0.15);font-family:'Segoe UI',sans-serif;font-size:14px;line-height:1.45;color:#5d6b62;">
      You signed up for notes from Shaley Gardens.
      <a href="${escapeHtml(url)}" style="color:#1f4a38;">Unsubscribe</a>.
      Questions: <a href="mailto:${CONTACT}" style="color:#1f4a38;">${CONTACT}</a>
    </p>
  </div>
</body>
</html>`;
}

function wrapText(text, token) {
  return `${text}\n\n---\nYou signed up for notes from Shaley Gardens.\nUnsubscribe: ${unsubscribeUrl(token)}\nQuestions: ${CONTACT}\n`;
}

function welcomeContent() {
  const html = `<h1 style="font-size:28px;line-height:1.2;color:#1f4a38;">You're on the list</h1>
<p>If this is in your junk or spam folder, mark it Not spam so future issues reach you.</p>
<p>Thanks for signing up. About once a month, Shaley Gardens will send a short note about planting in Ocala, Marion County, and The Villages.</p>
<p>You can also download the <a href="https://shaleygardens.com/guides/2026-11-planting-guide.pdf" style="color:#1f4a38;">November planting guide (PDF)</a>.</p>
<p>You can leave any time with the unsubscribe link below.</p>`;
  const text = `You're on the list\n\nIf this is in your junk or spam folder, mark it Not spam so future issues reach you.\n\nThanks for signing up. About once a month, Shaley Gardens will send a short note about planting in Ocala, Marion County, and The Villages.\n\nYou can also download the November planting guide (PDF): https://shaleygardens.com/guides/2026-11-planting-guide.pdf\n\nYou can leave any time with the unsubscribe link below.`;
  return { subject: "You're signed up for Shaley Gardens", html, text };
}

async function redisCommand(config, command, fetchImpl = fetch) {
  const response = await fetchImpl(config.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error('store status');
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('store non-json');
  }
  if (!data || !Object.prototype.hasOwnProperty.call(data, 'result')) throw new Error('store result');
  if (data.error) throw new Error('store result');
  return data.result;
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

async function ensureToken(redis, email, fetchImpl) {
  const token = newToken();
  const created = await redisCommand(redis, ['HSETNX', TOKEN_BY_EMAIL, email, token], fetchImpl);
  if (Number(created) === 1) {
    await redisCommand(redis, ['HSET', EMAIL_BY_TOKEN, token, email], fetchImpl);
    return token;
  }
  const existing = await redisCommand(redis, ['HGET', TOKEN_BY_EMAIL, email], fetchImpl);
  if (typeof existing !== 'string' || existing.length < 20) throw new Error('token missing');
  await redisCommand(redis, ['HSET', EMAIL_BY_TOKEN, existing, email], fetchImpl);
  return existing;
}

async function emailForToken(redis, token, fetchImpl) {
  const email = await redisCommand(redis, ['HGET', EMAIL_BY_TOKEN, token], fetchImpl);
  return typeof email === 'string' ? email : '';
}

async function removeSubscriber(redis, token, fetchImpl) {
  const email = await emailForToken(redis, token, fetchImpl);
  if (!email) return false;
  await redisCommand(redis, ['SREM', SET_KEY, email], fetchImpl);
  await redisCommand(redis, ['HDEL', TOKEN_BY_EMAIL, email], fetchImpl);
  await redisCommand(redis, ['HDEL', EMAIL_BY_TOKEN, token], fetchImpl);
  return true;
}

function dayKey(now) {
  return `${DAILY_KEY_PREFIX}${new Date(now).toISOString().slice(0, 10)}`;
}

async function reserveSend(redis, fetchImpl, now) {
  const key = dayKey(now);
  const used = Number(await redisCommand(redis, ['INCR', key], fetchImpl));
  await redisCommand(redis, ['EXPIRE', key, '172800'], fetchImpl);
  if (used > DAILY_CAP) {
    await redisCommand(redis, ['DECR', key], fetchImpl);
    return { ok: false, used: DAILY_CAP };
  }
  return { ok: true, used };
}

async function releaseSend(redis, fetchImpl, now) {
  const key = dayKey(now);
  await redisCommand(redis, ['DECR', key], fetchImpl);
}

async function sendViaResend({ config, to, subject, html, text, headers, fetchImpl = fetch }) {
  const response = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: config.from,
      to: [to],
      subject,
      html,
      text,
      headers,
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error('mail status');
  return true;
}

function newsletterFile(name) {
  const rel = String(name || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!/^newsletter\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(rel)) return null;
  const full = path.resolve(ROOT, rel);
  const base = path.resolve(ROOT, 'newsletter') + path.sep;
  if (!full.startsWith(base)) return null;
  return { rel, full, id: path.basename(full, '.md').slice(0, 80) };
}

function readNewsletterFile(name) {
  const file = newsletterFile(name);
  if (!file) return { error: 'Choose a newsletter file such as newsletter/2026-11-november.md. Nothing was sent.' };
  try {
    return { file, markdown: fs.readFileSync(file.full, 'utf8') };
  } catch {
    return {
      error: 'That newsletter file is not on this server. Run scripts/send-newsletter.js from your computer. Nothing was sent.',
    };
  }
}

function jobKey(fileId) {
  return `${JOB_KEY_PREFIX}${fileId}`;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function deliverOne({ redis, resend, fetchImpl, now, email, subject, htmlBody, textBody }) {
  const slot = await reserveSend(redis, fetchImpl, now);
  if (!slot.ok) return { status: 'capped', used: slot.used };
  try {
    const token = await ensureToken(redis, email, fetchImpl);
    await sendViaResend({
      config: resend,
      to: email,
      subject,
      html: wrapHtml(htmlBody, token),
      text: wrapText(textBody, token),
      headers: listHeaders(token),
      fetchImpl,
    });
    return { status: 'sent', used: slot.used };
  } catch (error) {
    try {
      await releaseSend(redis, fetchImpl, now);
    } catch {
      console.error('Newsletter send count could not be returned');
    }
    console.error('Newsletter send failed');
    return { status: 'failed' };
  }
}

async function runSend(options) {
  const resend = options.resend || readResendConfig();
  const redis = options.redis === undefined ? readRedisConfig() : options.redis;
  const fetchImpl = options.fetchImpl || fetch;
  const now = options.now || Date.now();
  const pauseMs = Number.isFinite(options.pauseMs) ? options.pauseMs : 600;
  const mode = options.mode === 'full' ? 'full' : options.mode === 'test' ? 'test' : '';

  if (!readAdminToken() && !options.adminAlreadyChecked) {
    return { status: 503, body: { error: MISSING_ADMIN } };
  }
  if (!resend) return { status: 503, body: { error: MISSING_MAIL } };
  if (!redis) return { status: 503, body: { error: MISSING_REDIS } };
  if (!mode) return { status: 400, body: { error: 'Choose mode "test" or mode "full". Nothing was sent.' } };

  const rendered = renderNewsletter(options.markdown);
  if (!rendered.text.trim()) {
    return { status: 400, body: { error: 'That newsletter has no text to send. Nothing was sent.' } };
  }

  if (mode === 'test') {
    const to = normalizeEmail(options.to);
    if (!to) return { status: 400, body: { error: 'A test send needs one address in to. Nothing was sent.' } };
    const result = await deliverOne({
      redis,
      resend,
      fetchImpl,
      now,
      email: to,
      subject: rendered.subject,
      htmlBody: rendered.html,
      textBody: rendered.text,
    });
    if (result.status === 'capped') {
      return { status: 429, body: { error: 'The daily send limit of 100 is used up. Nothing more was sent.', dailyLimit: DAILY_CAP } };
    }
    if (result.status !== 'sent') {
      return { status: 502, body: { error: 'The test message was not sent. Check Resend and try again.' } };
    }
    return { status: 200, body: { status: 'sent', mode: 'test', sent: 1 } };
  }

  if (options.confirm !== true) {
    return { status: 400, body: { error: 'A full send needs confirm set to true. Nothing was sent.' } };
  }
  const file = newsletterFile(options.file);
  if (!file) {
    return { status: 400, body: { error: 'A full send needs a newsletter file name. Nothing was sent.' } };
  }

  const subscribers = await redisCommand(redis, ['SMEMBERS', SET_KEY], fetchImpl);
  const rows = Array.isArray(subscribers) ? subscribers : [];
  const pending = [];
  const seen = new Set();
  for (const item of rows) {
    const raw = String(item).trim();
    const email = normalizeEmail(raw);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    if (raw !== email) {
      await redisCommand(redis, ['SADD', SET_KEY, email], fetchImpl);
      await redisCommand(redis, ['SREM', SET_KEY, raw], fetchImpl);
    }
    pending.push(email);
  }
  const progressKey = jobKey(file.id);
  let already = [];
  if (!options.again) {
    const prior = await redisCommand(redis, ['SMEMBERS', progressKey], fetchImpl);
    already = Array.isArray(prior) ? prior : [];
  }
  const done = new Set(already.map((item) => normalizeEmail(String(item)) || String(item)));
  const waiting = pending.filter((email) => !done.has(email));
  const batchSize = Math.max(1, Number(options.batchSize) || waiting.length || 1);
  const batch = waiting.slice(0, batchSize);
  let sent = 0;
  let failed = 0;

  for (const email of batch) {
    const result = await deliverOne({
      redis,
      resend,
      fetchImpl,
      now,
      email,
      subject: rendered.subject,
      htmlBody: rendered.html,
      textBody: rendered.text,
    });
    if (result.status === 'capped') {
      return {
        status: 200,
        body: {
          status: 'partial',
          mode: 'full',
          sent,
          failed,
          remaining: waiting.length - sent,
          dailyLimit: DAILY_CAP,
          message: 'Stopped at the daily limit of 100. Run the same command tomorrow to continue. Nothing extra was sent.',
        },
      };
    }
    if (result.status === 'sent') {
      sent += 1;
      await redisCommand(redis, ['SADD', progressKey, email], fetchImpl);
      await redisCommand(redis, ['EXPIRE', progressKey, String(60 * 60 * 24 * 21)], fetchImpl);
    } else {
      failed += 1;
    }
    if (pauseMs > 0 && email !== batch[batch.length - 1]) await sleep(pauseMs);
  }

  if (sent === 0 && failed > 0) {
    return { status: 502, body: { error: 'Those messages were not sent. Nothing more was attempted.', failed } };
  }

  const remaining = waiting.length - sent;
  return {
    status: 200,
    body: {
      status: remaining > 0 ? 'partial' : 'sent',
      mode: 'full',
      sent,
      failed,
      remaining,
      dailyLimit: DAILY_CAP,
    },
  };
}

function confirmationPage({ title, message }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} | Shaley Gardens</title>
</head>
<body style="margin:0;background:#f4efe4;color:#24312b;font-family:'Segoe UI',sans-serif;">
  <main style="max-width:34rem;margin:0 auto;padding:3rem 1.25rem;">
    <p style="margin:0;letter-spacing:0.04em;text-transform:uppercase;font-size:0.8rem;color:#1f4a38;">Shaley Gardens</p>
    <h1 style="font-family:Georgia,serif;font-size:2rem;line-height:1.2;color:#1f4a38;">${escapeHtml(title)}</h1>
    <p style="font-size:1.125rem;line-height:1.5;">${message}</p>
    <p style="font-size:1rem;"><a href="/" style="color:#1f4a38;">Back to Shaley Gardens</a></p>
    <p style="color:#5d6b62;">Contact: <a href="mailto:${CONTACT}" style="color:#1f4a38;">${CONTACT}</a></p>
  </main>
</body>
</html>`;
}

module.exports = {
  SITE,
  CONTACT,
  SET_KEY,
  TOKEN_BY_EMAIL,
  EMAIL_BY_TOKEN,
  DAILY_CAP,
  MISSING_MAIL,
  MISSING_ADMIN,
  MISSING_REDIS,
  readResendConfig,
  readAdminToken,
  tokensMatch,
  normalizeEmail,
  renderNewsletter,
  listHeaders,
  unsubscribeUrl,
  wrapHtml,
  redisCommand,
  ensureToken,
  removeSubscriber,
  sendViaResend,
  newsletterFile,
  readNewsletterFile,
  runSend,
  welcomeContent,
  deliverOne,
  confirmationPage,
  reserveSend,
};
