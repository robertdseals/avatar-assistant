#!/usr/bin/env node
const fs = require('fs');
const {
  readAdminToken,
  readResendConfig,
  readNewsletterFile,
  runSend,
  MISSING_ADMIN,
  MISSING_MAIL,
} = require('../lib/newsletter');
const { readRedisConfig } = require('../lib/guard');

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return '';
  return process.argv[index + 1] || '';
}

function flag(name) {
  return process.argv.includes(name);
}

async function main() {
  const fileArg = arg('--file') || 'newsletter/2026-11-november.md';
  const testTo = arg('--test');
  const confirm = flag('--confirm');
  const again = flag('--again');
  const url = arg('--url').replace(/\/+$/, '');
  const loaded = readNewsletterFile(fileArg);
  if (loaded.error) {
    console.error(loaded.error);
    process.exitCode = 1;
    return;
  }

  if (!readAdminToken()) {
    console.error(MISSING_ADMIN);
    process.exitCode = 1;
    return;
  }

  const payload = {
    file: loaded.file.rel,
    markdown: loaded.markdown,
    again,
    mode: testTo ? 'test' : 'full',
    confirm: testTo ? false : confirm,
    to: testTo,
  };

  if (!testTo && !confirm) {
    console.error('A full send needs --confirm. Nothing was sent.');
    process.exitCode = 1;
    return;
  }

  if (url) {
    if (!/^https:\/\/[a-z0-9.-]+$/i.test(url)) {
      console.error('Pass --url as https://shaleygardens.com. Nothing was sent.');
      process.exitCode = 1;
      return;
    }
    let sent = 0;
    let guard = 0;
    while (guard < 20) {
      guard += 1;
      const response = await fetch(`${url}/api/send-newsletter`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${readAdminToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.error) {
        console.error(body.error || 'The send was not accepted.');
        console.error('If some notes already went out, run the same command again. It skips addresses that already received this file.');
        process.exitCode = 1;
        return;
      }
      sent += Number(body.sent) || 0;
      console.log(JSON.stringify({ status: body.status, mode: body.mode, sent: body.sent, remaining: body.remaining, failed: body.failed }));
      if (body.message) console.log(body.message);
      if (payload.mode === 'test' || body.status === 'sent' || !body.sent) return;
    }
    console.log(JSON.stringify({ status: 'partial', sent }));
    return;
  }

  if (!readResendConfig()) {
    console.error(MISSING_MAIL);
    process.exitCode = 1;
    return;
  }
  if (!readRedisConfig()) {
    console.error('Newsletter sending is turned off. Set KV_REST_API_URL and KV_REST_API_TOKEN. Nothing was sent.');
    process.exitCode = 1;
    return;
  }

  const result = await runSend({
    mode: payload.mode,
    to: payload.to,
    confirm: payload.mode === 'full',
    again,
    file: payload.file,
    markdown: payload.markdown,
    batchSize: 100,
    pauseMs: 600,
  });
  if (result.body.error) {
    console.error(result.body.error);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({
    status: result.body.status,
    mode: result.body.mode,
    sent: result.body.sent,
    remaining: result.body.remaining,
    failed: result.body.failed,
  }));
  if (result.body.message) console.log(result.body.message);
}

main().catch(() => {
  console.error('The send stopped because of an unexpected error. Nothing more was sent.');
  process.exitCode = 1;
});
