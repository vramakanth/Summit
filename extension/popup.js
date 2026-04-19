// Summit Chrome Extension — popup.js v2.3
const $ = id => document.getElementById(id);
const TRACKER_URL = 'https://jobsummit.app';

let token = '', currentTabUrl = '', currentTab = null;

// v1.19.14: pageData holds the structured extraction from content.js
// (fields, bodyText, salary, url). Previously declared as a `let` inside
// startParsing, which meant addJob's reference to pageData.fields.reqId
// threw a ReferenceError — breaking the Add button on ALL sites, not
// just ones where reqId was present. Must stay module-scoped so the
// submit path can read it.
let pageData = null;

// ── Helpers ───────────────────────────────────────────────────────────────────
function showStatus(el, type, msg) {
  el.className = 'status show ' + type;
  el.textContent = msg;
}
function hideStatus(el) { el.className = 'status'; }

function setProgress(pct, label) {
  $('parse-bar').classList.add('active');
  $('parse-bar-fill').style.width = pct + '%';
  if (label) $('parse-inline').textContent = label;
}
function clearProgress() {
  $('parse-bar').classList.remove('active');
  $('parse-bar-fill').style.width = '0%';
  $('parse-inline').textContent = '';
}

function setBadge(fieldId, label) {
  const b = $(fieldId + '-badge');
  if (b && label) { b.textContent = label; b.style.display = 'inline-block'; }
}

function fillField(id, val, badge) {
  if (val && typeof val === 'string' && val.trim()) {
    $(id).value = val.trim();
    if (badge) setBadge(id.replace('job-',''), badge);
    return true;
  }
  return false;
}

// ── INIT ──────────────────────────────────────────────────────────────────────
async function init() {
  // ── MV3 event wiring ────────────────────────────────────────────────────
  // MV3's default extension CSP blocks inline event handlers in popup HTML
  // (onclick=, onkeydown=). If the popup relies on them, nothing happens when
  // the user clicks — including, critically, the Sign in button. We wire
  // every handler here with addEventListener so it works under strict CSP.
  $('login-btn').addEventListener('click', doLogin);
  $('password').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  $('username').addEventListener('keydown', e => { if (e.key === 'Enter') $('password').focus(); });
  $('add-btn').addEventListener('click', addJob);
  $('open-tracker-btn').addEventListener('click', openTracker);
  $('sign-out-btn').addEventListener('click', signOut);

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tabs[0];
  currentTabUrl = currentTab?.url || '';

  // Show URL chip
  const urlDisplay = currentTabUrl.replace(/^https?:\/\/(www\.)?/, '').slice(0, 55);
  $('detected-url').textContent = urlDisplay || 'No URL';

  // Show favicon
  if (currentTab?.favIconUrl) {
    $('favicon').src = currentTab.favIconUrl;
    $('favicon').style.display = 'block';
  }

  // Check auth
  const stored = await chrome.storage.local.get(['token', 'username']);
  if (stored.token) {
    token = stored.token;
    showMainView(stored.username);
    startParsing();
  } else {
    $('login-view').style.display = 'block';
    $('header-sub').textContent = 'Sign in to your account';
  }
}

// ── AUTH ──────────────────────────────────────────────────────────────────────
async function doLogin() {
  const user = $('username').value.trim();
  const pass = $('password').value;
  const btn = $('login-btn');
  if (!user || !pass) { showStatus($('login-status'), 'error', 'Fill in all fields'); return; }

  btn.disabled = true;
  btn.textContent = 'Signing in...';
  // try/finally so the button is ALWAYS re-enabled. Previously an early
  // return inside the try on a 401 skipped the reset lines — leaving the
  // button stuck on "Signing in..." forever, making the 11px error message
  // below easy to miss and giving the impression "nothing happened".
  try {
    const res = await fetch(TRACKER_URL + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password: pass }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // 401 is the overwhelming common case. Show plain English rather than
      // the server's raw "Invalid username or password" which is equivalent
      // but slightly less friendly. Fall through to data.error for other
      // codes (429 rate-limit → "rate_limited detail: ...", etc).
      const msg = res.status === 401
        ? 'Incorrect username or password'
        : (data.error || data.detail || `Login failed (${res.status})`);
      showStatus($('login-status'), 'error', msg);
      return;
    }
    token = data.token;
    await chrome.storage.local.set({ token: data.token, username: user });
    showMainView(user);
    startParsing();
  } catch(e) {
    showStatus($('login-status'), 'error', 'Cannot connect to Summit');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
}

function showMainView(username) {
  $('login-view').style.display = 'none';
  $('main-view').style.display = 'block';
  $('header-sub').textContent = username ? `Signed in as ${username}` : 'Job Tracker';
}

// ── SMART PARSING — content-script-first, server as fallback ────────────────
// v2.2: flipped from server-first to page-first. Rationale:
//
// On bot-gated sites (Workable, Apple, LinkedIn) the server's /api/parse-job
// gets a bot-block shell with no useful data. The user's browser — which
// IS logged in, DID solve the bot challenge, IS seeing the real content —
// has the real JSON-LD in the page. Asking that first is the right default.
//
// Three possible paths:
//  (A) Page has JSON-LD fields → use them, skip server entirely. Zero
//      network to our backend, instant fill. Covers ~70% of postings.
//  (B) Page has text but no structured fields → send text to /api/extract-fields
//      for AI extraction. Skip /api/parse-job — we already have the rendered
//      content, no need for server to re-render.
//  (C) Page gave us essentially nothing (content script blocked, short body)
//      → fall back to /api/parse-job server-side. This catches the case
//      where the browser navigated to a redirect / interstitial that the
//      server can fetch directly.
async function startParsing() {
  if (!currentTabUrl || currentTabUrl.startsWith('chrome://') || currentTabUrl.startsWith('chrome-extension://')) {
    $('parse-inline').textContent = '⚠ Browser page';
    return;
  }

  setProgress(15, 'Reading page...');

  // Ask content script for everything it can see. Writes to the
  // module-scoped `pageData` so addJob can read reqId on submit.
  pageData = null;
  try {
    pageData = await new Promise((resolve) => {
      chrome.tabs.sendMessage(currentTab.id, { action: 'extractJob' }, resp => {
        resolve(chrome.runtime.lastError ? null : resp);
      });
    });
  } catch {}

  const hasPageFields = pageData?.fields && pageData.fields.title && pageData.fields.company;

  // ── Path A: structured fields from page JSON-LD ────────────────────────────
  if (hasPageFields) {
    setProgress(60, 'Found structured data...');
    applyFields(pageData.fields, 'page');
    // If the page's JSON-LD was missing salary but content.js recovered one
    // from DOM regex, apply that too.
    if (!pageData.fields.salary && pageData.salary) {
      applyFields({ salary: pageData.salary }, 'page');
    }
    setProgress(100, '✓');
    setTimeout(clearProgress, 1200);
    return;
  }

  // ── Path B: text from page → AI extract ────────────────────────────────────
  if (pageData?.bodyText && pageData.bodyText.length > 300) {
    setProgress(50, 'Extracting with AI...');
    try {
      const aiRes = await fetch(TRACKER_URL + '/api/extract-fields', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ url: currentTabUrl, text: pageData.bodyText.slice(0, 5000) }),
      });
      if (aiRes.ok) {
        const aiFields = await aiRes.json();
        if (aiFields && (aiFields.title || aiFields.company)) {
          applyFields(aiFields, 'ai');
          // Apply any salary the content script recovered but AI missed
          if (!aiFields.salary && pageData.salary) applyFields({ salary: pageData.salary }, 'page');
          setProgress(100, '✓');
          setTimeout(clearProgress, 1200);
          return;
        }
      }
    } catch {}
  }

  // ── Path C: fall back to server-side parse ─────────────────────────────────
  // Content script came up empty (blocked origin, interstitial, very short
  // body). Let the server try — sometimes direct-fetch works where the
  // browser ran into a client-side redirect or auth wall.
  setProgress(40, 'Parsing server-side...');
  try {
    const parseRes = await fetch(TRACKER_URL + '/api/parse-job', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ url: currentTabUrl }),
    });
    if (parseRes.ok) {
      const parsed = await parseRes.json();
      if (parsed.fields) {
        applyFields(parsed.fields, parsed._ats || 'api');
        setProgress(100, '✓');
        setTimeout(clearProgress, 1200);
        return;
      }
      // Server returned text — last chance via AI
      if (parsed.text && parsed.text.length > 100) {
        setProgress(70, 'Extracting with AI...');
        try {
          const aiRes = await fetch(TRACKER_URL + '/api/extract-fields', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
            body: JSON.stringify({ url: currentTabUrl, text: parsed.text.slice(0, 5000) }),
          });
          if (aiRes.ok) {
            const aiFields = await aiRes.json();
            if (aiFields) applyFields(aiFields, 'ai');
          }
        } catch {}
      }
    }
  } catch {}

  // Whatever we got, show a checkmark — empty fields prompt the user to fill
  // in manually, no scary error. Add button will refuse if title/company
  // still blank.
  setProgress(100, '✓');
  setTimeout(clearProgress, 1000);
}

function applyFields(fields, source) {
  if (!fields) return;
  const badge = source === 'ai' ? 'ai' : source === 'page' ? 'page' : source;
  // Only overwrite if field is currently empty OR new value is better
  const overwrite = (id, val) => {
    if (val && typeof val === 'string' && val.trim()) {
      if (!$(id).value || source === 'ai') {
        fillField(id, val, badge);
      }
    }
  };
  overwrite('job-title',   fields.title);
  overwrite('job-company', fields.company);
  overwrite('job-location', fields.location);
  overwrite('job-salary',  fields.salary);
  if (fields.workType && !$('job-worktype').value) {
    $('job-worktype').value = fields.workType;
  }
  if (fields.remote && !$('job-worktype').value) {
    $('job-worktype').value = 'Remote';
  }
}

// ── ADD JOB ───────────────────────────────────────────────────────────────────
async function addJob() {
  const title   = $('job-title').value.trim();
  const company = $('job-company').value.trim();
  if (!title || !company) {
    showStatus($('add-status'), 'error', 'Title and company are required');
    return;
  }

  $('add-btn').disabled = true;
  $('add-btn').textContent = 'Adding...';
  hideStatus($('add-status'));

  try {
    // v2.4.0: POST to the webapp's inbox endpoint. The extension can't
    // encrypt the jobs blob directly (dataKey lives only in the webapp's
    // memory, derived from the user's password). The webapp polls/drains
    // this inbox and merges entries into the encrypted `jobs` store.
    //
    // v2.5.0 adds reqId + reqIdLabel from the content script's structured
    // field extraction. These are the primary dedupe signal on the webapp side.
    const body = {
      title, company,
      url:      currentTabUrl,
      location: $('job-location').value.trim(),
      workType: $('job-worktype').value,
      salary:   $('job-salary').value.trim(),
    };
    if (pageData?.fields?.reqId)      body.reqId      = pageData.fields.reqId;
    if (pageData?.fields?.reqIdLabel) body.reqIdLabel = pageData.fields.reqIdLabel;
    const res = await fetch(TRACKER_URL + '/api/jobs/inbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(body),
    });
    if (res.status === 401) { await signOut(); return; }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || ('HTTP ' + res.status));
    }

    showStatus($('add-status'), 'success', `\u2713 "${title}" added to Summit!`);
    $('add-btn').textContent = '\u2713 Added!';
    setTimeout(() => {
      $('add-btn').disabled = false;
      $('add-btn').textContent = '+ Add to Summit';
    }, 3000);

  } catch(e) {
    showStatus($('add-status'), 'error', 'Error: ' + e.message);
    $('add-btn').disabled = false;
    $('add-btn').textContent = '+ Add to Summit';
  }
}

function openTracker() { chrome.tabs.create({ url: TRACKER_URL }); }

async function signOut() {
  await chrome.storage.local.clear();
  token = '';
  $('main-view').style.display = 'none';
  $('login-view').style.display = 'block';
  $('header-sub').textContent = 'Sign in to your account';
}

document.addEventListener('DOMContentLoaded', init);
