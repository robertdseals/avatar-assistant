const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function words(text) {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function guideProse(file) {
  const html = fs.readFileSync(file, 'utf8');
  const article = html.match(/<article[\s\S]*?<\/article>/)[0];
  return words(article.replace(/<section class="sources"[\s\S]*<\/section>/, ''));
}

test('local guides are linked, sourced, and in the requested length', () => {
  const guides = [
    ['freeze.html', 'Protecting your plants from a Central Florida freeze', '/?ask=freeze'],
    ['lawns.html', 'Best lawn grasses for sandy Ocala soil', '/?ask=lawn'],
    ['fall-vegetables.html', 'Fall and winter vegetables for Marion County', '/?ask=fall-vegetables'],
  ];
  const sitemap = fs.readFileSync('sitemap.xml', 'utf8');
  const home = fs.readFileSync('index.html', 'utf8');
  const banned = /\b(seafood|shrimp|oyster|lobster|scallop|tuna|salmon)\b/i;

  for (const [file, title, ask] of guides) {
    const html = fs.readFileSync(file, 'utf8');
    const count = guideProse(file).length;
    assert.ok(count >= 600 && count <= 900, `${file} has ${count} words`);
    assert.match(html, new RegExp(`<title>${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\| Shaley Gardens</title>`));
    assert.match(html, /name="description"/);
    assert.match(html, /Ask Shaley about this/);
    assert.match(html, new RegExp(ask.replace('?', '\\?')));
    assert.match(html, /ask\.ifas\.ufl\.edu|gardeningsolutions\.ifas\.ufl\.edu/);
    assert.match(html, /class="sources"/);
    assert.match(home, new RegExp(file.replace('.', '\\.')));
    assert.match(sitemap, new RegExp(`https://shaleygardens.com/${file}`));
    assert.equal(banned.test(html), false);
  }

  assert.match(home, /linkedQuestions/);
  assert.match(home, /ask=freeze|freeze:/);
  assert.match(fs.readFileSync('calendar.html', 'utf8'), /freeze\.html/);
  assert.match(fs.readFileSync('privacy.html', 'utf8'), /fall-vegetables\.html/);
});

test('the November newsletter is a draft and is not on the site', () => {
  const draft = fs.readFileSync('newsletter/2026-11-november.md', 'utf8');
  const body = draft.replace(/^#.*\n+/, '').replace(/^Draft only\..*\n+/, '');
  const count = words(body).length;
  assert.match(draft, /^# November in your Central Florida garden/);
  assert.ok(count >= 400 && count <= 600, `newsletter has ${count} words`);
  assert.match(draft, /freeze\.html/);
  assert.match(draft, /lawns\.html/);
  assert.match(draft, /fall-vegetables\.html/);
  assert.match(draft, /calendar\.html/);
  assert.match(draft, /Do not send/);
  assert.equal(/\b(seafood|shrimp|oyster|lobster|scallop|tuna|salmon)\b/i.test(draft), false);
  const pages = ['index.html', 'calendar.html', 'privacy.html', 'freeze.html', 'lawns.html', 'fall-vegetables.html', 'sitemap.xml', 'robots.txt']
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
  assert.equal(pages.includes('newsletter/'), false);
  assert.match(fs.readFileSync('.vercelignore', 'utf8'), /^newsletter\s*$/m);
});
