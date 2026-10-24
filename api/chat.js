const {
  CLIENT_ERRORS,
  apiKey,
  redact,
  scrubKey,
  clientIp,
  createLimiter,
  readJsonBody,
  sendError,
  beginRequest,
} = require('../lib/guard');

const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent';

const SYSTEM_INSTRUCTION =
  'Your name is Shaley (pronounced Shay-lee). You are a friendly garden helper for home gardeners in Central Florida, especially Ocala, Marion County, and The Villages, in USDA hardiness zones 9a and 9b. Stay on home gardening: vegetables, herbs, flowers, lawns, sandy soil, watering, and weather. Base advice on University of Florida IFAS Extension guidance, including Florida-Friendly Landscaping. When it helps, name the relevant UF/IFAS page or suggest the Marion County Extension office. If you are not sure, say so plainly. Do not give pesticide or chemical mixing amounts, spray rates, or doses. Tell people to follow the product label and ask Marion County Extension or UF/IFAS when they need product help. If a request is not about gardening, say briefly that you help with Central Florida gardens and invite a garden question. Respond in plain conversational text without markdown, asterisks, hashtags, or special characters. Do not use bullet points or numbered lists. Write short, friendly sentences that are easy for older adults to read and hear. Keep most replies to two or three short sentences. You can remember earlier turns from this visit and should use them when they help. You do not remember anything from before this visit. Your answers are general guidance, not a professional consultation.';

const MAX_MESSAGE_CHARS = 2000;
const MAX_BODY_CHARS = 48000;
const MAX_HISTORY_TURNS = 8;
const MAX_HISTORY_CHARS = 6000;

const limiter = createLimiter({
  name: 'chat',
  perIpPerMinute: 8,
  perIpPerHour: 40,
  globalPerMinute: 20,
});

function normalizeHistory(body) {
  if (!body || !Array.isArray(body.history)) return [];
  const cleaned = [];
  for (const item of body.history.slice(0, 30)) {
    if (!item || typeof item !== 'object') continue;
    let role = '';
    if (item.role === 'user') role = 'user';
    else if (item.role === 'assistant' || item.role === 'model') role = 'model';
    else continue;
    if (typeof item.text !== 'string') continue;
    let text = scrubKey(item.text).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (text.length > MAX_MESSAGE_CHARS) text = text.slice(0, MAX_MESSAGE_CHARS);
    const previous = cleaned[cleaned.length - 1];
    if (previous && previous.role === role) {
      previous.text = `${previous.text} ${text}`.slice(0, MAX_MESSAGE_CHARS);
      continue;
    }
    cleaned.push({ role, text });
  }

  const recent = [];
  let total = 0;
  for (let i = cleaned.length - 1; i >= 0; i -= 1) {
    if (recent.length >= MAX_HISTORY_TURNS) break;
    const item = cleaned[i];
    if (total + item.text.length > MAX_HISTORY_CHARS) break;
    recent.push(item);
    total += item.text.length;
  }
  recent.reverse();
  while (recent.length && recent[0].role !== 'user') recent.shift();
  return recent;
}

function buildContents(history, message) {
  const turns = history.slice();
  let text = message;
  if (turns.length && turns[turns.length - 1].role === 'user') {
    const earlier = turns.pop();
    const room = MAX_MESSAGE_CHARS - text.length - 1;
    if (room > 20) text = `${earlier.text.slice(0, room)} ${text}`;
  }
  return [
    ...turns.map((turn) => ({ role: turn.role, parts: [{ text: turn.text }] })),
    { role: 'user', parts: [{ text }] },
  ];
}

function readMessage(req) {
  const parsed = readJsonBody(req, MAX_BODY_CHARS);
  if (parsed.kind !== 'ok') return parsed;
  const message = parsed.body.message;
  if (typeof message !== 'string') return { kind: 'missing' };
  if (message.length > MAX_MESSAGE_CHARS) return { kind: 'too-long' };
  const trimmed = scrubKey(message);
  if (!trimmed) return { kind: 'missing' };
  return { kind: 'ok', message: trimmed, history: normalizeHistory(parsed.body) };
}

async function handler(req, res) {
  const gate = beginRequest(req, res);
  if (gate.done) return;

  const parsed = readMessage(req);
  if (parsed.kind === 'too-long') return sendError(res, 400, CLIENT_ERRORS.tooLong);
  if (parsed.kind !== 'ok') return sendError(res, 400, CLIENT_ERRORS.missing);

  const ip = clientIp(req);
  const limit = await limiter.check(ip);
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

  const contents = buildContents(parsed.history, parsed.message);

  try {
    const response = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key,
      },
      body: JSON.stringify({
        contents,
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

handler._resetForTests = () => limiter.reset();
handler._setNowForTests = (fn) => limiter.setNow(fn);
handler._limits = {
  maxMessageChars: MAX_MESSAGE_CHARS,
  maxHistoryTurns: MAX_HISTORY_TURNS,
  maxHistoryChars: MAX_HISTORY_CHARS,
  perIpPerMinute: limiter.limits.perIpPerMinute,
  perIpPerHour: limiter.limits.perIpPerHour,
  globalPerMinute: limiter.limits.globalPerMinute,
};

module.exports = handler;
