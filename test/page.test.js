const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('the page is branded as Shaley Gardens and built for phones', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  assert.match(html, /<title>Shaley Gardens \| Garden help for Ocala and Central Florida<\/title>/);
  assert.match(html, /name="description"/);
  assert.match(html, /property="og:title"/);
  assert.match(html, /property="og:description"/);
  assert.match(html, /property="og:image"/);
  assert.match(html, /name="viewport"/);
  assert.match(html, /assets\/shaley\.jpg/);
  assert.match(html, /id="micBtn"/);
  assert.match(html, /history/);
  assert.match(html, /\/api\/speak/);
  assert.match(html, /Your friendly garden helper for Ocala and Central Florida/);
  assert.match(html, /What can I plant in November\?/);
  assert.match(html, /How do I protect plants from a freeze\?/);
  assert.match(html, /What grass grows best in sandy soil\?/);
  assert.match(html, /How do I get rid of fire ants safely\?/);
  assert.match(html, /id="autoVoice"/);
  assert.equal(/id="autoVoice"[^>]*checked/.test(html), false);
  assert.match(html, /shaley-auto-voice/);
  assert.match(html, /className = 'hear'/);
  assert.match(html, /Listen to answer/);
  assert.match(html, /Listen to Shaley's answer/);
  assert.match(html, /Playing…/);
  assert.match(html, /Playing Shaley's answer/);
  assert.match(html, /if \(autoVoice\.checked\)/);
  assert.match(fs.readFileSync('js/signup.js', 'utf8'), /\/api\/subscribe/);
  assert.match(html, /name="website"/);
  assert.match(html, /calendar\.html/);
  assert.match(html, /privacy\.html/);
  assert.equal(/Avatar Assistant/i.test(html), false);
  assert.equal(/robot/i.test(html), false);
  assert.equal(fs.existsSync('assets/shaley.jpg'), true);
  assert.equal(fs.existsSync('favicon.svg'), true);
  assert.equal(fs.existsSync('robots.txt'), true);
  assert.equal(fs.existsSync('sitemap.xml'), true);
});

test('the planting calendar, weather tips, and privacy note stay on plants', () => {
  const calendar = fs.readFileSync('calendar.html', 'utf8');
  const privacy = fs.readFileSync('privacy.html', 'utf8');
  const robots = fs.readFileSync('robots.txt', 'utf8');
  const sitemap = fs.readFileSync('sitemap.xml', 'utf8');
  for (const month of ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']) {
    assert.match(calendar, new RegExp(`id="${month}"`));
  }
  assert.match(calendar, /id="herbs"/);
  assert.match(calendar, /id="weather"/);
  assert.match(calendar, /ask\.ifas\.ufl\.edu\/publication\/VH021/);
  assert.match(calendar, /gardeningsolutions\.ifas\.ufl\.edu/);
  assert.match(privacy, /browser for the visit/);
  assert.match(privacy, /only for the garden newsletter/);
  assert.match(privacy, /unsubscribe/i);
  assert.match(privacy, /general guidance/);
  assert.match(privacy, /Contact: <a href="mailto:hello@shaleygardens.com">hello@shaleygardens.com<\/a>/);
  assert.match(calendar, /mailto:hello@shaleygardens.com/);
  assert.match(fs.readFileSync('index.html', 'utf8'), /mailto:hello@shaleygardens.com/);
  const pages = `${calendar}\n${privacy}\n${fs.readFileSync('index.html', 'utf8')}\n${fs.readFileSync('api/chat.js', 'utf8')}`;
  assert.equal(pages.toLowerCase().includes(['robert', '@'].join('')), false);
  assert.match(robots, /Sitemap: https:\/\/shaleygardens\.com\/sitemap\.xml/);
  assert.match(sitemap, /https:\/\/shaleygardens\.com\/calendar\.html/);
  assert.equal(/\b(seafood|shrimp|oyster|lobster|scallop|tuna|salmon)\b/i.test(pages), false);
});
