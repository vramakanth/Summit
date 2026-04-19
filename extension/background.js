// Summit Chrome Extension — background.js
//
// Acts as the bridge between jobsummit.app and chrome.tabs — regular web pages
// cannot call chrome.tabs.create directly, but a background service worker can.
// The webapp sends messages here via chrome.runtime.sendMessage(EXTENSION_ID, …)
// thanks to the externally_connectable key in the manifest.
//
// Protocol: { action: 'fetchPosting', url: string } → { ok, bodyText, salary?, error? }

const FETCH_TIMEOUT_MS = 25_000;
const POLL_INTERVAL_MS = 500;
const MAX_POLLS = Math.floor(FETCH_TIMEOUT_MS / POLL_INTERVAL_MS);

// ── Webapp → extension bridge ───────────────────────────────────────────────
// Two ways the webapp's fetch-posting request can arrive:
//   1. Internal:  webapp → content.js (window.postMessage bridge) → chrome.runtime.sendMessage → onMessage
//   2. External:  webapp → chrome.runtime.sendMessage(EXTENSION_ID, …) → onMessageExternal
// Both paths converge on the same handler so the two code paths stay in sync.

function handleRequest(msg, sendResponse) {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.action === 'ping') {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
    return false;
  }
  if (msg.action === 'syncSession') {
    // Webapp → extension session sync. Content.js pushes the current
    // `applied_token` + `applied_user` from jobsummit.app's localStorage
    // whenever the site loads or its localStorage changes. We mirror
    // that state into chrome.storage.local so the extension popup can
    // skip its login view when the user is already signed in on the
    // site. A null token means the user signed out — we clear.
    const { token, username } = msg;
    if (token) {
      chrome.storage.local.set({ token, username: username || '' }, () => {
        sendResponse({ ok: true, synced: 'login' });
      });
    } else {
      chrome.storage.local.remove(['token', 'username'], () => {
        sendResponse({ ok: true, synced: 'logout' });
      });
    }
    return true; // async
  }
  if (msg.action === 'fetchPosting' && typeof msg.url === 'string') {
    fetchPostingInBackgroundTab(msg.url)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true; // async — keep channel open
  }
  return false;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => handleRequest(msg, sendResponse));
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => handleRequest(msg, sendResponse));

// ── Open the URL in a hidden tab, wait for it to load, scrape via content.js ─
async function fetchPostingInBackgroundTab(url) {
  // Basic sanity on the URL — only http/https, no javascript: or file: tricks
  let parsed;
  try { parsed = new URL(url); } catch { return { ok: false, error: 'invalid-url' }; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, error: 'unsupported-protocol' };
  }

  // Open the tab in the background so the user isn't yanked out of the app
  const tab = await chrome.tabs.create({ url, active: false });
  if (!tab || !tab.id) return { ok: false, error: 'tab-create-failed' };

  try {
    // Poll until tab reaches 'complete'. Real sites run JS and redirect; we wait.
    for (let i = 0; i < MAX_POLLS; i++) {
      await sleep(POLL_INTERVAL_MS);
      let info;
      try { info = await chrome.tabs.get(tab.id); } catch { return { ok: false, error: 'tab-gone' }; }
      if (info.status === 'complete') break;
    }

    // Give any JS one more beat to finish rendering
    await sleep(800);

    // Ask content.js on that tab for the extracted text
    let resp;
    try {
      resp = await chrome.tabs.sendMessage(tab.id, { action: 'extractJob' });
    } catch (e) {
      // Some sites (chrome:// pages, extension pages, some protected origins) block
      // content script injection. Fall back to executeScript to at least grab body text.
      try {
        const [{ result } = {}] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => ({
            bodyText: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 6000),
            url: location.href,
          }),
        });
        resp = result;
      } catch (e2) {
        return { ok: false, error: 'extract-failed:' + (e2?.message || e?.message || 'unknown') };
      }
    }

    const bodyText = resp?.bodyText || '';
    if (!bodyText || bodyText.length < 200) {
      return { ok: false, error: 'empty-or-blocked' };
    }
    return { ok: true, bodyText, salary: resp?.salary || null, finalUrl: resp?.url || url };
  } finally {
    // Always clean up the tab we opened
    try { await chrome.tabs.remove(tab.id); } catch {}
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
