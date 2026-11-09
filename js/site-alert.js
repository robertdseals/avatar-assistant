// Site-wide notice. To take it down immediately, set enabled to false.
// It also hides on its own after showThrough, the last calendar day it
// appears in America/New_York. Change storageKey if a new notice should
// show again for people who dismissed an older one.
(function () {
  const SITE_ALERT = {
    enabled: true,
    showThrough: '2026-11-15',
    storageKey: 'shaley-alert-frost-2026-11',
    text: 'Frost alert: Cold nights ahead for the Ocala area. NOAA forecasts lows near 42°F Friday night (Nov 13) and 41°F Saturday night (Nov 14). Light frost is possible in low spots, so cover tender plants like bananas and tropicals.',
  };

  function nyDateKey(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const value = (type) => {
      const part = parts.find((item) => item.type === type);
      return part ? part.value : '';
    };
    const key = `${value('year')}-${value('month')}-${value('day')}`;
    return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : '';
  }

  function wasDismissed(storage, key) {
    try {
      return storage.getItem(key) === 'dismissed';
    } catch (error) {
      return false;
    }
  }

  function shouldShowAlert(config, now, storage) {
    if (!config || config.enabled !== true) return false;
    if (typeof config.showThrough !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(config.showThrough)) return false;
    if (typeof config.text !== 'string' || !config.text.trim()) return false;
    if (typeof config.storageKey !== 'string' || !config.storageKey) return false;
    const today = nyDateKey(now);
    if (!today || today > config.showThrough) return false;
    if (wasDismissed(storage, config.storageKey)) return false;
    return true;
  }

  function rememberDismissal(storage, key) {
    try {
      storage.setItem(key, 'dismissed');
    } catch (error) {
      // Private browsing can refuse storage. The notice still closes on this page.
    }
  }

  function fillCopy(doc, paragraph, text) {
    const match = /^(Frost alert:)([\s\S]*)$/.exec(text);
    if (!match) {
      paragraph.textContent = text;
      return;
    }
    const label = doc.createElement('strong');
    label.textContent = match[1];
    paragraph.appendChild(label);
    paragraph.appendChild(doc.createTextNode(match[2]));
  }

  function mountSiteAlert(doc, storage, now) {
    if (!shouldShowAlert(SITE_ALERT, now, storage)) return null;
    const page = doc.querySelector('.page');
    const parent = page || doc.body;
    if (!parent || parent.querySelector('.site-alert')) return null;

    const banner = doc.createElement('aside');
    banner.className = 'site-alert';
    banner.setAttribute('role', 'status');

    const copy = doc.createElement('p');
    fillCopy(doc, copy, SITE_ALERT.text);

    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'site-alert-dismiss';
    button.setAttribute('aria-label', 'Dismiss frost alert');
    button.textContent = '\u00d7';
    button.addEventListener('click', () => {
      rememberDismissal(storage, SITE_ALERT.storageKey);
      banner.remove();
    });

    banner.appendChild(copy);
    banner.appendChild(button);
    if (parent.firstChild) parent.insertBefore(banner, parent.firstChild);
    else parent.appendChild(banner);
    return banner;
  }

  function safeStorage() {
    try {
      return window.localStorage;
    } catch (error) {
      return {
        getItem() { return null; },
        setItem() {},
      };
    }
  }

  function boot() {
    try {
      mountSiteAlert(document, safeStorage(), new Date());
    } catch (error) {
      // A notice failure should leave the chat, voice, and signup working.
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      SITE_ALERT,
      nyDateKey,
      shouldShowAlert,
      mountSiteAlert,
    };
    return;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
