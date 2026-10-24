const {
  readAdminToken,
  tokensMatch,
  readNewsletterFile,
  runSend,
  MISSING_ADMIN,
} = require('../lib/newsletter');

const MAX_MARKDOWN = 80000;

function header(req, name) {
  const value = req.headers && req.headers[name.toLowerCase()];
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' ? raw.trim() : '';
}

function authorized(req) {
  const expected = readAdminToken();
  if (!expected) return 'missing';
  const auth = header(req, 'authorization');
  const bearer = /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '').trim() : '';
  const provided = bearer || header(req, 'x-admin-token');
  if (!provided || !tokensMatch(provided, expected)) return 'no';
  return 'yes';
}

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  let body = req.body;
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string') {
    if (body.length > MAX_MARKDOWN * 2) return { error: 'That request is too large. Nothing was sent.' };
    try {
      body = JSON.parse(body);
    } catch {
      return { error: 'Send a JSON body. Nothing was sent.' };
    }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Send a JSON body. Nothing was sent.' };
  }
  return { body };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { error: 'Method not allowed' });
  }

  const access = authorized(req);
  if (access === 'missing') return json(res, 503, { error: MISSING_ADMIN });
  if (access !== 'yes') return json(res, 401, { error: 'That send request was not accepted. Nothing was sent.' });

  const parsed = readBody(req);
  if (parsed.error) return json(res, 400, { error: parsed.error });
  const body = parsed.body;

  let markdown = typeof body.markdown === 'string' ? body.markdown : '';
  if (markdown.length > MAX_MARKDOWN) {
    return json(res, 400, { error: 'That newsletter is too long. Nothing was sent.' });
  }
  if (!markdown) {
    const loaded = readNewsletterFile(body.file);
    if (loaded.error) return json(res, 400, { error: loaded.error });
    markdown = loaded.markdown;
  }

  try {
    const result = await runSend({
      adminAlreadyChecked: true,
      mode: body.mode,
      to: body.to,
      confirm: body.confirm === true,
      again: body.again === true,
      file: body.file,
      markdown,
      batchSize: 20,
      pauseMs: 500,
    });
    return json(res, result.status, result.body);
  } catch {
    console.error('Newsletter send stopped');
    return json(res, 503, { error: 'The send stopped before it finished. Run the same command again to continue. Nothing more was sent.' });
  }
};
