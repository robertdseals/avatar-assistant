const fs = require('fs');
const path = require('path');
const {
  formatInline,
  isPublishedIssue,
  parseNewsletter,
} = require('./newsletter');

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const SIGNUP = `        <section class="signup" aria-labelledby="signupTitle">
            <h2 id="signupTitle">Free monthly Central Florida garden tips</h2>
            <p>Leave your email for a short monthly note about planting in Ocala and nearby. Each note has an unsubscribe link.</p>
            <p class="download"><a href="/guides/2026-11-planting-guide.pdf">Free download: November planting guide (PDF)</a></p>
            <form id="signupForm">
                <label class="sr-only" for="email">Email address</label>
                <input id="email" name="email" type="email" autocomplete="email" maxlength="254" placeholder="Email address" required>
                <div class="hp" aria-hidden="true">
                    <label for="website">Leave this blank</label>
                    <input id="website" name="website" type="text" tabindex="-1" autocomplete="off">
                </div>
                <button class="send" type="submit">Sign up</button>
            </form>
            <p id="signupNote" role="status"></p>
        </section>`;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function issueDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) return '';
  return `${MONTHS[month - 1]} ${year}`;
}

function sortKey(issue) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(issue.date) && issueDate(issue.date)) return issue.date;
  const match = /^(\d{4})-(\d{2})/.exec(issue.slug);
  return match ? `${match[1]}-${match[2]}-01` : '0000-00-00';
}

function safeSlug(slug) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug) && !slug.includes('..');
}

function describeIssue(blocks) {
  const first = blocks.find((block) => block.type === 'p');
  const text = first ? formatInline(first.text, true).replace(/\s+/g, ' ').trim() : '';
  if (!text) return 'A note from Shaley Gardens for Ocala, Marion County, and The Villages.';
  if (text.length <= 155) return text;
  const cut = text.slice(0, 152);
  const space = cut.lastIndexOf(' ');
  return `${(space > 80 ? cut.slice(0, space) : cut).trim()}...`;
}

function renderSiteBody(blocks) {
  let skippedTitle = false;
  const parts = [];
  for (const block of blocks) {
    if (block.type === 'h1' && !skippedTitle) {
      skippedTitle = true;
      continue;
    }
    if (block.type === 'ul') {
      const items = block.items.map((item) => `<li>${formatInline(item, false, { site: true })}</li>`).join('');
      parts.push(`            <ul>${items}</ul>`);
      continue;
    }
    const tag = block.type === 'h1' || block.type === 'h2' ? 'h3' : block.type === 'h3' ? 'h4' : 'p';
    parts.push(`            <${tag}>${formatInline(block.text, false, { site: true })}</${tag}>`);
  }
  return parts.join('\n');
}

function listPublishedNewsletters(directory) {
  const base = path.resolve(directory);
  let names = [];
  try {
    names = fs.readdirSync(base);
  } catch {
    return [];
  }
  const issues = [];
  for (const name of names) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(name)) continue;
    const slug = name.slice(0, -3);
    if (!safeSlug(slug)) continue;
    const full = path.join(base, name);
    if (path.resolve(full) !== full && path.resolve(full) !== path.join(base, name)) continue;
    let stat;
    try {
      stat = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const parsed = parseNewsletter(fs.readFileSync(full, 'utf8'));
    if (!isPublishedIssue(parsed.meta)) continue;
    if (!parsed.blocks.length) continue;
    const date = String(parsed.meta.date || '').trim();
    issues.push({
      slug,
      title: parsed.subject,
      date: issueDate(date) ? date : '',
      label: issueDate(date),
      description: describeIssue(parsed.blocks),
      blocks: parsed.blocks,
    });
  }
  issues.sort((left, right) => {
    const byDate = sortKey(right).localeCompare(sortKey(left));
    if (byDate) return byDate;
    return right.slug.localeCompare(left.slug);
  });
  return issues;
}

function pageShell({ title, description, canonicalPath, main }) {
  const canonical = `https://shaleygardens.com${canonicalPath}`;
  const safeTitle = escapeHtml(title);
  const safeDescription = escapeHtml(description);
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <title>${safeTitle} | Shaley Gardens</title>
    <meta name="description" content="${safeDescription}">
    <meta name="theme-color" content="#1f4a38">
    <meta property="og:title" content="${safeTitle} | Shaley Gardens">
    <meta property="og:description" content="${safeDescription}">
    <meta property="og:image" content="https://shaleygardens.com/assets/shaley.jpg">
    <meta property="og:url" content="${canonical}">
    <meta property="og:type" content="website">
    <link rel="icon" href="/assets/logo-mark-web.png" type="image/png" sizes="192x192">
    <link rel="apple-touch-icon" href="/assets/logo-mark-web.png">
    <link rel="canonical" href="${canonical}">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,560;9..144,650&family=Nunito+Sans:ital,opsz,wght@0,6..12,400;0,6..12,650;0,6..12,750&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/css/garden.css">
</head>
<body>
    <div class="page">
        <header class="site-header">
            <p class="eyebrow">Ocala, Marion County, and The Villages</p>
            <h1><img class="site-logo" src="/assets/logo-web.png" width="512" height="501" alt="Shaley Gardens"></h1>
            <p class="tagline">Your friendly garden helper for Ocala and Central Florida.</p>
            <nav class="nav" aria-label="Site">
                <a href="/">Chat</a>
                <a href="/calendar.html">Planting calendar</a>
                <a href="/guides">Guides</a>
                <a href="/newsletters" aria-current="page">Newsletters</a>
                <a href="/freeze.html">Freeze protection</a>
                <a href="/lawns.html">Sandy soil lawns</a>
                <a href="/fall-vegetables.html">Fall vegetables</a>
                <a href="/calendar.html#weather">Hurricane tips</a>
                <a href="/privacy.html">Privacy</a>
            </nav>
        </header>
${main}
${SIGNUP}
        <footer class="site-footer">
            <p>Contact: <a href="mailto:hello@shaleygardens.com">hello@shaleygardens.com</a></p>
            <p><a href="/">Back to chat</a></p>
        </footer>
    </div>
    <script src="/js/signup.js"></script>
</body>
</html>
`;
}

function renderArchivePage(issues) {
  const items = issues.map((issue) => {
    const label = issue.label ? `\n                        <small>${escapeHtml(issue.label)}</small>` : '';
    return `                <li>
                    <a href="/newsletters/${escapeHtml(issue.slug)}">
                        ${escapeHtml(issue.title)}${label}
                    </a>
                </li>`;
  });
  const list = items.length
    ? `            <ul class="download-list">\n${items.join('\n')}\n            </ul>`
    : '            <p>No issues have been sent yet. When a note goes out, it will be listed here.</p>';
  const main = `        <article class="guide">
            <h2>Newsletters</h2>
            <p>Notes that have already been sent for gardeners in Ocala, Marion County, and The Villages. The newest issue is first.</p>
${list}
        </article>`;
  return pageShell({
    title: 'Newsletters',
    description: 'Newsletter issues already sent by Shaley Gardens for Ocala, Marion County, and The Villages.',
    canonicalPath: '/newsletters',
    main,
  });
}

function renderIssuePage(issue) {
  const date = issue.label ? `            <p class="eyebrow">${escapeHtml(issue.label)}</p>\n` : '';
  const main = `        <article class="guide newsletter-issue">
${date}            <h2>${escapeHtml(issue.title)}</h2>
${renderSiteBody(issue.blocks)}
            <p><a href="/newsletters">All newsletters</a></p>
        </article>`;
  return pageShell({
    title: issue.title,
    description: issue.description,
    canonicalPath: `/newsletters/${issue.slug}`,
    main,
  });
}

function publishNewsletterSite({ newsletterDir, outDir }) {
  const issues = listPublishedNewsletters(newsletterDir);
  const dest = path.resolve(outDir);
  fs.mkdirSync(dest, { recursive: true });
  const keep = new Set(issues.map((issue) => issue.slug));
  for (const entry of fs.readdirSync(dest)) {
    if (entry === 'index.html') continue;
    const full = path.join(dest, entry);
    let stat;
    try {
      stat = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (!stat.isDirectory() || keep.has(entry)) continue;
    fs.rmSync(full, { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(dest, 'index.html'), renderArchivePage(issues));
  for (const issue of issues) {
    if (!safeSlug(issue.slug)) continue;
    const dir = path.resolve(dest, issue.slug);
    if (!dir.startsWith(`${dest}${path.sep}`)) continue;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), renderIssuePage(issue));
  }
  return issues;
}

module.exports = {
  SIGNUP,
  listPublishedNewsletters,
  renderArchivePage,
  renderIssuePage,
  publishNewsletterSite,
};
