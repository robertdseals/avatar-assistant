const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  listPublishedNewsletters,
  publishNewsletterSite,
  renderArchivePage,
  renderIssuePage,
} = require('../lib/newsletter-pages');

function writeIssue(dir, name, markdown) {
  fs.writeFileSync(path.join(dir, name), markdown);
}

test('unpublished drafts stay off the archive, including a December file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shaley-news-'));
  writeIssue(dir, '2026-11-november.md', `---
sent: true
date: 2026-11-01
---
# November in your Central Florida garden

Hello from November.
`);
  writeIssue(dir, '2026-12-december.md', `# December in your Central Florida garden

Draft only. Do not send this note, and do not publish it on the website.

sent: true

This December draft must stay hidden.
`);
  writeIssue(dir, '2026-10-october.md', `---
published: true
date: 2026-10-02
---
# October in the garden

An earlier sent note.
`);
  writeIssue(dir, '2027-01-january.md', `---
sent: false
date: 2027-01-01
---
# January in the garden

Not sent yet.
`);
  fs.mkdirSync(path.join(dir, 'drafts'));
  fs.writeFileSync(path.join(dir, 'drafts', '2026-12-el-nino-section.md'), `---
sent: true
date: 2026-12-20
---
# Hidden draft

This section is not an issue.
`);

  const issues = listPublishedNewsletters(dir);
  assert.deepEqual(issues.map((issue) => issue.slug), ['2026-11-november', '2026-10-october']);

  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'shaley-news-out-'));
  fs.mkdirSync(path.join(out, '2026-12-december'));
  fs.writeFileSync(path.join(out, '2026-12-december', 'index.html'), 'old december page');
  publishNewsletterSite({ newsletterDir: dir, outDir: out });

  const archive = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  const november = fs.readFileSync(path.join(out, '2026-11-november', 'index.html'), 'utf8');
  const combined = `${archive}\n${november}`;
  assert.match(archive, /href="\/newsletters\/2026-11-november"/);
  assert.match(archive, /href="\/newsletters\/2026-10-october"/);
  assert.equal(combined.includes('2026-12-december'), false);
  assert.equal(combined.includes('December in your Central Florida garden'), false);
  assert.equal(combined.includes('This December draft must stay hidden'), false);
  assert.equal(combined.includes('January in the garden'), false);
  assert.equal(combined.includes('Hidden draft'), false);
  assert.equal(fs.existsSync(path.join(out, '2026-12-december')), false);
  assert.match(november, /src="\/assets\/logo-web\.png"/);
  assert.match(november, /class="site-logo"/);
  assert.match(november, /name="viewport"/);
  assert.match(november, /id="signupForm"/);
  assert.match(november, /src="\/js\/signup\.js"/);
  assert.match(november, /src="\/js\/site-alert\.js"/);
  assert.equal((november.match(/<script/gi) || []).length, 2);
  assert.equal(/api\/send-newsletter|ADMIN_SEND_TOKEN|RESEND_API_KEY|KV_REST/.test(combined), false);
});

test('the public archive lists the sent November issue and reuses the home sign-up', () => {
  const root = path.join(__dirname, '..');
  const issues = listPublishedNewsletters(path.join(root, 'newsletter'));
  assert.deepEqual(issues.map((issue) => issue.slug), ['2026-11-november']);

  const archive = fs.readFileSync(path.join(root, 'newsletters/index.html'), 'utf8');
  const issue = fs.readFileSync(path.join(root, 'newsletters/2026-11-november/index.html'), 'utf8');
  assert.equal(archive, renderArchivePage(issues));
  assert.equal(issue, renderIssuePage(issues[0]));
  assert.match(archive, /The newest issue is first/);
  assert.match(archive, /href="\/newsletters\/2026-11-november"/);
  assert.match(archive, /November 2026/);
  assert.equal(archive.includes('2026-12-december'), false);
  assert.equal(issue.includes('December in your Central Florida garden'), false);
  assert.match(issue, /What to plant now/);
  assert.match(issue, /freeze\.html/);
  assert.match(issue, /lawns\.html/);
  assert.match(issue, /fall-vegetables\.html/);
  assert.match(issue, /calendar\.html/);
  assert.match(issue, /All newsletters/);
  assert.equal(/draft only/i.test(issue), false);
  assert.equal(/nothing in this draft has been sent/i.test(issue), false);
  assert.equal(/<script/gi.test(issue) && (issue.match(/<script/gi) || []).length === 2, true);
  assert.match(issue, /src="\/js\/site-alert\.js"/);

  const home = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const signup = home.match(/<section class="signup"[\s\S]*?<\/section>/)[0];
  assert.equal((home.match(/id="signupForm"/g) || []).length, 1);
  assert.match(home, /Free monthly Central Florida garden tips/);
  assert.match(archive, new RegExp(signup.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(issue, new RegExp(signup.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(fs.readFileSync(path.join(root, 'js/signup.js'), 'utf8'), /\/api\/subscribe/);

  const pages = [
    'index.html',
    'calendar.html',
    'privacy.html',
    'freeze.html',
    'lawns.html',
    'fall-vegetables.html',
    'guides/index.html',
    'newsletters/index.html',
    'newsletters/2026-11-november/index.html',
  ];
  for (const file of pages) {
    assert.match(fs.readFileSync(path.join(root, file), 'utf8'), /href="\/newsletters"/);
  }
  assert.match(fs.readFileSync(path.join(root, 'sitemap.xml'), 'utf8'), /https:\/\/shaleygardens\.com\/newsletters</);
  assert.match(fs.readFileSync(path.join(root, 'sitemap.xml'), 'utf8'), /https:\/\/shaleygardens\.com\/newsletters\/2026-11-november</);
  assert.equal(/api\/send-newsletter|ADMIN_SEND_TOKEN|RESEND_API_KEY/.test(`${archive}\n${issue}`), false);
});
