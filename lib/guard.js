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

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

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

function createLimiter({ perIpPerMinute, perIpPerHour, globalPerMinute }) {
  const hitsByIp = new Map();
  let globalHits = [];
  let nowFn = () => Date.now();

  function check(ip) {
    const now = nowFn();
    const minuteCutoff = now - MINUTE_MS;
    const hourCutoff = now - HOUR_MS;

    globalHits = globalHits.filter((stamp) => stamp > minuteCutoff);

    const recent = (hitsByIp.get(ip) || []).filter((stamp) => stamp > hourCutoff);
    const minuteCount = recent.filter((stamp) => stamp > minuteCutoff).length;

    if (
      minuteCount >= perIpPerMinute ||
      recent.length >= perIpPerHour ||
      globalHits.length >= globalPerMinute
    ) {
      hitsByIp.set(ip, recent);
      let retryAfterMs = MINUTE_MS;
      if (minuteCount >= perIpPerMinute) {
        const oldestMinute = recent.find((stamp) => stamp > minuteCutoff);
        retryAfterMs = MINUTE_MS - (now - oldestMinute);
      } else if (globalHits.length >= globalPerMinute) {
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

  return {
    check,
    reset() {
      hitsByIp.clear();
      globalHits = [];
      nowFn = () => Date.now();
    },
    setNow(fn) {
      nowFn = fn;
    },
    limits: { perIpPerMinute, perIpPerHour, globalPerMinute },
  };
}

function readJsonBody(req, maxChars) {
  let body = req.body;
  if (Buffer.isBuffer(body)) {
    if (body.length > maxChars) return { kind: 'too-long' };
    body = body.toString('utf8');
  }
  if (typeof body === 'string') {
    if (body.length > maxChars) return { kind: 'too-long' };
    try {
      body = JSON.parse(body);
    } catch {
      return { kind: 'missing' };
    }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { kind: 'missing' };
  return { kind: 'ok', body };
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

function beginRequest(req, res) {
  const originHeader = firstHeader(req, 'origin');
  const originAllowed = originHeader ? isAllowedOrigin(originHeader) : false;
  if (originAllowed) applyCors(res, originHeader);

  if (req.method === 'OPTIONS') {
    if (originHeader && !originAllowed) {
      res.status(403).end();
      return { done: true };
    }
    res.status(204).end();
    return { done: true };
  }

  if (originHeader && !originAllowed) {
    sendError(res, 403, CLIENT_ERRORS.forbidden);
    return { done: true };
  }

  if (req.method !== 'POST') {
    sendError(res, 405, CLIENT_ERRORS.method);
    return { done: true };
  }

  return { done: false };
}

module.exports = {
  CLIENT_ERRORS,
  apiKey,
  redact,
  scrubKey,
  clientIp,
  createLimiter,
  readJsonBody,
  sendError,
  beginRequest,
};
