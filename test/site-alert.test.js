const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  SITE_ALERT,
  nyDateKey,
  shouldShowAlert,
  mountSiteAlert,
} = require('../js/site-alert');

const APPROVED = 'Frost alert: Cold nights ahead for the Ocala area. NOAA forecasts lows near 42°F Friday night (Nov 13) and 41°F Saturday night (Nov 14). Light frost is possible in low spots, so cover tender plants like bananas and tropicals.';

function memoryStorage(seed) {
  const data = Object.assign({}, seed);
  return {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    setItem(key, value) {
      data[key] = String(value);
    },
  };
}

function element(tag) {
  const node = {
    tagName: tag,
    className: '',
    children: [],
    attrs: {},
    textContent: '',
    parent: null,
    type: '',
    listeners: {},
    setAttribute(name, value) { this.attrs[name] = String(value); },
    appendChild(child) {
      child.parent = this;
      this.children.push(child);
      return child;
    },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    remove() {
      if (!this.parent) return;
      this.parent.children = this.parent.children.filter((child) => child !== this);
      this.parent = null;
    },
    querySelector(selector) {
      const walk = (nodes) => {
        for (const child of nodes) {
          if (selector === '.site-alert' && child.className === 'site-alert') return child;
          const found = walk(child.children || []);
          if (found) return found;
        }
        return null;
      };
      return walk(this.children);
    },
  };
  Object.defineProperty(node, 'firstChild', {
    get() { return this.children[0] || null; },
  });
  node.insertBefore = (child, before) => {
    child.parent = node;
    const index = node.children.indexOf(before);
    if (index < 0) node.children.push(child);
    else node.children.splice(index, 0, child);
    return child;
  };
  return node;
}

function textOf(node) {
  if (!node.children || !node.children.length) return node.textContent || '';
  return node.children.map(textOf).join('');
}

function fakeDocument() {
  const page = element('div');
  page.className = 'page';
  const header = element('header');
  header.className = 'site-header';
  page.appendChild(header);
  return {
    page,
    doc: {
      body: page,
      createElement: element,
      createTextNode(text) {
        return { textContent: String(text), children: [], parent: null };
      },
      querySelector(selector) {
        if (selector === '.page') return page;
        return null;
      },
    },
  };
}

test('the frost notice uses the approved wording and stays on through Sunday', () => {
  assert.equal(SITE_ALERT.enabled, true);
  assert.equal(SITE_ALERT.showThrough, '2026-11-15');
  assert.equal(SITE_ALERT.text, APPROVED);
  assert.equal(nyDateKey(new Date('2026-11-16T04:59:00Z')), '2026-11-15');
  assert.equal(nyDateKey(new Date('2026-11-16T05:00:00Z')), '2026-11-16');

  const open = memoryStorage();
  assert.equal(shouldShowAlert(SITE_ALERT, new Date('2026-11-09T16:00:00Z'), open), true);
  assert.equal(shouldShowAlert(SITE_ALERT, new Date('2026-11-16T04:59:00Z'), open), true);
  assert.equal(shouldShowAlert(SITE_ALERT, new Date('2026-11-16T05:00:00Z'), open), false);
  assert.equal(shouldShowAlert(Object.assign({}, SITE_ALERT, { enabled: false }), new Date('2026-11-13T18:00:00Z'), open), false);
  assert.equal(shouldShowAlert(SITE_ALERT, new Date('2026-11-13T18:00:00Z'), memoryStorage({ [SITE_ALERT.storageKey]: 'dismissed' })), false);
  assert.equal(shouldShowAlert(SITE_ALERT, new Date('not-a-date'), open), false);
});

test('the notice mounts at the top of the page and dismisses without coming back', () => {
  const storage = memoryStorage();
  const { doc, page } = fakeDocument();
  const now = new Date('2026-11-13T18:00:00Z');
  const banner = mountSiteAlert(doc, storage, now);
  assert.equal(page.children[0], banner);
  assert.equal(page.children[1].className, 'site-header');
  assert.equal(textOf(banner.children[0]), APPROVED);
  assert.equal(banner.children[1].attrs['aria-label'], 'Dismiss frost alert');
  assert.equal(banner.children[1].type, 'button');

  banner.children[1].listeners.click();
  assert.equal(page.querySelector('.site-alert'), null);
  assert.equal(storage.getItem(SITE_ALERT.storageKey), 'dismissed');
  assert.equal(mountSiteAlert(doc, storage, now), null);
});

test('a second mount does not stack another banner', () => {
  const { doc, page } = fakeDocument();
  const now = new Date('2026-11-13T18:00:00Z');
  const storage = memoryStorage();
  assert.ok(mountSiteAlert(doc, storage, now));
  assert.equal(mountSiteAlert(doc, storage, now), null);
  assert.equal(page.children.filter((child) => child.className === 'site-alert').length, 1);
});

test('dismiss still closes the notice when storage is blocked', () => {
  const storage = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
  };
  const { doc, page } = fakeDocument();
  const banner = mountSiteAlert(doc, storage, new Date('2026-11-13T18:00:00Z'));
  assert.ok(banner);
  banner.children[1].listeners.click();
  assert.equal(page.querySelector('.site-alert'), null);
});

test('every public page loads the notice once, and the print guide does not', () => {
  const root = path.join(__dirname, '..');
  const pages = [];
  function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      if (name === 'newsletter' || name === 'node_modules' || name === 'test') continue;
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (name.endsWith('.html')) pages.push(full);
    }
  }
  walk(root);
  assert.ok(pages.length >= 8);
  for (const file of pages) {
    const html = fs.readFileSync(file, 'utf8');
    assert.match(html, /class="site-header"/, file);
    assert.equal((html.match(/\/js\/site-alert\.js/g) || []).length, 1, file);
  }
  const guide = fs.readFileSync(path.join(root, 'newsletter/guides/2026-11-planting-guide.html'), 'utf8');
  assert.equal(guide.includes('site-alert'), false);
  assert.match(fs.readFileSync(path.join(root, 'css/garden.css'), 'utf8'), /\.site-alert \{/);
  assert.match(fs.readFileSync(path.join(root, 'css/garden.css'), 'utf8'), /\.site-alert-dismiss \{/);
});
