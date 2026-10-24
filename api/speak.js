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

// Cheaper conversational voice. A non-streaming reply is a WAV file.
const SPEAK_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-lite-tts:generateContent';

const MAX_BODY_CHARS = 8000;
const MAX_INPUT_CHARS = 4000;
const MAX_SPOKEN_CHARS = 700;
const MAX_AUDIO_BYTES = 2500000;
const VOICE_NAME = 'Sulafat';

const limiter = createLimiter({
  name: 'speak',
  perIpPerMinute: 8,
  perIpPerHour: 40,
  globalPerMinute: 20,
});

function clipForSpeech(text) {
  const clean = scrubKey(text).replace(/[*#`_]/g, '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= MAX_SPOKEN_CHARS) return clean;
  const slice = clean.slice(0, MAX_SPOKEN_CHARS);
  const end = Math.max(slice.lastIndexOf('.'), slice.lastIndexOf('!'), slice.lastIndexOf('?'));
  if (end >= 80) return slice.slice(0, end + 1);
  return slice;
}

function pcmToWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function wavBase64(inlineData) {
  if (!inlineData || typeof inlineData.data !== 'string') return '';
  let buf;
  try {
    buf = Buffer.from(inlineData.data, 'base64');
  } catch {
    return '';
  }
  if (buf.length < 44 || buf.length > MAX_AUDIO_BYTES) return '';
  const mime = String(inlineData.mimeType || '');
  if (buf.slice(0, 4).toString('ascii') === 'RIFF') return buf.toString('base64');
  if (!/l16|pcm/i.test(mime)) return '';
  const rateMatch = mime.match(/rate=(\d+)/i);
  const rate = rateMatch ? Number(rateMatch[1]) : 24000;
  const wav = pcmToWav(buf, rate);
  if (wav.length > MAX_AUDIO_BYTES) return '';
  return wav.toString('base64');
}

function readSpeech(req) {
  const parsed = readJsonBody(req, MAX_BODY_CHARS);
  if (parsed.kind !== 'ok') return parsed;
  const text = parsed.body.text;
  if (typeof text !== 'string') return { kind: 'missing' };
  if (text.length > MAX_INPUT_CHARS) return { kind: 'too-long' };
  const spoken = clipForSpeech(text);
  if (!spoken) return { kind: 'missing' };
  return { kind: 'ok', spoken };
}

async function handler(req, res) {
  const gate = beginRequest(req, res);
  if (gate.done) return;

  const parsed = readSpeech(req);
  if (parsed.kind === 'too-long') return sendError(res, 400, CLIENT_ERRORS.tooLong);
  if (parsed.kind !== 'ok') return sendError(res, 400, CLIENT_ERRORS.missing);

  const ip = clientIp(req);
  const limit = await limiter.check(ip);
  if (!limit.ok) {
    console.warn('Speech rate limit reached for', ip);
    return sendError(res, 429, CLIENT_ERRORS.rate, {
      'Retry-After': String(limit.retryAfterSeconds),
    });
  }

  const key = apiKey();
  if (!key) {
    console.error('Speech is not configured: AVITAR_KEY is missing');
    return sendError(res, 500, CLIENT_ERRORS.generic);
  }

  try {
    const response = await fetch(SPEAK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key,
      },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [{
            text: parsed.spoken,
            speech_metadata: { style: 'warm, calm, and friendly' },
          }],
        }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: { voice: VOICE_NAME },
          },
        },
      }),
    });

    const raw = await response.text();
    if (!response.ok) {
      console.error('Speech request failed', response.status, redact(raw));
      return sendError(res, 500, CLIENT_ERRORS.generic);
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      console.error('Speech returned non-JSON', response.status);
      return sendError(res, 500, CLIENT_ERRORS.generic);
    }

    const parts = data?.candidates?.[0]?.content?.parts || [];
    const audioPart = parts.find((part) => part && part.inlineData && part.inlineData.data);
    const audio = wavBase64(audioPart && audioPart.inlineData);
    if (!audio) {
      console.error('Speech returned no usable audio');
      return sendError(res, 500, CLIENT_ERRORS.generic);
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ audio });
  } catch (error) {
    const detail = error instanceof Error ? error.message : error;
    console.error('Speech request failed', redact(detail));
    return sendError(res, 500, CLIENT_ERRORS.generic);
  }
}

handler._resetForTests = () => limiter.reset();
handler._setNowForTests = (fn) => limiter.setNow(fn);
handler._limits = {
  maxSpokenChars: MAX_SPOKEN_CHARS,
  perIpPerMinute: limiter.limits.perIpPerMinute,
  perIpPerHour: limiter.limits.perIpPerHour,
  globalPerMinute: limiter.limits.globalPerMinute,
};

module.exports = handler;
