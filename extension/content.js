// Summit Chrome Extension — content.js v3.3
// Pure reader content script. Responds to `extractJob` with a "reader
// payload" containing everything the browser can see on the page:
//   { url, html, text, jsonLd, title, meta }
// The server runs the unified extractor against this payload; the extension
// does no semantic extraction of its own.
//
// On jobsummit.app specifically, this script also acts as a bridge: the webapp
// cannot call chrome.runtime directly, so it posts window messages which we
// relay to background.js and post the response back.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action !== 'extractJob') return;

  // Strip <script>, <style>, <svg>, and HTML comments from the HTML we
  // send. This is pre-wire content cleaning, not semantic extraction —
  // scripts/styles/SVG can account for 60-80% of a typical page and carry
  // zero job-posting signal. Keeping them would inflate the POST without
  // any extraction benefit. Inline attributes, text nodes, and all
  // structure (divs, data-* attrs, JSON-LD blocks, <bdi>) are preserved.
  const rawHtml = document.documentElement.outerHTML;
  const html = rawHtml
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // Extract JSON-LD script contents BEFORE stripping — we want these preserved
  // as structured data even though we removed <script> tags from the html blob.
  const jsonLd = [...document.querySelectorAll('script[type="application/ld+json"]')]
    .map(s => s.textContent || '')
    .filter(s => s.trim().length > 0);

  // Text: preserve paragraph structure. innerText inserts newlines between
  // block elements naturally (unlike textContent), so keeping newlines gives
  // the description tab something to split into paragraphs. We only tidy
  // horizontal whitespace (spaces + tabs) and cap runs of 3+ newlines to 2.
  //
  // v1.20.2: was `\s+ → ' '` which collapsed everything into one giant line,
  // making the description tab render as an unreadable wall.
  const text = document.body.innerText
    .replace(/[ \t\f\v]+/g, ' ')         // collapse horizontal runs
    .replace(/\n[ \t]+/g, '\n')          // trim per-line leading space
    .replace(/[ \t]+\n/g, '\n')          // trim per-line trailing space
    .replace(/\n{3,}/g, '\n\n')          // cap blank runs
    .trim();

  // Meta tags — OpenGraph + description. Often accurate when JSON-LD is absent.
  const metaFrom = (sel) => {
    const el = document.querySelector(sel);
    return el ? (el.getAttribute('content') || '').trim() : '';
  };
  const meta = {
    'og:title':       metaFrom('meta[property="og:title"]'),
    'og:description': metaFrom('meta[property="og:description"]'),
    'og:site_name':   metaFrom('meta[property="og:site_name"]'),
    'description':    metaFrom('meta[name="description"]'),
  };

  sendResponse({
    url:    location.href,
    html,
    text,
    jsonLd,
    title:  document.title,
    meta,
  });
  return true;  // keep message channel open for async sendResponse
});

// ──────────────────────────────────────────────────────────────────────────────
// BRIDGE — only active on jobsummit.app
// Webapp can't use chrome.runtime directly. We relay window.postMessage → background.
// ──────────────────────────────────────────────────────────────────────────────
(function initBridge() {
  const host = location.hostname;
  const isAppOrigin = host === 'jobsummit.app' || host === 'localhost' || host === '127.0.0.1';
  if (!isAppOrigin) return;

  // ── Session sync (webapp → extension) ───────────────────────────────────
  // When the user signs in on jobsummit.app, their token lives in
  // localStorage as `applied_token`. The extension is a separate process
  // with its own chrome.storage.local; without sync, the user has to log
  // into the extension separately. Here we snapshot on every page load
  // and listen for cross-tab storage events so the extension tracks the
  // website's session automatically. Signs out cascade too — clearing the
  // token in the site triggers a clear in the extension.
  //
  // One-way by design (site → extension). The reverse (extension →
  // website) would need conflict resolution when the two diverge, and
  // doesn't solve registration (new users always sign up via the site).
  const pushSession = () => {
    try {
      const stored = localStorage.getItem('applied_token');
      const username = localStorage.getItem('applied_user');
      chrome.runtime.sendMessage({
        action: 'syncSession',
        token: stored || null,
        username: username || null,
      });
    } catch (e) { /* extension may not be reachable; harmless */ }
  };
  // Push once on initial injection. If the user reloads jobsummit.app, the
  // extension gets a fresh copy of the token.
  pushSession();
  // Storage events fire in OTHER tabs when the source tab writes to
  // localStorage. So a login/logout in tab A will sync tab B's extension
  // state. The source tab's own write doesn't emit this event — which is
  // why pushSession() runs again on page load there.
  window.addEventListener('storage', (e) => {
    if (e.key === 'applied_token' || e.key === 'applied_user' || e.key === null) {
      pushSession();
    }
  });

  // Announce ourselves so the webapp knows the extension is installed and reachable
  const announce = () => window.postMessage(
    { type: 'summit-ext-ready', version: chrome.runtime.getManifest().version },
    location.origin
  );
  announce();
  // Also respond to explicit pings (covers late-loading webapp scripts)
  // and re-announce if the webapp asks us to.

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const msg = ev.data;
    if (!msg || typeof msg !== 'object') return;

    // Webapp-initiated session sync trigger. The webapp posts this after
    // login/logout so the extension picks up the change immediately
    // (otherwise, in the source tab, we'd wait until next page load —
    // the `storage` event only fires in OTHER tabs).
    if (msg.type === 'summit-session-changed') {
      pushSession();
      return;
    }

    if (msg.type !== 'summit-bridge') return;
    const { nonce, action, url } = msg;
    if (!nonce) return;

    if (action === 'ping') {
      window.postMessage({ type: 'summit-bridge-response', nonce, ok: true, version: chrome.runtime.getManifest().version }, location.origin);
      return;
    }

    if (action === 'fetchPosting' && typeof url === 'string') {
      try {
        chrome.runtime.sendMessage({ action: 'fetchPosting', url }, (resp) => {
          if (chrome.runtime.lastError) {
            window.postMessage({ type: 'summit-bridge-response', nonce, ok: false, error: chrome.runtime.lastError.message || 'runtime-error' }, location.origin);
            return;
          }
          window.postMessage({ type: 'summit-bridge-response', nonce, ...(resp || { ok: false, error: 'no-response' }) }, location.origin);
        });
      } catch (e) {
        window.postMessage({ type: 'summit-bridge-response', nonce, ok: false, error: String(e?.message || e) }, location.origin);
      }
    }
  });
})();
