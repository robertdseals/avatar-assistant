const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('the page is branded as Shaley Gardens and built for phones', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  assert.match(html, /<title>Shaley Gardens<\/title>/);
  assert.match(html, /name="viewport"/);
  assert.match(html, /assets\/shaley\.jpg/);
  assert.match(html, /id="micBtn"/);
  assert.match(html, /history/);
  assert.match(html, /\/api\/speak/);
  assert.equal(/Avatar Assistant/i.test(html), false);
  assert.equal(/robot/i.test(html), false);
  assert.equal(fs.existsSync('assets/shaley.jpg'), true);
  assert.equal(fs.existsSync('favicon.svg'), true);
});
