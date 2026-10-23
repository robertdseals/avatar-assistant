// Best-effort limiter. On Vercel this memory belongs to a single warm
// server copy and is wiped on a cold start, so the same visitor can be
// under the limit on one copy and over it on another. It stops casual
// bursts. A shared counter (Upstash Redis or Vercel KV) is required to
// enforce one limit across every copy.

const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent';

const SYSTEM_INSTRUCTION =
  'Your name is Shaley (pronounced Shay-lee). You are a helpful voice assistant. Respond in plain conversational text without any markdown formatting, asterisks, hashtags, bold text, or special characters. Keep responses natural and easy to read aloud. Do not use bullet points or numbered lists - write in natural paragraphs.';

const MAX_MESSAGE_CHARS = 2000;
const MAX_BODY_CHARS = 20000;
const PER_IP_PER_MINUTE = 8;
const PER_IP_PER_HOUR = 40;
const GLOBAL_PER_MINUTE = 20;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const CLIENT_ERRORS = {
  generic: "Sorry, I couldn't answer just now. Please try again in a moment.",
  rate: "You're sending messages too quickly. Please wait a little while and try again.",
  tooLong: 'That message is too long. Please shorten it and try again.',
  missing: 'Message is required',
  method: 'Method not allowed',
  forbidden: 'This chat can only be used from the Shaley Gardens website.',
};

const ALLOWED_SITE_ORIGINS = new Set([
  'https://shaleygardens.com',
  'https://www.shaleygardens.com',
]);

const hitsByIp = new Map();
let globalHits = [];
let nowFn = () => Date.now();

function firstHeader(req, name) {
  const value = req.headers && req.headers[name.toLowerCase()];
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' ? raw.trim() : '';
}

function apiKey() {
  const key = process.env.AVITAR_KEY;
  return typeof key === 'string' ? key.trim() : '';
}

function redact(value) {
  let text;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  const key = apiKey();
  if (key) {
    text = text.split(key).join('[redacted]');
    const encoded = encodeURIComponent(key);
    if (encoded !== key) text = text.split(encoded).join('[redacted]');
  }
  text = text.replace(/([?&]key=)[^&\s'"]+/gi, '$1[redacted]');
  if (text.length > 1500) text = text.slice(0, 1500);
  return text;
}

function scrubKey(text) {
  const key = apiKey();
  if (!key || typeof text !== 'string') return typeof text === 'string' ? text.trim() : '';
  let out = text.split(key).join('');
  const encoded = encodeURIComponent(key);
  if (encoded !== key) out = out.split(encoded).join('');
  return out.trim();
}

function originFromHost(value) {
  if (!value || typeof value !== 'string') return '';
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withProtocol);
    if (parsed.protocol !== 'https:') return '';
    if (parsed.username || parsed.password) return '';
    return parsed.origin;
  } catch {
    return '';
  }
}

function allowedOrigins() {
  const allowed = new Set(ALLOWED_SITE_ORIGINS);
  for (const name of ['VERCEL_URL', 'VERCEL_BRANCH_URL', 'VERCEL_PROJECT_PRODUCTION_URL']) {
    const origin = originFromHost(process.env[name]);
    if (origin) allowed.add(origin);
  }
  return allowed;
}

function isAllowedOrigin(originHeader) {
  if (!originHeader || originHeader.length > 200) return false;
  let parsed;
  try {
    parsed = new URL(originHeader);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return false;
  if (parsed.pathname !== '/' && parsed.pathname !== '') return false;
  return allowedOrigins().has(parsed.origin);
}

function applyCors(res, originHeader) {
  let parsed;
  try {
    parsed = new URL(originHeader);
  } catch {
    return;
  }
  res.setHeader('Access-Control-Allow-Origin', parsed.origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function clientIp(req) {
  const realIp = firstHeader(req, 'x-real-ip');
  const forwarded = firstHeader(req, 'x-forwarded-for').split(',')[0].trim();
  const candidate = realIp || forwarded;
  if (!candidate || candidate.length > 80 || /\s/.test(candidate)) return 'unknown';
  return candidate;
}

function checkRateLimit(ip) {
  const now = nowFn();
  const minuteCutoff = now - MINUTE_MS;
  const hourCutoff = now - HOUR_MS;

  globalHits = globalHits.filter((stamp) => stamp > minuteCutoff);

  const recent = (hitsByIp.get(ip) || []).filter((stamp) => stamp > hourCutoff);
  const minuteCount = recent.filter((stamp) => stamp > minuteCutoff).length;

  if (
    minuteCount >= PER_IP_PER_MINUTE ||
    recent.length >= PER_IP_PER_HOUR ||
    globalHits.length >= GLOBAL_PER_MINUTE
  ) {
    hitsByIp.set(ip, recent);
    let retryAfterMs = MINUTE_MS;
    if (minuteCount >= PER_IP_PER_MINUTE) {
      const oldestMinute = recent.find((stamp) => stamp > minuteCutoff);
      retryAfterMs = MINUTE_MS - (now - oldestMinute);
    } else if (globalHits.length >= GLOBAL_PER_MINUTE) {
      retryAfterMs = MINUTE_MS - (now - globalHits[0]);
    } else if (recent.length) {
      retryAfterMs = HOUR_MS - (now - recent[0]);
    }
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }

  recent.push(now);
  hitsByIp.set(ip, recent);
  globalHits.push(now);

  if (hitsByIp.size > 5000) {
    for (const [key, stamps] of hitsByIp) {
      if (!stamps.length || stamps[stamps.length - 1] <= hourCutoff) hitsByIp.delete(key);
    }
  }

  return { ok: true };
}

function resetRateLimitForTests() {
  hitsByIp.clear();
  globalHits = [];
  nowFn = () => Date.now();
}

function readMessage(req) {
  let body = req.body;
  if (Buffer.isBuffer(body)) {
    if (body.length > MAX_BODY_CHARS) return { kind: 'too-long' };
    body = body.toString('utf8');
  }
  if (typeof body === 'string') {
    if (body.length > MAX_BODY_CHARS) return { kind: 'too-long' };
    try {
      body = JSON.parse(body);
    } catch {
      return { kind: 'missing' };
    }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { kind: 'missing' };
  const message = body.message;
  if (typeof message !== 'string') return { kind: 'missing' };
  if (message.length > MAX_MESSAGE_CHARS) return { kind: 'too-long' };
  const trimmed = message.trim();
  if (!trimmed) return { kind: 'missing' };
  return { kind: 'ok', message: trimmed };
}

function sendError(res, status, error, headers) {
  res.setHeader('Cache-Control', 'no-store');
  if (headers) {
    for (const [name, value] of Object.entries(headers)) {
      res.setHeader(name, value);
    }
  }
  return res.status(status).json({ error });
}

async function handler(req, res) {
  const originHeader = firstHeader(req, 'origin');
  const originAllowed = originHeader ? isAllowedOrigin(originHeader) : false;
  if (originAllowed) applyCors(res, originHeader);

  if (req.method === 'OPTIONS') {
    if (originHeader && !originAllowed) return res.status(403).end();
    return res.status(204).end();
  }

  if (originHeader && !originAllowed) {
    return sendError(res, 403, CLIENT_ERRORS.forbidden);
  }

  if (req.method !== 'POST') {
    return sendError(res, 405, CLIENT_ERRORS.method);
  }

  const parsed = readMessage(req);
  if (parsed.kind === 'too-long') return sendError(res, 400, CLIENT_ERRORS.tooLong);
  if (parsed.kind !== 'ok') return sendError(res, 400, CLIENT_ERRORS.missing);

  const ip = clientIp(req);
  const limit = checkRateLimit(ip);
  if (!limit.ok) {
    console.warn('Chat rate limit reached for', ip);
    return sendError(res, 429, CLIENT_ERRORS.rate, {
      'Retry-After': String(limit.retryAfterSeconds),
    });
  }

  const key = apiKey();
  if (!key) {
    console.error('Chat is not configured: AVITAR_KEY is missing');
    return sendError(res, 500, CLIENT_ERRORS.generic);
  }

  try {
    const response = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: parsed.message }] }],
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        tools: [{ googleSearch: {} }],
      }),
    });

    const raw = await response.text();
    if (!response.ok) {
      console.error('Gemini request failed', response.status, redact(raw));
      return sendError(res, 500, CLIENT_ERRORS.generic);
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      console.error('Gemini returned non-JSON', response.status, redact(raw));
      return sendError(res, 500, CLIENT_ERRORS.generic);
    }

    const assistantMessage = scrubKey(data?.candidates?.[0]?.content?.parts?.[0]?.text);
    if (!assistantMessage) {
      console.error('Gemini returned no assistant text', redact(raw));
      return sendError(res, 500, CLIENT_ERRORS.generic);
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ message: assistantMessage });
  } catch (error) {
    const detail = error instanceof Error ? error.message : error;
    console.error('Chat request failed', redact(detail));
    return sendError(res, 500, CLIENT_ERRORS.generic);
  }
}

handler._resetForTests = resetRateLimitForTests;
handler._setNowForTests = (fn) => {
  nowFn = fn;
};
handler._limits = {
  maxMessageChars: MAX_MESSAGE_CHARS,
  perIpPerMinute: PER_IP_PER_MINUTE,
  perIpPerHour: PER_IP_PER_HOUR,
  globalPerMinute: GLOBAL_PER_MINUTE,
};

module.exports = handler;
